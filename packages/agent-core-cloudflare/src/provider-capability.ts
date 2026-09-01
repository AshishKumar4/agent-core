import { AgentCoreError, isFacetData, type FacetData } from "@agent-core/core";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import type { CloudflareErrorPort, CloudflareOperationalErrorCode } from "./error.js";
import { operationalFailure } from "./error.js";
import { isPlatformMethod, isPlatformObject, isText } from "./platform-value.js";

/**
 * SPEC §10.2 hosting mode 2: a Facet whose custody demands isolation runs in a separate
 * Actor object, and a caller reaches it over a capability-RPC stub. This module is that
 * transport, on Cap'n Web.
 *
 * The transport owns placement, never policy. It guarantees four things and decides none
 * of them:
 *
 * 1. A socket carries no authority. The only method an unauthenticated peer can reach is
 *    `authenticate`, and every capability descends from what it returns.
 * 2. The identity is server-held. It is established once from what the caller presented
 *    in band and is never re-read from the peer, so a later frame cannot restate who it
 *    is (SPEC §3.4 rule 7).
 * 3. Every effect is re-mediated. `admit` runs before each `invoke`, against the current
 *    Binding generation, lease, deadline and path epochs — not against what was true when
 *    the capability was handed out (SPEC §3.4 rule 8).
 * 4. A refusal ends the session. A denied call disposes every lease this session handed
 *    out and shuts the socket, so a revoked holder keeps nothing.
 *
 * `binding` returns a capability rather than data, so `authenticate(...).binding(...)
 * .invoke(...)` is delivered in one batch: mediation costs no extra round trip.
 */

/** The path a provider Actor answers capability sessions on. */
export const PROVIDER_CAPABILITY_PATH = "/agent-core/provider-capability";

/**
 * One granted Binding, as the provider hands it to one holder. `invoke` is the same call
 * a `dynamic` isolate makes on a passed Binding. Disposal releases whatever the handle
 * holds for its holder — a lease, an open credential — and the transport calls it.
 */
export interface ProviderCapabilityHandle {
    invoke(operation: string, input: FacetData): Promise<FacetData>;
    [Symbol.dispose]?(): void;
}

/**
 * One authenticated caller, held by the provider for the life of one socket. Both members
 * are consulted per call: `binding` decides reach, `admit` decides whether this exact
 * effect is still authorized right now.
 */
export interface ProviderCapabilityAdmission {
    /**
     * The instant this admission stops being valid whatever the caller does. Read once
     * when the session opens, so activity cannot extend it.
     */
    readonly expiresAt: number;
    /** The Bindings this caller may name. Anything else is refused, never enumerated. */
    binding(name: string): ProviderCapabilityHandle | undefined;
    /**
     * Fresh mediation for one effect, before that effect runs. Implementations delegate
     * to the authority plane that already owns this decision — current Binding
     * generation, Turn lease and deadline, Tenant and Scope path epochs, mediated intent
     * — and throw `authority.denied` when any of it has moved. Returning normally admits
     * the call. There is no second policy here to disagree with the first.
     */
    admit(operation: string, input: FacetData): Promise<void>;
}

/**
 * What the provider trusts to turn a presented credential into an admission. The host
 * implements it over its own authority plane; the transport never inspects the credential
 * and never carries a default, so a provider cannot be stood up without one.
 */
export abstract class ProviderCapabilityAuthority {
    public abstract authenticate(presented: FacetData): Promise<ProviderCapabilityAdmission>;
}

/**
 * A session's ceilings. Cap'n Web accepts 32 MiB frames by default and its pipelining
 * lets one frame enqueue many calls, so a provider states all four rather than inheriting
 * a limit chosen for a different threat model.
 */
export interface ProviderSessionLimits {
    /** Largest accepted frame. Cap'n Web rejects a larger one and aborts the session. */
    readonly maxFrameBytes: number;
    /** Calls admitted concurrently, which is the backpressure on a pipelined batch. */
    readonly maxConcurrentCalls: number;
    /** Calls admitted for the whole session. */
    readonly maxCalls: number;
    /** Silence after which the session is reclaimed. Reset only by an admitted call. */
    readonly idleMs: number;
}

export const PROVIDER_SESSION_LIMITS: ProviderSessionLimits = Object.freeze({
    maxFrameBytes: 128 * 1024,
    maxConcurrentCalls: 8,
    maxCalls: 1024,
    idleMs: 30_000
});

/**
 * Time, as a session sees it. `schedule` returns the cancel for what it scheduled, so
 * nothing here holds a platform timer handle, and a test can drive a deadline instead of
 * waiting for one.
 */
export interface ProviderSessionClock {
    now(): number;
    schedule(callback: () => void, delayMs: number): () => void;
}

