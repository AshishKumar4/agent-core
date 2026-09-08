import { AgentCoreError, type FacetData } from "@agent-core/core";
import {
    PROVIDER_CAPABILITY_PATH,
    PROVIDER_SESSION_LIMITS,
    ProviderCapability,
    ProviderCapabilityAuthority,
    ProviderCapabilityDirectory,
    ProviderCapabilityScope,
    ProviderCapabilitySession,
    providerSessionClock,
    type CapabilitySocketLike,
    type CapabilityUpgradeResponse,
    type ProviderActorStubLike,
    type ProviderCapabilityAdmission,
    type ProviderCapabilityHandle,
    type ProviderSessionClock,
    type ProviderSessionLimits
} from "../src/index.js";
import { isPlatformObject, isText } from "../src/platform-value.js";
import { expectOperationalFailure, malformedInput } from "./assertions.js";
import { fakeErrors } from "./fakes.js";

/*
 * The provider transport's own decisions — authentication, Binding resolution, per-invoke
 * re-mediation, the session ceilings, disposal and the refusal taxonomy — over a real
 * Cap'n Web session running on a WebSocket pair inside this isolate. Cap'n Web is not
 * stubbed: the framing, the export tables and the error rewriting are the library's own,
 * so what these tests observe is the transport's behavior rather than a restatement of it.
 *
 * What is not here is workerd: the 101 upgrade, `WebSocketPair`, the isolate boundary and
 * the round-trip accounting only a real Durable Object hop can measure stay in
 * test/cloudflare/provider-capability.test.ts.
 */

const CREDENTIAL = "provider-credential";
const BINDING = "gateway";
const SEALED: FacetData = { sealed: "provider-side" };

class LoopbackCloseEvent extends Event {
    public constructor(
        public readonly code: number,
        public readonly reason: string
    ) {
        super("close");
    }
}

interface LoopbackClose {
    readonly code: number | undefined;
    readonly reason: string | undefined;
}

/**
 * One half of a WebSocket pair in this isolate. Delivery is a microtask apart, as a real
 * socket's is, so nothing here observes an answer the peer has not sent yet.
 *
 * The accept discipline is faithful on purpose: workerd refuses every use of a socket it
 * handed back unaccepted, which is the whole reason `ProviderCapabilityScope.open`
 * accepts the caller's half before starting a session on it.
 */
class LoopbackSocket extends EventTarget implements CapabilitySocketLike {
    public binaryType: BinaryType = "blob";
    public readonly bufferedAmount = 0;
    public readonly extensions = "";
    public readonly protocol = "";
    public readonly url = `loopback:${PROVIDER_CAPABILITY_PATH}`;
    public onclose: WebSocket["onclose"] = null;
    public onerror: WebSocket["onerror"] = null;
    public onmessage: WebSocket["onmessage"] = null;
    public onopen: WebSocket["onopen"] = null;
    public readonly CONNECTING = 0 as const;
    public readonly OPEN = 1 as const;
    public readonly CLOSING = 2 as const;
    public readonly CLOSED = 3 as const;
    public readonly closes: LoopbackClose[] = [];
    #peer: LoopbackSocket | undefined;
    #open = true;
    #accepted: boolean;

    public constructor(accepted: boolean) {
        super();
        this.#accepted = accepted;
    }

    public get readyState(): 0 | 1 | 2 | 3 {
        return this.#open ? this.OPEN : this.CLOSED;
    }

    /** Whether the holder accepted this socket, which the upgrade path has to do. */
    public get accepted(): boolean {
        return this.#accepted;
    }

    public accept(): void {
        this.#accepted = true;
    }

