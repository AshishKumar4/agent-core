import {
    AgentCoreError,
    Digest,
    isFacetData,
    isJsonObject,
    jsonDataParser
} from "@agent-core/core";
import type { FacetData } from "@agent-core/core/facets";
import { DurableObject } from "cloudflare:workers";
import {
    PROVIDER_CAPABILITY_PATH,
    ProviderCapabilityAuthority,
    ProviderCapabilitySession,
    type CloudflareErrorPort,
    type ProviderCapabilityAdmission,
    type ProviderCapabilityHandle,
    type ProviderSessionClock,
    type ProviderSessionLimits
} from "../../src/index.js";
import type { TestEnvironment } from "./worker.js";

/**
 * A SPEC §10.2 `provider` Actor: the custody case the mode exists for. The signing key
 * lives in this object and never crosses the boundary — a caller gets a capability that
 * seals with it, and nothing that reads it.
 */
const SIGNING_KEY = "provider-actor-signing-key";

/** The in-band credential this fixture's authority accepts. */
export const GATEWAY_CREDENTIAL = "gateway-holder-credential";

export const GATEWAY_BINDING = "gateway";

/** The epoch a stale-epoch test moves; anything else is the current generation. */
export const STALE_EPOCH_OPERATION = "stale-epoch";

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

const gatewayData = jsonDataParser(
    (message) => new AgentCoreError("operation.invalid-input", message)
);

/**
 * One holder's lease on the gateway. It counts its own use and releases on disposal,
 * which is how the provider observes a caller dropping its stub — §10.2's "revocation
 * drops the stub", from the side that has to act on it.
 */
class GatewayLease implements ProviderCapabilityHandle {
    #open = true;
    #uses = 0;

    public constructor(
        public readonly holder: string,
        private readonly release: (holder: string) => void
    ) {}