export const providerSessionClock: ProviderSessionClock = Object.freeze({
    now: () => Date.now(),
    schedule: (callback: () => void, delayMs: number) => {
        const timer = setTimeout(callback, delayMs);
        return () => {
            clearTimeout(timer);
        };
    }
});

/** As much of a WebSocket as this module uses on either side. */
export interface CapabilitySocketLike extends WebSocket {
    accept(): void;
}

/** The upgrade half of a response, which the fetch standard's `Response` does not carry. */
export interface CapabilityUpgradeResponse {
    readonly status: number;
    readonly webSocket: CapabilitySocketLike | null;
}

/** As much of an Actor object stub as opening a capability session uses. */
export interface ProviderActorStubLike {
    fetch(request: Request): CapabilityUpgradeResponse | Promise<CapabilityUpgradeResponse>;
}

/**
 * The codes a caller may read. Everything else — a credential SDK's failure, a decode of
 * a provider-side secret, an unexpected throw — collapses to `invocation.invalid` with no
 * text of its own, because Cap'n Web serializes an error's message, its own enumerable
 * properties, its `cause` and an AggregateError's `errors`, and any of those can carry
 * what this boundary exists to keep on the provider's side.
 */
const DISCLOSED_CODES: Readonly<Record<string, true>> = Object.freeze({
    "authority.denied": true,
    "operation.invalid-input": true,
    "operation.invalid-output": true,
    "protocol.invalid-state": true
});
const UNDISCLOSED_CODE: CloudflareOperationalErrorCode = "invocation.invalid";

export class ProviderCapability extends RpcTarget implements Disposable {
    #handle: ProviderCapabilityHandle | undefined;

    public constructor(
        handle: ProviderCapabilityHandle,
        private readonly session: ProviderCapabilitySession,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
        this.#handle = handle;
    }

    public async invoke(operation: string, input: FacetData): Promise<FacetData> {
        const handle = this.#handle;
        if (handle === undefined) {
            operationalFailure(
                this.errors,
                "authority.denied",
                "Provider capability was released by its holder"
            );
        }
        // Both arguments crossed a trust boundary, so the declared parameter types are
        // the contract this checks rather than a fact it may assume.
        if (!isText(operation) || operation.length === 0) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Provider capability operation must be a nonempty name"
            );
        }
        if (!isFacetData(input)) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Provider capability input must be Facet data"
            );
        }
        // Nothing below runs until this call is admitted against current authority, and a
        // refusal takes the whole session with it rather than only this call.
        const release = await this.session.enter(operation, input);
        try {
            // The stub's declared return type is a remote claim, not proof, so the wire
            // value is still validated at this one seam before it crosses inward.
            const output = await handle.invoke(operation, input);
            if (!isFacetData(output)) {
                operationalFailure(
                    this.errors,
                    "operation.invalid-output",
                    "Provider capability returned no Facet data"
                );
            }
            return output;
        } finally {
            release();
        }
    }

    public [Symbol.dispose](): void {
        const handle = this.#handle;
        if (handle === undefined) return;
        this.#handle = undefined;
        this.session.forget(this);
        handle[Symbol.dispose]?.();
    }
}

/**
 * What an authenticated caller reaches. It is reachable only as the return of
 * `authenticate`, so holding one is itself the proof that authentication happened.
 */
export class ProviderCapabilityDirectory extends RpcTarget {
    public constructor(
        private readonly session: ProviderCapabilitySession,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
    }

    public binding(name: string): ProviderCapability {
        return this.session.capability(isText(name) ? name : "", this.errors);
    }
}

/**
 * The one method an unauthenticated peer can call. It takes the credential in band, as
 * Cap'n Web's own guidance asks, so authority never comes from the connection itself.
 */
class ProviderCapabilityEndpointTarget extends RpcTarget {
    public constructor(
        private readonly session: ProviderCapabilitySession,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
    }

    public async authenticate(presented: FacetData): Promise<ProviderCapabilityDirectory> {
        if (!isFacetData(presented)) {
            operationalFailure(
                this.errors,
                "operation.invalid-input",
                "Presented provider credential must be Facet data"
            );
        }
        await this.session.authenticate(presented);
        return new ProviderCapabilityDirectory(this.session, this.errors);
    }
}

/** The shape a caller's stub sees: authenticate, then everything else descends from it. */
export interface ProviderCapabilityEndpoint {
    authenticate(presented: FacetData): Promise<ProviderCapabilityDirectory>;
}

/**
 * One socket's worth of provider state: the admission bound to it, the leases it handed
 * out, its deadlines and its ceilings.
 *
 * Cap'n Web sessions cannot hibernate, and that is inherent rather than a gap to close: a
 * session's export table holds live `RpcTarget` references in the isolate heap, so an
 * object that hibernated would wake with every capability it had handed out dangling —
 * a socket that looks alive with capabilities that are silently dead. SPEC §10.2 states
 * the same fact from the other side: stubs do not survive hibernation or eviction, and
 * re-resolution is the recovery. The answer is therefore a bounded session, and the bound
 * is enforced by the clock on every call. The idle timer only reclaims the socket sooner;
 * a timer that never fires cannot extend anyone's authority.
 */
