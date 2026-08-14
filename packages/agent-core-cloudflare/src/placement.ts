import type { ActorRef } from "@agent-core/core";
import { actorObjectName, parseActorObjectName } from "./actor-name.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { SqliteApplicationMigration, SynchronousSqlitePort } from "./migration.js";
import {
    locateActorObject,
    type ActorNamespaceLocation,
    type DurableObjectNamespaceLike
} from "./namespace.js";
import { storedRowReader } from "./sqlite.js";
import { isWellFormedUnicode } from "./unicode.js";

const CORRUPT_PLACEMENT = "Stored Actor placement is corrupt";
const READ_PLACEMENT = `SELECT jurisdiction, pinned_at FROM agent_core_actor_placements
    WHERE actor_name = ?`;
const INSERT_PLACEMENT = `INSERT INTO agent_core_actor_placements
    (actor_name, jurisdiction, pinned_at) VALUES (?, ?, ?)`;

/**
 * Installs the placement ledger. It is deliberately absent from the runtime migrations
 * every Actor object applies: the registry belongs to one dedicated object, and an Actor
 * object that constructs its own registry finds no table and fails closed instead of
 * pinning privately.
 */
export function placementRegistryMigration(version: number): SqliteApplicationMigration {
    return Object.freeze({
        version,
        name: "cloudflare-actor-placements",
        statements: Object.freeze([
            `CREATE TABLE agent_core_actor_placements (
                actor_name TEXT PRIMARY KEY,
                jurisdiction TEXT,
                pinned_at INTEGER NOT NULL CHECK (pinned_at >= 0)
            ) STRICT`
        ])
    });
}

export interface PlacementClock {
    now(): number;
}

/**
 * Binds one Actor object name to exactly one physical jurisdiction for its lifetime.
 * `jurisdiction` is `undefined` when the Actor is pinned to the default, unrestricted
 * namespace; that is itself a placement decision and may not be silently overridden.
 */
export class ActorPlacement {
    public constructor(
        public readonly actorName: string,
        public readonly jurisdiction: string | undefined,
        public readonly pinnedAt: number
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
        Object.freeze(this);
    }

    public sameJurisdiction(jurisdiction: string | undefined): boolean {
        return this.jurisdiction === jurisdiction;
    }
}

/**
 * The placement registry seam. `pin` must be atomic across every resolver: a first writer
 * installs the pin, and every later writer observes that same pin — the registry never
 * holds two pins for one Actor name. The seam is asynchronous so a resolver outside the
 * registry's own object can reach it over a Durable Object stub.
 */
export interface PlacementRegistry {
    pin(placement: ActorPlacement): Promise<ActorPlacement>;
    get(actorName: string): Promise<ActorPlacement | undefined>;
}

/**
 * The placement ledger over a Durable Object's private SQLite. Install
 * `placementRegistryMigration` in exactly ONE object and route every resolver to it: the
 * object's input gate serializes the pin transaction, and its storage outlives the isolate,
 * so two isolates racing the same Actor cannot each install a different first pin and
 * address two physically different objects.
 */
export class SqlitePlacementRegistry implements PlacementRegistry {
    private readonly rows = storedRowReader(() =>
        operationalFailure(this.errors, "codec.invalid", CORRUPT_PLACEMENT)
    );

    public constructor(
        private readonly database: SynchronousSqlitePort,
        private readonly errors: CloudflareErrorPort
    ) {}

    public async pin(placement: ActorPlacement): Promise<ActorPlacement> {
        return this.database.transaction(() => {
            const existing = this.read(placement.actorName);
            if (existing !== undefined) return existing;
            this.database.run(INSERT_PLACEMENT, [
                placement.actorName,
                placement.jurisdiction ?? null,
                placement.pinnedAt
            ]);
            return placement;
        });
    }

    public async get(actorName: string): Promise<ActorPlacement | undefined> {
        return this.read(actorName);
    }

    private read(actorName: string): ActorPlacement | undefined {
        const row = this.database.all(READ_PLACEMENT, [actorName])[0];
        if (row === undefined) return undefined;
        const jurisdiction = this.rows.nullableText(row, "jurisdiction");
        const pinnedAt = this.rows.integer(row, "pinned_at");
        try {
            return new ActorPlacement(actorName, jurisdiction ?? undefined, pinnedAt);
        } catch (cause) {
            operationalFailure(this.errors, "codec.invalid", CORRUPT_PLACEMENT, { value: cause });
        }
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
            new ActorPlacement(name, requested, this.#clock.now())
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

function describe(jurisdiction: string | undefined): string {
    return jurisdiction ?? "(default)";
}