    public async invoke(operation: string, input: FacetData): Promise<FacetData> {
        if (!this.#open) {
            throw new AgentCoreError("authority.denied", `Gateway lease ${this.holder} is closed`);
        }
        switch (operation) {
            case "seal": {
                const payload = gatewayData.nonemptyString(
                    gatewayData.object(input, "Seal input")["payload"],
                    "Seal payload"
                );
                this.#uses += 1;
                return {
                    holder: this.holder,
                    sealed: Digest.sha256(new TextEncoder().encode(`${SIGNING_KEY}:${payload}`))
                        .value
                };
            }
            case "uses":
                return { holder: this.holder, uses: this.#uses };
            default:
                throw new AgentCoreError(
                    "operation.missing",
                    `Gateway has no operation ${operation}`
                );
        }
    }

    public [Symbol.dispose](): void {
        if (!this.#open) return;
        this.#open = false;
        this.release(this.holder);
    }
}

/**
 * What one authenticated caller may do, held by the provider for the socket's life. The
 * lease is minted at `binding` time (per holder, so two holders of the same Binding
 * cannot observe each other's use count), while `admit` re-reads the shared epoch before
 * every effect: moving it is how a test simulates the authority plane revoking a
 * resolution mid-session, and the transport must refuse — not run — what it now
 * disagrees with.
 */
class GatewayAdmission implements ProviderCapabilityAdmission {
    readonly #leases = new Set<GatewayLease>();
    readonly #released: string[] = [];
    #epoch = 0;

    public constructor(public readonly holder: string) {}

    /** The holders whose leases were released, for the disposal tests to read. */
    public get released(): readonly string[] {
        return Object.freeze([...this.#released]);
    }

    public readonly expiresAt: number = Number.POSITIVE_INFINITY;

    public binding(name: string): ProviderCapabilityHandle | undefined {
        if (name !== GATEWAY_BINDING) return undefined;
        const lease = new GatewayLease(this.holder, (holder) => {
            this.#leases.delete(lease);
            this.#released.push(holder);
        });
        this.#leases.add(lease);
        return lease;
    }

    /** Moves the shared generation, so every already-minted lease is now stale. */
    public revokeEverything(): void {
        this.#epoch += 1;
    }

    public async admit(operation: string, input: FacetData): Promise<void> {
        if (!isFacetData(input)) return;
        if (operation === STALE_EPOCH_OPERATION) {
            this.revokeEverything();
        }
        if (this.#epoch > 0) {
            throw new AgentCoreError(
                "authority.denied",
                `Gateway epoch moved past ${this.holder}'s resolution`
            );
        }
    }
}

/** The authority this provider Actor trusts: one credential, one admission. */
export class GatewayAuthority extends ProviderCapabilityAuthority {
    readonly #admission: GatewayAdmission;

    public constructor() {
        super();
        this.#admission = new GatewayAdmission("holder-1");
    }

    public get admission(): GatewayAdmission {
        return this.#admission;
    }

    public async authenticate(presented: FacetData): Promise<ProviderCapabilityAdmission> {
        if (!isJsonObject(presented) || presented["credential"] !== GATEWAY_CREDENTIAL) {
            throw new AgentCoreError("authority.denied", "Unknown provider credential");
        }
        return this.#admission;
    }
}

/**
 * A clock the tests can freeze and step. The session's idle deadline and its admission
 * deadline both run on it, so a ceiling test never waits for a wall clock.
 */
export class ManualSessionClock implements ProviderSessionClock {
    #now = 0;
    #timers: { readonly at: number; readonly callback: () => void }[] = [];

    public now(): number {
        return this.#now;
    }

    public schedule(callback: () => void, delayMs: number): () => void {
        const timer = { at: this.#now + delayMs, callback };
        this.#timers.push(timer);
        return () => {
            this.#timers = this.#timers.filter((candidate) => candidate !== timer);
        };
    }

    public advance(ms: number): void {
        const target = this.#now + ms;
        for (;;) {
            const due = this.#timers
                .filter((timer) => timer.at <= target)
                .sort((l, r) => l.at - r.at);
            if (due.length === 0) break;
            // Re-read now() inside each callback: a touch() during a callback reschedules
            // relative to the advanced time, which is the same ordering the platform's
            // timers would give.
            const next = due[0]!;
            this.#now = next.at;
            this.#timers = this.#timers.filter((timer) => timer !== next);
            next.callback();
        }
        this.#now = target;
    }
}

/** The ceiling the tests exercise: one call per session, one concurrent call, no slack. */
export const TEST_SESSION_LIMITS: ProviderSessionLimits = Object.freeze({
    maxFrameBytes: 128 * 1024,
    maxConcurrentCalls: 1,
    maxCalls: 2,
    idleMs: 30_000
});

export class ProviderActorDurableObject extends DurableObject<TestEnvironment> {
    public readonly authority = new GatewayAuthority();
    public readonly clock = new ManualSessionClock();
    /** Sessions this object holds open, so their sockets stay alive past `fetch`. */
    readonly #sessions: Set<ProviderCapabilitySession>;

    public constructor(state: DurableObjectState, environment: TestEnvironment) {
        super(state, environment);
        this.#sessions = new Set();
    }

    /** The holders whose leases this provider released, for the disposal tests. */
    public get releasedHolders(): readonly string[] {
        return this.authority.admission.released;
    }

    public fetch(request: Request): Response {
        const url = new URL(request.url);
        if (url.pathname !== PROVIDER_CAPABILITY_PATH) {
            return new Response("provider-actor", { status: 404 });
        }
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return new Response("This endpoint only accepts WebSocket requests.", { status: 400 });
        }
        // workerd constructors stay at the composition root: the session owns the server
        // half from here on, and a refusal closes it.
        const pair = new WebSocketPair();
        const [server, client] = [pair[0], pair[1]] as const;
        server.accept();
        // The session is retained here: its Cap'n Web half holds the socket and the
        // endpoint target alive for the socket's life, and dropping it is a cut.
        this.#sessions.add(
            new ProviderCapabilitySession(
                server,
                this.authority,
                errors,
                TEST_SESSION_LIMITS,
                this.clock
            )
        );
        return new Response(null, { status: 101, webSocket: client });
    }
}