export class ProviderCapabilitySession implements Disposable {
    #admission: ProviderCapabilityAdmission | undefined;
    #cancelIdle: (() => void) | undefined;
    #deadline = Number.POSITIVE_INFINITY;
    #inFlight = 0;
    #calls = 0;
    #closed = false;
    readonly #leases = new Set<ProviderCapability>();
    readonly #peer: Disposable;

    /**
     * Starts a provider session on an accepted server socket. The caller builds the
     * socket pair and returns the 101 itself: those are workerd constructors, and keeping
     * them at the composition root is what lets this object hold the server half and shut
     * the session down the moment authority moves.
     */
    public constructor(
        private readonly socket: CapabilitySocketLike,
        private readonly authority: ProviderCapabilityAuthority,
        private readonly errors: CloudflareErrorPort,
        private readonly limits: ProviderSessionLimits = PROVIDER_SESSION_LIMITS,
        private readonly clock: ProviderSessionClock = providerSessionClock
    ) {
        this.#peer = newWebSocketRpcSession(
            socket,
            new ProviderCapabilityEndpointTarget(this, errors),
            { onSendError: disclosedFailure, limits: { maxMessageSize: limits.maxFrameBytes } }
        );
        this.touch();
    }

    /** Binds one authenticated identity to this socket, once and for its whole life. */
    public async authenticate(presented: FacetData): Promise<void> {
        this.requireOpen();
        if (this.#admission !== undefined) {
            // A second authentication would let a caller trade up, or replay an older
            // credential onto a socket that already earned a narrower one.
            this.cut("authority.denied", "Provider capability session is already authenticated");
        }
        const admission = await this.authority.authenticate(presented);
        this.#admission = admission;
        this.#deadline = admission.expiresAt;
        this.touch();
    }

    /** Resolves one granted Binding for the authenticated caller. */
    public capability(name: string, errors: CloudflareErrorPort): ProviderCapability {
        const admission = this.requireAdmitted();
        const granted = name.length === 0 ? undefined : admission.binding(name);
        if (granted === undefined || !isHandle(granted)) {
            operationalFailure(
                this.errors,
                "authority.denied",
                "Provider holds no such capability for this caller"
            );
        }
        const capability = new ProviderCapability(granted, this, errors);
        this.#leases.add(capability);
        return capability;
    }

    /**
     * Admits one effect or ends the session. Returns the release the caller runs when the
     * effect finishes, which is what keeps the concurrency ceiling honest under a
     * pipelined batch.
     */
    public async enter(operation: string, input: FacetData): Promise<() => void> {
        const admission = this.requireAdmitted();
        if (this.clock.now() >= this.#deadline) {
            this.cut("authority.denied", "Provider capability session reached its deadline");
        }
        if (this.#calls >= this.limits.maxCalls) {
            this.cut("authority.denied", "Provider capability session exhausted its call budget");
        }
        if (this.#inFlight >= this.limits.maxConcurrentCalls) {
            this.cut("authority.denied", "Provider capability session exceeded its concurrency");
        }
        try {
            await admission.admit(operation, input);
        } catch (cause) {
            // Revocation, a stale epoch, an expired lease: the holder keeps nothing.
            this.releaseLeases();
            this.shutdown();
            throw cause;
        }
        // A call admitted after the session was cut in another frame of the same batch
        // must not run.
        this.requireOpen();
        this.#calls += 1;
        this.#inFlight += 1;
        this.touch();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.#inFlight -= 1;
        };
    }

    public forget(capability: ProviderCapability): void {
        this.#leases.delete(capability);
    }

    /** Releases every lease and shuts the socket. Idempotent. */
    public [Symbol.dispose](): void {
        if (this.#closed) return;
        this.#closed = true;
        this.releaseLeases();
        this.shutdown();
    }

    private requireOpen(): void {
        if (this.#closed) {
            operationalFailure(this.errors, "protocol.invalid-state", "Provider session is closed");
        }
    }

    private requireAdmitted(): ProviderCapabilityAdmission {
        this.requireOpen();
        const admission = this.#admission;
        if (admission === undefined) {
            operationalFailure(
                this.errors,
                "authority.denied",
                "Provider capability session is not authenticated"
            );
        }
        return admission;
    }

    private cut(code: CloudflareOperationalErrorCode, message: string): never {
        this.releaseLeases();
        this.shutdown();
        operationalFailure(this.errors, code, message);
    }

    private releaseLeases(): void {
        // Disposing a lease calls back into `forget`, so the set is copied first.
        for (const lease of Array.from(this.#leases)) lease[Symbol.dispose]();
        this.#leases.clear();
    }

    /**
     * Disposing the main stub is Cap'n Web's own session shutdown, and it takes the
     * export table with it, so no capability outlives the cut that ended the session.
     */
    private shutdown(): void {
        this.#closed = true;
        this.#cancelIdle?.();
        this.#cancelIdle = undefined;
        this.#peer[Symbol.dispose]();
        closeQuietly(this.socket);
    }

    private touch(): void {
        if (this.#closed) return;
        this.#cancelIdle?.();
        this.#cancelIdle = this.clock.schedule(() => {
            this.releaseLeases();
            this.shutdown();
        }, this.limits.idleMs);
    }
}

/**
 * The caller's half. A session is one Turn step's worth of authority: §3.4 rules 7-8
 * refuse a resolution that outlives its step, and a Cap'n Web stub cannot outlive its
 * socket, so the scope owns both and drops both together.
 */
export class ProviderCapabilityScope implements Disposable {
    #socket: CapabilitySocketLike | undefined;

    private constructor(
        socket: CapabilitySocketLike,
        public readonly endpoint: RpcStub<ProviderCapabilityEndpoint>
    ) {
        this.#socket = socket;
    }

    /**
     * Opens one session against a provider Actor object. The upgrade runs through the
     * stub the caller resolved, so placement stays where it was decided.
     */
    public static async open(
        stub: ProviderActorStubLike,
        errors: CloudflareErrorPort
    ): Promise<ProviderCapabilityScope> {
        let response: CapabilityUpgradeResponse;
        try {
            response = await stub.fetch(
                new Request(`https://agent-core-provider${PROVIDER_CAPABILITY_PATH}`, {
                    headers: { Upgrade: "websocket" }
                })
            );
        } catch (cause) {
            operationalFailure(
                errors,
                "protocol.invalid-state",
                "Provider Actor refused a capability session",
                { value: cause }
            );
        }
        if (response.status !== 101 || response.webSocket === null) {
            operationalFailure(
                errors,
                "protocol.invalid-state",
                `Provider Actor answered a capability session with status ${response.status}`
            );
        }
        // Workers hands the caller's half back unaccepted; nothing may be sent until it
        // is, and Cap'n Web sends its first message as soon as the session starts.
        response.webSocket.accept();
        return ProviderCapabilityScope.attach(response.webSocket, errors);
    }

    /**
     * Starts a session on an accepted socket the caller already holds — a second hop, or
     * a client that is not itself a Worker. `open` is this plus the upgrade.
     */
    public static attach(
        socket: CapabilitySocketLike,
        errors: CloudflareErrorPort
    ): ProviderCapabilityScope {
        let endpoint: RpcStub<ProviderCapabilityEndpoint>;
        try {
            endpoint = newWebSocketRpcSession<ProviderCapabilityEndpoint>(socket);
        } catch (cause) {
            operationalFailure(
                errors,
                "protocol.invalid-state",
                "Provider capability session could not start",
                { value: cause }
            );
        }
        return new ProviderCapabilityScope(socket, endpoint);
    }

    /**
     * Releases the endpoint stub and the socket under it, exactly once. Dropping the stub
     * alone leaves the provider holding every capability the session handed out until its
     * own isolate dies.
     */
    public [Symbol.dispose](): void {
        const socket = this.#socket;
        if (socket === undefined) return;
        this.#socket = undefined;
        this.endpoint[Symbol.dispose]();
        closeQuietly(socket);
    }
}

/**
 * The closed taxonomy that crosses the boundary. The disclosed error carries a code and
 * nothing else: its message is the code, it has no other own property, no `cause` and no
 * stack — Cap'n Web sends a rewritten error's stack when it has one, so this drops it.
 */
function disclosedFailure(error: Error): Error {
    const code =
        error instanceof AgentCoreError && isDisclosed(error.code) ? error.code : UNDISCLOSED_CODE;
    const disclosed = new Error(code);
    disclosed.name = "ProviderCapabilityFailure";
    Object.defineProperty(disclosed, "code", { value: code, enumerable: true });
    // Cap'n Web sends a rewritten error's stack when it has one; defining it away is
    // what stops the provider's frames from crossing.
    Object.defineProperty(disclosed, "stack", { value: undefined, enumerable: false });
    return disclosed;
}

function isDisclosed(code: string): code is CloudflareOperationalErrorCode {
    return DISCLOSED_CODES[code] === true;
}

function isHandle(value: Partial<ProviderCapabilityHandle>): value is ProviderCapabilityHandle {
    return isPlatformObject(value) && isPlatformMethod(value.invoke);
}

function closeQuietly(socket: CapabilitySocketLike): void {
    try {
        socket.close(1000, "capability session released");
    } catch {
        // A socket the peer already closed is the state this asked for.
    }
}
