import type { ActorRef } from "@agent-core/core";
import { actorObjectName, parseActorObjectName } from "./actor-name.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import {
    locateActorObject,
    type ActorNamespaceLocation,
    type DurableObjectNamespaceLike
} from "./namespace.js";
import { isWellFormedUnicode } from "./unicode.js";

export interface PlacementClock {
    now(): number;
}

/**
 * Binds one Actor object name to exactly one physical jurisdiction for its lifetime.
 * `jurisdiction` is `undefined` when the Actor is pinned to the default, unrestricted
 * namespace; that is itself a placement decision and may not be silently overridden.
 * `epoch` advances only through a fenced migration, never through resolution.
 */
export class ActorPlacement {
    public constructor(
        public readonly actorName: string,
        public readonly jurisdiction: string | undefined,
        public readonly pinnedAt: number,
        public readonly epoch: number
    ) {
        parseActorObjectName(actorName);
        if (
            jurisdiction !== undefined &&
            (jurisdiction.length === 0 || !isWellFormedUnicode(jurisdiction))
        ) {
            throw new TypeError(
                "Actor placement jurisdiction must be non-empty well-formed Unicode"
            );
        }
        if (!Number.isSafeInteger(pinnedAt) || pinnedAt < 0) {
            throw new TypeError("Actor placement pinnedAt must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new TypeError("Actor placement epoch must be a non-negative safe integer");
        }
        Object.freeze(this);
    }

    /** Produces the successor pin a fenced migration installs at the next epoch. */
    public migratedTo(jurisdiction: string | undefined, pinnedAt: number): ActorPlacement {
        return new ActorPlacement(this.actorName, jurisdiction, pinnedAt, this.epoch + 1);
    }

    public sameJurisdiction(jurisdiction: string | undefined): boolean {
        return this.jurisdiction === jurisdiction;
    }
}

/**
 * The placement registry seam. An integrator backs this with a Durable Object or config
 * store; `MemoryPlacementRegistry` is the deterministic reference used by tests. `pin`
 * must be atomic: a first writer installs the pin, and every later writer observes that
 * same pin — the registry never holds two pins for one Actor name.
 */
export interface PlacementRegistry {
    pin(placement: ActorPlacement): Promise<ActorPlacement>;
    get(actorName: string): Promise<ActorPlacement | undefined>;
}

export class MemoryPlacementRegistry implements PlacementRegistry {
    readonly #pins = new Map<string, ActorPlacement>();

    public async pin(placement: ActorPlacement): Promise<ActorPlacement> {
        const existing = this.#pins.get(placement.actorName);
        if (existing !== undefined) return existing;
        this.#pins.set(placement.actorName, placement);
        return placement;
    }

    public async get(actorName: string): Promise<ActorPlacement | undefined> {
        return this.#pins.get(actorName);
    }
}

/**
 * Resolves an `ActorRef` to its Durable Object stub through the pinned jurisdiction.
 * First resolution pins; every later resolution reads the pin. An explicit, conflicting
 * per-call jurisdiction for an already-pinned Actor is rejected — it never resolves to a
 * second physical object. Changing an Actor's jurisdiction is a fenced migration only.
 */
export class PlacementResolver<ObjectId, Stub> {
    readonly #clock: PlacementClock;

    public constructor(
        private readonly registry: PlacementRegistry,
        private readonly errors: CloudflareErrorPort,
        clock: PlacementClock = { now: Date.now }
    ) {
        this.#clock = clock;
    }

    public async resolve(
        namespace: DurableObjectNamespaceLike<ObjectId, Stub>,
        actor: ActorRef,
        location: ActorNamespaceLocation = {}
    ): Promise<Stub> {
        const identity = { kind: actor.kind, id: actor.id };
        const name = actorObjectName(identity);
        const requested = location.namespaceJurisdiction;
        const placement = await this.registry.pin(
            new ActorPlacement(name, requested, this.#clock.now(), 0)
        );
        if (requested !== undefined && !placement.sameJurisdiction(requested)) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                `Actor ${name} is pinned to jurisdiction ${describe(placement.jurisdiction)}; ` +
                    `refusing conflicting request for ${describe(requested)}. ` +
                    "Changing jurisdiction requires a fenced placement migration."
            );
        }
        return locateActorObject(
            namespace,
            identity,
            this.errors,
            placement.jurisdiction === undefined
                ? {}
                : { namespaceJurisdiction: placement.jurisdiction }
        );
    }
}

/**
 * A jurisdiction change for a pinned Actor. Draining and fencing the source object under
 * `sourceLeaseEpoch` is a precondition the executing migration MUST satisfy before it
 * installs the successor pin at the next epoch.
 */
export interface PlacementMigrationRequest {
    readonly actor: ActorRef;
    readonly toJurisdiction: string | undefined;
    readonly sourceLeaseEpoch: number;
}

/**
 * The fenced-migration seam — the single sanctioned way to move a pinned Actor. Full
 * execution (drain, fence under the source lease epoch, then install the successor pin)
 * is beyond the adapter's current scope; it is defined here as a typed contract.
 */
export abstract class PlacementMigration {
    public abstract migrate(request: PlacementMigrationRequest): Promise<ActorPlacement>;
}

/** Honest fail-closed contract: rejects until fenced migration is implemented. */
export class UnimplementedPlacementMigration extends PlacementMigration {
    public constructor(private readonly errors: CloudflareErrorPort) {
        super();
    }

    public async migrate(request: PlacementMigrationRequest): Promise<ActorPlacement> {
        return operationalFailure(
            this.errors,
            "protocol.invalid-state",
            `Fenced placement migration for actor ${request.actor.kind}:${request.actor.id.value} ` +
                "is not implemented"
        );
    }
}

function describe(jurisdiction: string | undefined): string {
    return jurisdiction ?? "(default)";
}