    public override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
    ): void {
        if (!this.#accepted) {
            throw new TypeError("WebSocket must be accepted before it is used");
        }
        super.addEventListener(type, listener, options);
    }

    public connect(peer: LoopbackSocket): void {
        this.#peer = peer;
    }

    public send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (!isText(data)) {
            throw new TypeError("The loopback pair carries Cap'n Web's text frames only");
        }
        const peer = this.#peer;
        if (peer === undefined) throw new TypeError("Loopback socket has no peer");
        // A socket whose close handshake has started drops what it is handed, as a real
        // one does.
        if (!this.#open) return;
        queueMicrotask(() => {
            peer.deliver(data);
        });
    }

    public close(code?: number, reason?: string): void {
        this.closes.push({ code, reason });
        if (!this.#open) return;
        this.#open = false;
        const peer = this.#peer;
        queueMicrotask(() => {
            peer?.peerClosed(code ?? 1005, reason ?? "");
        });
    }

    private deliver(data: string): void {
        if (!this.#open) return;
        this.dispatchEvent(new MessageEvent("message", { data }));
    }

    private peerClosed(code: number, reason: string): void {
        if (!this.#open) return;
        this.#open = false;
        this.dispatchEvent(new LoopbackCloseEvent(code, reason));
    }
}

/** A socket whose close refuses, which is what a peer-closed socket answers with. */
class UnclosableSocket extends LoopbackSocket {
    public override close(): void {
        throw new TypeError("WebSocket is already closed");
    }
}

function loopbackPair() {
    const server = new LoopbackSocket(true);
    const client = new LoopbackSocket(false);
    server.connect(client);
    client.connect(server);
    return { server, client };
}

interface HandleCall {
    readonly operation: string;
    readonly input: FacetData;
}

/** One granted Binding, scripted per operation, counting its own disposal. */
class TestHandle implements ProviderCapabilityHandle {
    public readonly calls: HandleCall[] = [];
    public disposals = 0;

    public constructor(
        private readonly answer: (operation: string, input: FacetData) => Promise<FacetData>
    ) {}

    public async invoke(operation: string, input: FacetData): Promise<FacetData> {
        this.calls.push({ operation, input });
        return this.answer(operation, input);
    }

    public [Symbol.dispose](): void {
        this.disposals += 1;
    }
}

/** What one authenticated caller reaches, with `admit` under the test's control. */
class TestAdmission implements ProviderCapabilityAdmission {
    public readonly lookups: string[] = [];
    public readonly admitted: HandleCall[] = [];
    public denial: unknown;
    public expiresAt = Number.POSITIVE_INFINITY;
    readonly #granted = new Map<string, ProviderCapabilityHandle>();

    public grant(name: string, handle: ProviderCapabilityHandle): void {
        this.#granted.set(name, handle);
    }

    public binding(name: string): ProviderCapabilityHandle | undefined {
        this.lookups.push(name);
        return this.#granted.get(name);
    }

    public async admit(operation: string, input: FacetData): Promise<void> {
        this.admitted.push({ operation, input });
        if (this.denial !== undefined) throw this.denial;
    }
}

class TestAuthority extends ProviderCapabilityAuthority {
    public readonly presented: FacetData[] = [];

    public constructor(private readonly admission: ProviderCapabilityAdmission) {
        super();
    }

    public async authenticate(presented: FacetData): Promise<ProviderCapabilityAdmission> {
        this.presented.push(presented);
        if (
            !isPlatformObject(presented) ||
            Array.isArray(presented) ||
            !("credential" in presented) ||
            presented.credential !== CREDENTIAL
        ) {
            throw new AgentCoreError("authority.denied", "Unknown provider credential");
        }
        return this.admission;
    }
}

/** An authority whose answer the test holds, so a dispose can race one authentication. */
class GatedAuthority extends ProviderCapabilityAuthority {
    public constructor(
        private readonly admission: ProviderCapabilityAdmission,
        private readonly gate: Promise<void>
    ) {
        super();
    }

    public async authenticate(): Promise<ProviderCapabilityAdmission> {
        await this.gate;
        return this.admission;
    }
}

/** The session clock, driven by the test rather than by the wall. */
class ManualClock implements ProviderSessionClock {
    public readonly delays: number[] = [];
    #now = 1_000;
    #timers: { readonly at: number; readonly callback: () => void }[] = [];

    public now(): number {
        return this.#now;
    }

    public schedule(callback: () => void, delayMs: number): () => void {
        this.delays.push(delayMs);
        const timer = { at: this.#now + delayMs, callback };
        this.#timers.push(timer);
        return () => {
            this.#timers = this.#timers.filter((candidate) => candidate !== timer);
        };
    }

    /** How many timers are armed, so a cancelled one is observable. */
    public get armed(): number {
        return this.#timers.length;
    }

    public advance(ms: number): void {
        const target = this.#now + ms;
        for (;;) {
            const due = this.#timers
                .filter((timer) => timer.at <= target)
                .sort((left, right) => left.at - right.at);
            const next = due[0];
            if (next === undefined) break;
            this.#now = next.at;
            this.#timers = this.#timers.filter((timer) => timer !== next);
            next.callback();
        }
        this.#now = target;
    }
}

function sealing(): TestHandle {
    return new TestHandle(async (operation, input) => {
        if (operation !== "seal") {
            throw new AgentCoreError("operation.invalid-input", `No operation ${operation}`);
        }
        return { sealed: "provider-side", echoed: input };
    });
}

interface Provider {
    readonly session: ProviderCapabilitySession;
    readonly admission: TestAdmission;
    readonly authority: TestAuthority;
    readonly handle: TestHandle;
    readonly clock: ManualClock;
    readonly server: LoopbackSocket;
    readonly client: LoopbackSocket;
}

function provider(
    limits: ProviderSessionLimits = PROVIDER_SESSION_LIMITS,
    handle: TestHandle = sealing()
): Provider {
    const { server, client } = loopbackPair();
    const admission = new TestAdmission();
    admission.grant(BINDING, handle);
    const authority = new TestAuthority(admission);
    const clock = new ManualClock();
    const session = new ProviderCapabilitySession(server, authority, fakeErrors, limits, clock);
    return { session, admission, authority, handle, clock, server, client };
}

/** A provider whose socket already carries one authenticated caller. */
async function authenticated(
    limits: ProviderSessionLimits = PROVIDER_SESSION_LIMITS,
    handle: TestHandle = sealing()
): Promise<Provider> {
    const built = provider(limits, handle);
    await built.session.authenticate({ credential: CREDENTIAL });
    return built;
}

interface Connected extends Provider {
    readonly scope: ProviderCapabilityScope;
}

/** Both halves of one session: the provider's, and a caller's stub over the pair. */
function connected(limits: ProviderSessionLimits = PROVIDER_SESSION_LIMITS): Connected {
    const built = provider(limits);
    built.client.accept();
    return { ...built, scope: ProviderCapabilityScope.attach(built.client, fakeErrors) };
}

function release(built: Connected): void {
    built.scope[Symbol.dispose]();
    built.session[Symbol.dispose]();
}

/**
 * That the socket under a session is shut. Cap'n Web aborts its own transport when the
 * session holding it is disposed, so one shutdown closes from both halves and the count
 * is not the contract; that it is closed, and stays closed, is.
 */
function expectShut(socket: LoopbackSocket): void {
    expect(socket.readyState).toBe(socket.CLOSED);
    expect(socket.closes.length).toBeGreaterThan(0);
}

function upgrading(response: CapabilityUpgradeResponse) {
    const requests: Request[] = [];
    const stub: ProviderActorStubLike = {
        fetch(request: Request): CapabilityUpgradeResponse {
            requests.push(request);
            return response;
        }
    };
    return { requests, stub };
}

/**
 * The Error one refused call rejected with, so the fields the boundary chose to carry can
 * be read. A call that was not refused is itself the failure.
 */
async function refusal(operation: Promise<unknown>): Promise<Error> {
    try {
        await operation;
    } catch (error) {
        if (error instanceof Error) return error;
        throw new TypeError("A refused call must reject with an Error");
    }
    throw new TypeError("Expected the call to be refused");
}

describe("provider capability transport", () => {
    test(
        "carries an authenticated caller from credential to a provider-side answer",
        { tags: "p1" },
        async () => {
            const built = connected();
            try {
                using capability = built.scope.endpoint
                    .authenticate({ credential: CREDENTIAL })
                    .binding(BINDING);
                const answer = await capability.invoke("seal", { payload: "alpha" });

                expect(answer).toMatchObject({ sealed: "provider-side" });
                // The identity was established once, from what the caller presented in
                // band, and the effect ran only after fresh mediation.
                expect(built.authority.presented).toEqual([{ credential: CREDENTIAL }]);
                expect(built.admission.admitted).toEqual([
                    { operation: "seal", input: { payload: "alpha" } }
                ]);
                expect(built.handle.calls).toEqual([
                    { operation: "seal", input: { payload: "alpha" } }
                ]);
            } finally {
                release(built);
            }
        }
    );

    test(
        "refuses a second authentication on a socket that already earned one",
        { tags: "p0" },
        async () => {
            const built = await authenticated();
            const capability = built.session.capability(BINDING, fakeErrors);
            expect(capability).toBeInstanceOf(ProviderCapability);

            // Trading up, or replaying an older credential onto a socket that already
            // earned a narrower one, is the same move; both end the session.
            await expect(
                built.session.authenticate({ credential: CREDENTIAL })
            ).rejects.toMatchObject({ code: "authority.denied" });
            expect(built.authority.presented).toHaveLength(1);

            // The refusal took the whole session: the lease it had handed out is
            // released and the socket is shut.
            expect(built.handle.disposals).toBe(1);
            expectShut(built.server);
            await expect(
                built.session.authenticate({ credential: CREDENTIAL })
            ).rejects.toMatchObject({ code: "protocol.invalid-state" });
        }
    );

    test(
        "refuses every effect on a socket that has not authenticated",
        { tags: "p0" },
        async () => {
            const built = provider();

            expectOperationalFailure(
                () => built.session.capability(BINDING, fakeErrors),
                "authority.denied"
            );
            await expect(built.session.enter("seal", {})).rejects.toMatchObject({
                code: "authority.denied"
            });
            // Nothing was asked of the authority plane, because there is no identity to
            // ask about yet.
            expect(built.admission.lookups).toEqual([]);
            expect(built.admission.admitted).toEqual([]);
        }
    );

    test(
        "refuses a Binding the admission does not grant, and never enumerates what it holds",
        { tags: "p0" },
        async () => {
            const built = await authenticated();

            const refused = await refusal(
                (async () => built.session.capability("ledger", fakeErrors))()
            );
            expect(refused).toBeInstanceOf(AgentCoreError);
            expect(refused).toMatchObject({ code: "authority.denied" });
            // The refusal names no Binding, granted or not.
            expect(refused.message).toBe("Provider holds no such capability for this caller");

            // An empty name is refused without asking the admission anything, so a
            // caller cannot use the lookup itself as an oracle.
            expectOperationalFailure(
                () => built.session.capability("", fakeErrors),
                "authority.denied"
            );
            expect(built.admission.lookups).toEqual(["ledger"]);

            // A name that is not text reaches the session as the empty name, so the
            // directory a caller holds over RPC cannot smuggle one past `isText`.
            const directory = new ProviderCapabilityDirectory(built.session, fakeErrors);
            expectOperationalFailure(
                () => directory.binding(malformedInput<string, number>(7)),
                "authority.denied"
            );
            expect(built.admission.lookups).toEqual(["ledger"]);
        }
    );

    test("refuses a granted value that is not a capability handle", { tags: "p0" }, async () => {
        const built = await authenticated();
        built.admission.grant(
            "hollow",
            malformedInput<ProviderCapabilityHandle, Record<string, never>>({})
        );

        expectOperationalFailure(
            () => built.session.capability("hollow", fakeErrors),
            "authority.denied"
        );
    });

    test(
        "validates the operation and input a caller sends and the answer a handle returns",
        { tags: "p1" },
        async () => {
            const built = await authenticated();
            const capability = built.session.capability(BINDING, fakeErrors);

            await expect(capability.invoke("", { payload: "alpha" })).rejects.toMatchObject({
                code: "operation.invalid-input"
            });
            await expect(
                capability.invoke(malformedInput<string, number>(7), { payload: "alpha" })
            ).rejects.toMatchObject({ code: "operation.invalid-input" });
            await expect(
                capability.invoke(
                    "seal",
                    malformedInput<FacetData, () => void>(() => undefined)
                )
            ).rejects.toMatchObject({ code: "operation.invalid-input" });

            // A refused argument is refused before mediation, so nothing ran and no call
            // was spent.
            expect(built.admission.admitted).toEqual([]);
            expect(built.handle.calls).toEqual([]);

            const lying = await authenticated(
                PROVIDER_SESSION_LIMITS,
                new TestHandle(async () => malformedInput<FacetData, () => void>(() => undefined))
            );
            await expect(
                lying.session.capability(BINDING, fakeErrors).invoke("seal", {})
            ).rejects.toMatchObject({ code: "operation.invalid-output" });
        }
    );

    test(
        "ends the session when the admission refuses an effect, and hands the refusal back unchanged",
        { tags: "p0" },
        async () => {
            const built = await authenticated();
            const capability = built.session.capability(BINDING, fakeErrors);
            const denial = new AgentCoreError("authority.denied", "Binding generation moved");
            built.admission.denial = denial;

            // The authority plane's own refusal crosses back as itself: there is no
            // second taxonomy here to disagree with the first.
            await expect(capability.invoke("seal", {})).rejects.toBe(denial);
            // Revocation leaves the holder nothing: the lease is released and the socket
            // is shut as the refusal travels.
            expect(built.handle.calls).toEqual([]);
            expect(built.handle.disposals).toBe(1);
            expectShut(built.server);
            await expect(built.session.enter("seal", {})).rejects.toMatchObject({
                code: "protocol.invalid-state"
            });
        }
    );

    test("spends the session's call budget and refuses past it", { tags: "p0" }, async () => {
        const built = await authenticated({ ...PROVIDER_SESSION_LIMITS, maxCalls: 2 });
        const capability = built.session.capability(BINDING, fakeErrors);

        expect(await capability.invoke("seal", { payload: "one" })).toMatchObject({
            sealed: "provider-side"
        });
        expect(await capability.invoke("seal", { payload: "two" })).toMatchObject({
            sealed: "provider-side"
        });
        await expect(capability.invoke("seal", { payload: "three" })).rejects.toMatchObject({
            code: "authority.denied"
        });

        // The budget is the session's, not the capability's: a fresh Binding buys no
        // more calls, because the session itself is already cut.
        expect(built.handle.calls).toHaveLength(2);
        expectShut(built.server);
        expectOperationalFailure(
            () => built.session.capability(BINDING, fakeErrors),
            "protocol.invalid-state"
        );
    });

    test("holds the concurrency ceiling under a pipelined batch", { tags: "p0" }, async () => {
        let arrive = (): void => undefined;
        let finish = (): void => undefined;
        const arrived = new Promise<void>((resolve) => {
            arrive = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const blocking = new TestHandle(async () => {
            arrive();
            await gate;
            return SEALED;
        });
        const built = await authenticated(
            { ...PROVIDER_SESSION_LIMITS, maxConcurrentCalls: 1 },
            blocking
        );
        const capability = built.session.capability(BINDING, fakeErrors);

        // The first call holds the only slot: it is mediated, counted and inside the
        // handle before the second one is issued.
        const first = capability.invoke("seal", { payload: "one" });
        await arrived;
        await expect(capability.invoke("seal", { payload: "two" })).rejects.toMatchObject({
            code: "authority.denied"
        });
        finish();
        await expect(first).resolves.toMatchObject({ sealed: "provider-side" });
        expectShut(built.server);
    });

    test("gives a finished call's slot back exactly once", { tags: "p0" }, async () => {
        const built = await authenticated({
            ...PROVIDER_SESSION_LIMITS,
            maxConcurrentCalls: 1,
            maxCalls: 8
        });

        // The release is what keeps the ceiling honest, and calling it twice must not
        // free a slot the session never spent: an extra slot here would let one more
        // call past the ceiling for the rest of the session.
        const first = await built.session.enter("seal", {});
        first();
        first();
        const second = await built.session.enter("seal", {});
        second();

        const third = await built.session.enter("seal", {});
        await expect(built.session.enter("seal", {})).rejects.toMatchObject({
            code: "authority.denied"
        });
        third();
    });

    test(
        "reclaims an idle session and rearms the deadline only on an admitted call",
        { tags: "p0" },
        async () => {
            const built = await authenticated({ ...PROVIDER_SESSION_LIMITS, idleMs: 100 });
            built.session.capability(BINDING, fakeErrors);
            expect(built.clock.delays).toEqual([100, 100]);
            expect(built.clock.armed).toBe(1);

            // An admitted call moves the deadline forward, so the silence that reclaims
            // a session is silence since the last admitted call rather than since it
            // opened.
            built.clock.advance(60);
            (await built.session.enter("seal", {}))();
            built.clock.advance(60);
            expect(built.server.closes).toEqual([]);
            expect(built.handle.disposals).toBe(0);

            built.clock.advance(100);
            expect(built.handle.disposals).toBe(1);
            expectShut(built.server);
            await expect(built.session.enter("seal", {})).rejects.toMatchObject({
                code: "protocol.invalid-state"
            });
        }
    );

    test(
        "refuses a call once the admission's own deadline passes, whatever the caller does",
        { tags: "p0" },
        async () => {
            const built = provider();
            built.admission.expiresAt = built.clock.now() + 10;
            await built.session.authenticate({ credential: CREDENTIAL });
            built.session.capability(BINDING, fakeErrors);

            // Activity cannot extend it: the deadline is read once when the session
            // opens, and an admitted call in between does not move it.
            built.clock.advance(5);
            (await built.session.enter("seal", {}))();
            built.clock.advance(5);
            await expect(built.session.enter("seal", {})).rejects.toMatchObject({
                code: "authority.denied"
            });
            expect(built.handle.disposals).toBe(1);
            expectShut(built.server);
        }
    );

    test(
        "disposes each lease once, whether the holder or the session releases it",
        { tags: "p1" },
        async () => {
            const built = await authenticated();
            const held = built.session.capability(BINDING, fakeErrors);
            const dropped = built.session.capability(BINDING, fakeErrors);

            dropped[Symbol.dispose]();
            dropped[Symbol.dispose]();
            expect(built.handle.disposals).toBe(1);

            // A capability its holder released is forgotten, so the session's own
            // shutdown disposes only what it still holds.
            built.session[Symbol.dispose]();
            expect(built.handle.disposals).toBe(2);
            // The second shutdown is a no-op: it disposes nothing again and closes
            // nothing again.
            const closes = built.server.closes.length;
            built.session[Symbol.dispose]();
            expect(built.handle.disposals).toBe(2);
            expect(built.server.closes).toHaveLength(closes);
            expectShut(built.server);

            // A released capability performs nothing further for its holder.
            await expect(held.invoke("seal", {})).rejects.toMatchObject({
                code: "authority.denied"
            });
        }
    );

    test("survives a socket whose close refuses", { tags: "p1" }, () => {
        const server = new UnclosableSocket(true);
        const client = new LoopbackSocket(false);
        server.connect(client);
        const session = new ProviderCapabilitySession(
            server,
            new TestAuthority(new TestAdmission()),
            fakeErrors,
            PROVIDER_SESSION_LIMITS,
            new ManualClock()
        );

        // A socket the peer already closed is the state disposal asked for, so its
        // refusal is not an error to report.
        expect(() => {
            session[Symbol.dispose]();
        }).not.toThrow();
    });

    test("keeps a provider-side failure's text on the provider's side", { tags: "p1" }, async () => {
        const built = connected();
        built.admission.grant(
            "leaky",
            new TestHandle(async () => {
                throw new Error("signing key sk-live-provider-secret");
            })
        );
        try {
            const directory = await built.scope.endpoint.authenticate({
                credential: CREDENTIAL
            });
            using capability = await directory.binding("leaky");
            const failure = await refusal(capability.invoke("seal", {}));

            // Cap'n Web sends an error's message, its own enumerable properties, its
            // cause and an AggregateError's errors. What crosses here is a code: the
            // provider's text is not in the message, the cause or the frames the caller
            // can read.
            expect(failure).toBeInstanceOf(Error);
            expect(failure).toMatchObject({ code: "invocation.invalid" });
            expect(failure.message).toBe("invocation.invalid");
            expect(failure.cause).toBeUndefined();
            expect(failure.stack ?? "").not.toMatch(/sk-live|signing/iu);
        } finally {
            release(built);
        }
    });

    test(
        "discloses the codes the taxonomy admits without ending a session it did not cut",
        { tags: "p1" },
        async () => {
            const built = connected();
            try {
                const directory = await built.scope.endpoint.authenticate({
                    credential: CREDENTIAL
                });
                const refused = await refusal(
                    Promise.resolve(directory.binding("ledger").invoke("seal", {}))
                );

                // A code inside the disclosed set crosses as itself, so a caller can
                // tell a refusal from a transport fault; the provider's own message
                // still does not travel.
                expect(refused).toMatchObject({ code: "authority.denied" });
                expect(refused.message).toBe("authority.denied");

                // Refusing a Binding is not a cut: the session it was asked on is still
                // the caller's, and a granted Binding on it still works.
                using capability = await directory.binding(BINDING);
                expect(await capability.invoke("seal", {})).toMatchObject({
                    sealed: "provider-side"
                });
            } finally {
                release(built);
            }
        }
    );

    test(
        "opens a session through an Actor stub's upgrade and accepts the socket first",
        { tags: "p1" },
        async () => {
            const { server, client } = loopbackPair();
            const admission = new TestAdmission();
            admission.grant(BINDING, sealing());
            const session = new ProviderCapabilitySession(
                server,
                new TestAuthority(admission),
                fakeErrors,
                PROVIDER_SESSION_LIMITS,
                new ManualClock()
            );
            const upgrade = upgrading({ status: 101, webSocket: client });

            const scope = await ProviderCapabilityScope.open(upgrade.stub, fakeErrors);
            try {
                // The upgrade went to the path the provider answers on, as a WebSocket
                // request, and the caller's half was accepted before anything was sent.
                expect(upgrade.requests).toHaveLength(1);
                expect(new URL(upgrade.requests[0]?.url ?? "https://absent").pathname).toBe(
                    PROVIDER_CAPABILITY_PATH
                );
                expect(upgrade.requests[0]?.headers.get("Upgrade")).toBe("websocket");
                expect(client.accepted).toBe(true);

                using capability = scope.endpoint
                    .authenticate({ credential: CREDENTIAL })
                    .binding(BINDING);
                expect(await capability.invoke("seal", {})).toMatchObject({
                    sealed: "provider-side"
                });
            } finally {
                scope[Symbol.dispose]();
                session[Symbol.dispose]();
            }
        }
    );

    test(
        "refuses a presented credential the transport can carry but Facet data cannot",
        { tags: "p0" },
        async () => {
            const built = connected();
            try {
                // Cap'n Web carries more than Facet data — Dates, Maps, Errors, typed
                // arrays — so the one method an unauthenticated peer can reach validates
                // what it was handed instead of trusting its declared parameter type.
                const refused = await refusal(
                    Promise.resolve(
                        built.scope.endpoint.authenticate(
                            malformedInput<FacetData, Date>(new Date(0))
                        )
                    )
                );
                expect(refused).toMatchObject({ code: "operation.invalid-input" });
                // The authority plane was never consulted, and the refusal is not a cut:
                // a peer that presents nonsense has not earned a closed socket, so a
                // real credential still works on it.
                expect(built.authority.presented).toEqual([]);
                using capability = built.scope.endpoint
                    .authenticate({ credential: CREDENTIAL })
                    .binding(BINDING);
                expect(await capability.invoke("seal", {})).toMatchObject({
                    sealed: "provider-side"
                });
            } finally {
                release(built);
            }
        }
    );

    test(
        "arms no deadline for an authentication that finished after the socket was reclaimed",
        { tags: "p0" },
        async () => {
            const { server, client } = loopbackPair();
            const clock = new ManualClock();
            let admit = (): void => undefined;
            const gate = new Promise<void>((resolve) => {
                admit = resolve;
            });
            const session = new ProviderCapabilitySession(
                server,
                new GatedAuthority(new TestAdmission(), gate),
                fakeErrors,
                PROVIDER_SESSION_LIMITS,
                clock
            );
            expect(client.readyState).toBe(client.OPEN);

            // The idle timer, or a peer dropping its stub, can reclaim a session while
            // the authority plane is still deciding.
            const pending = session.authenticate({ credential: CREDENTIAL });
            session[Symbol.dispose]();
            expect(clock.armed).toBe(0);

            admit();
            await pending;

            // The identity it established arms nothing: a timer on a released session
            // would fire into a disposed Cap'n Web peer, and an authentication that lost
            // this race cannot revive the socket it was for.
            expect(clock.armed).toBe(0);
            expectShut(server);
            await expect(session.enter("seal", {})).rejects.toMatchObject({
                code: "protocol.invalid-state"
            });
        }
    );

    test("refuses to start a session on a socket nobody accepted", { tags: "p1" }, () => {
        const { client } = loopbackPair();

        // Cap'n Web sends its first message as soon as the session starts, so a socket
        // that carries no listeners yet cannot host one.
        expectOperationalFailure(
            () => ProviderCapabilityScope.attach(client, fakeErrors),
            "protocol.invalid-state"
        );
    });

    test("refuses an upgrade the provider Actor did not grant", { tags: "p1" }, async () => {
        const refusing: ProviderActorStubLike = {
            fetch(): never {
                throw new TypeError("Durable Object is overloaded");
            }
        };
        await expect(ProviderCapabilityScope.open(refusing, fakeErrors)).rejects.toMatchObject({
            code: "protocol.invalid-state"
        });

        const plain = upgrading({ status: 400, webSocket: null });
        const rejected = await refusal(ProviderCapabilityScope.open(plain.stub, fakeErrors));
        expect(rejected).toMatchObject({ code: "protocol.invalid-state" });
        // The status the Actor answered with is what tells a routing mistake from a
        // refusal.
        expect(rejected.message).toContain("400");

        const socketless = upgrading({ status: 101, webSocket: null });
        await expect(
            ProviderCapabilityScope.open(socketless.stub, fakeErrors)
        ).rejects.toMatchObject({ code: "protocol.invalid-state" });
    });

    test("releases the endpoint stub and its socket exactly once", { tags: "p1" }, () => {
        const built = connected();
        try {
            built.scope[Symbol.dispose]();
            const closes = built.client.closes.length;
            built.scope[Symbol.dispose]();

            // Dropping the stub alone would leave the provider holding every capability
            // the session handed out, so the socket goes with it — and the second
            // release touches neither again.
            expectShut(built.client);
            expect(built.client.closes).toHaveLength(closes);
        } finally {
            built.session[Symbol.dispose]();
        }
    });

    test("arms the stated default ceilings and clears a cancelled timer", { tags: "p2" }, () => {
        // All four ceilings are the provider's own, not a limit chosen for a different
        // threat model.
        expect(PROVIDER_SESSION_LIMITS).toEqual({
            maxFrameBytes: 128 * 1024,
            maxConcurrentCalls: 8,
            maxCalls: 1024,
            idleMs: 30_000
        });
        const built = provider();
        expect(built.clock.delays).toEqual([PROVIDER_SESSION_LIMITS.idleMs]);
        built.session[Symbol.dispose]();
        expect(built.clock.armed).toBe(0);

        vi.useFakeTimers();
        try {
            const fired: string[] = [];
            const cancelFirst = providerSessionClock.schedule(() => fired.push("first"), 5);
            providerSessionClock.schedule(() => fired.push("second"), 5);
            expect(providerSessionClock.now()).toBe(Date.now());

            cancelFirst();
            vi.advanceTimersByTime(10);
            // A cancelled schedule is what `touch` relies on to move a deadline rather
            // than accumulate one timer per call.
            expect(fired).toEqual(["second"]);
        } finally {
            vi.useRealTimers();
        }
    });
});
