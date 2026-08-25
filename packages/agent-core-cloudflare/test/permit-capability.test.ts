import { AgentCoreError, ContentRef, Digest } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import { PrincipalId, PrincipalRef, TenantId } from "@agent-core/core/identity";
import {
    CommandEnvelope,
    CommandEnvelopeCodec,
    type CommandCaller
} from "@agent-core/core/protocol";
import type { CloudflareErrorPort, CloudflareOperationalErrorCode } from "../src/error.js";
import {
    MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
    MAXIMUM_KEYED_CALLS,
    TargetBoundCommandAuthenticator,
    TargetBoundCommandTransport,
    TargetBoundTenantAuthority,
    TenantAuthorityPermitSink
} from "../src/permit-capability.js";
import { SQL_BLOB_LIMIT_BYTES } from "../src/sqlite.js";
import { expectOperationalFailure } from "./assertions.js";

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

async function expectAsyncFailure<Result>(
    operation: () => Promise<Result>,
    code: CloudflareOperationalErrorCode
): Promise<void> {
    try {
        await operation();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
        return;
    }
    throw new TypeError(`Expected operational failure ${code}`);
}

const ISSUED_PERMIT = new Uint8Array([10, 20, 30]);
const ISSUED_RECORD = new Uint8Array([40, 50]);
const PROJECTED_EVIDENCE = new Uint8Array([60, 70, 80]);

interface KeyedCall {
    readonly caller: ActorRef;
    readonly payload: Uint8Array;
    readonly key: string;
}

interface LookupCall {
    readonly caller: ActorRef;
    readonly nonce: string;
    readonly digest: string;
}

class RecordingSink extends TenantAuthorityPermitSink {
    public readonly issues: KeyedCall[] = [];
    public readonly lookups: LookupCall[] = [];
    public readonly projections: KeyedCall[] = [];

    public get calls(): number {
        return this.issues.length + this.lookups.length + this.projections.length;
    }

    public async issue(
        caller: ActorRef,
        request: Uint8Array,
        idempotencyKey: string
    ): Promise<Uint8Array> {
        this.issues.push({ caller, payload: request, key: idempotencyKey });
        return ISSUED_PERMIT;
    }

    public async issued(
        caller: ActorRef,
        nonce: string,
        digest: string
    ): Promise<Uint8Array | undefined> {
        this.lookups.push({ caller, nonce, digest });
        return ISSUED_RECORD;
    }

    public async project(
        caller: ActorRef,
        evidence: Uint8Array,
        idempotencyKey: string
    ): Promise<Uint8Array> {
        this.projections.push({ caller, payload: evidence, key: idempotencyKey });
        return PROJECTED_EVIDENCE;
    }
}

const tenantActor = new ActorRef("tenant", new ActorId("authority-tenant"));
const runActor = new ActorRef("run", new ActorId("bound-run"));
const tenant = new TenantId("authority-tenant");

function capabilityFor(sink: RecordingSink): TargetBoundTenantAuthority {
    return new TargetBoundTenantAuthority({ tenantActor, caller: runActor, sink, errors });
}

function envelopeFor(caller: CommandCaller): CommandEnvelope {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const payloadDigest = Digest.sha256(payload);
    return new CommandEnvelope({
        command: "authority.permit.issue",
        caller,
        idempotencyKey: "authenticated-command",
        payload: ContentRef.fromDigest(payloadDigest),
        payloadDigest
    });
}

describe("TargetBoundTenantAuthority construction", () => {
    test("requires a Tenant Actor issuer", { tags: "p0" }, () => {
        expect(
            () =>
                new TargetBoundTenantAuthority({
                    tenantActor: runActor,
                    caller: runActor,
                    sink: new RecordingSink(),
                    errors
                })
        ).toThrow(TypeError);
    });

    /**
     * A Tenant holding a capability minted for itself would be a Tenant speaking as a
     * target, which is the one caller the issuance decision cannot be attributed to.
     */
    test("requires a non-Tenant caller", { tags: "p0" }, () => {
        expect(
            () =>
                new TargetBoundTenantAuthority({
                    tenantActor,
                    caller: tenantActor,
                    sink: new RecordingSink(),
                    errors
                })
        ).toThrow(TypeError);
    });

    test("reports the Actors it was minted between", { tags: "p2" }, () => {
        const capability = capabilityFor(new RecordingSink());

        expect(capability.issuer).toBe(tenantActor);
        expect(capability.caller).toBe(runActor);
    });
});

describe("TargetBoundTenantAuthority issuance", () => {
    /**
     * The holder cannot name a caller, so a request that carries an Actor identity in its
     * own bytes still reaches the Tenant stamped with the Actor the capability was minted
     * for. This is the whole reason no method takes a caller argument.
     */
    test("stamps the minted caller and never one the payload claims", { tags: "p0" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);
        const forged = new ActorRef("run", new ActorId("forged-run"));
        const request = new TextEncoder().encode(JSON.stringify({ caller: forged.id.value }));

        await expect(capability.issuePermit(request, "issue-1")).resolves.toBe(ISSUED_PERMIT);

        expect(sink.issues).toHaveLength(1);
        expect(sink.issues[0]?.caller).toBe(runActor);
        expect(sink.issues[0]?.caller.equals(forged)).toBe(false);
        expect(sink.issues[0]?.key).toBe("issue-1");
        expect(sink.issues[0]?.payload).toEqual(request);
    });

    /**
     * The bytes cross an Actor boundary, so the Tenant's copy must not be a window onto
     * memory the caller still holds.
     */
    test("hands the Tenant a detached copy of the request", { tags: "p0" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);
        const request = new Uint8Array([1, 2, 3]);

        await capability.issuePermit(request, "detached");
        request.fill(9);

        expect(sink.issues[0]?.payload).toEqual(new Uint8Array([1, 2, 3]));
    });

    /**
     * The key is a guard against rebinding, never a cache of the answer. A capability that
     * replayed its own earlier reply would answer an issuance the Tenant never recorded,
     * which is exactly the response-loss case redelivery exists to recover.
     */
    test("forwards a repeat of the same key and bytes again", { tags: "p0" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);

        await capability.issuePermit(new Uint8Array([1, 2, 3]), "replayed");
        await capability.issuePermit(new Uint8Array([1, 2, 3]), "replayed");

        expect(sink.issues).toHaveLength(2);
        expect(sink.issues[1]?.key).toBe("replayed");
    });

    test("refuses a key rebound to different bytes", { tags: "p0" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);
        await capability.issuePermit(new Uint8Array([1, 2, 3]), "rebound");

        await expectAsyncFailure(
            () => capability.issuePermit(new Uint8Array([1, 2, 4]), "rebound"),
            "authority.denied"
        );
        await expectAsyncFailure(
            () => capability.issuePermit(new Uint8Array([1, 2]), "rebound"),
            "authority.denied"
        );
        await expectAsyncFailure(
            () => capability.issuePermit(new Uint8Array([1, 2, 3, 4]), "rebound"),
            "authority.denied"
        );

        expect(sink.issues).toHaveLength(1);
    });

    test("refuses an empty key or an empty payload", { tags: "p1" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);

        await expectAsyncFailure(
            () => capability.issuePermit(new Uint8Array([1]), ""),
            "operation.invalid-input"
        );
        await expectAsyncFailure(
            () => capability.issuePermit(new Uint8Array(), "empty-payload"),
            "operation.invalid-input"
        );

        expect(sink.calls).toBe(0);
    });
});

describe("TargetBoundTenantAuthority lookups and projection", () => {
    test("forwards a lookup under the minted caller", { tags: "p1" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);
        const digest = Digest.sha256(new Uint8Array([7, 8, 9]));

        await expect(capability.issuedPermit("nonce-1", digest.value)).resolves.toBe(ISSUED_RECORD);

        expect(sink.lookups).toHaveLength(1);
        expect(sink.lookups[0]?.caller).toBe(runActor);
        expect(sink.lookups[0]?.nonce).toBe("nonce-1");
        expect(sink.lookups[0]?.digest).toBe(digest.value);
    });

    test("refuses a lookup with an empty nonce or digest", { tags: "p1" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);

        await expectAsyncFailure(
            () => capability.issuedPermit("", "a".repeat(64)),
            "operation.invalid-input"
        );
        await expectAsyncFailure(
            () => capability.issuedPermit("nonce-1", ""),
            "operation.invalid-input"
        );

        expect(sink.calls).toBe(0);
    });

    test("guards a projection key exactly as an issuance key", { tags: "p0" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);

        await expect(
            capability.projectLeaseEvidence(new Uint8Array([1, 2, 3]), "project")
        ).resolves.toBe(PROJECTED_EVIDENCE);
        await capability.projectLeaseEvidence(new Uint8Array([1, 2, 3]), "project");
        await expectAsyncFailure(
            () => capability.projectLeaseEvidence(new Uint8Array([1, 2, 4]), "project"),
            "authority.denied"
        );
        await expectAsyncFailure(
            () => capability.projectLeaseEvidence(new Uint8Array(), "empty"),
            "operation.invalid-input"
        );

        expect(sink.projections).toHaveLength(2);
        expect(sink.projections[0]?.caller).toBe(runActor);
    });

    test("hands the Tenant a detached copy of the evidence", { tags: "p1" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);
        const evidence = new Uint8Array([4, 5, 6]);

        await capability.projectLeaseEvidence(evidence, "detached-evidence");
        evidence.fill(0);

        expect(sink.projections[0]?.payload).toEqual(new Uint8Array([4, 5, 6]));
    });
});

describe("TargetBoundTenantAuthority disposal", () => {
    /**
     * The capability is request-scoped, and disposal is what makes that observable rather
     * than assumed: a handle held past its execution context carries no authority at all.
     */
    test("refuses every call once disposed", { tags: "p0" }, async () => {
        const sink = new RecordingSink();
        const capability = capabilityFor(sink);
        await capability.issuePermit(new Uint8Array([1, 2, 3]), "before-disposal");
        const before = sink.calls;

        capability[Symbol.dispose]();

        await expectAsyncFailure(
            () => capability.issuePermit(new Uint8Array([1, 2, 3]), "after-disposal"),
            "authority.denied"
        );
        await expectAsyncFailure(
            () => capability.issuedPermit("nonce-1", "a".repeat(64)),
            "authority.denied"
        );
        await expectAsyncFailure(
            () => capability.projectLeaseEvidence(new Uint8Array([1]), "after-disposal"),
            "authority.denied"
        );
        expectOperationalFailure(() => capability.transport(), "authority.denied");
        expect(sink.calls).toBe(before);
    });

    test("leaves a fresh capability for the same caller usable", { tags: "p0" }, async () => {
        const sink = new RecordingSink();
        capabilityFor(sink)[Symbol.dispose]();

        await expect(
            capabilityFor(sink).issuePermit(new Uint8Array([1, 2, 3]), "fresh")
        ).resolves.toBe(ISSUED_PERMIT);
        expect(sink.issues).toHaveLength(1);
    });

    /**
     * The key guard is per capability, so a later capability starts with no history. State
     * surviving disposal would refuse a legitimate request on a key an earlier, unrelated
     * request happened to use.
     */
    test("carries no key history into a later capability", { tags: "p1" }, async () => {
        const sink = new RecordingSink();
        const first = capabilityFor(sink);
        await first.issuePermit(new Uint8Array([1, 2, 3]), "shared-key");
        first[Symbol.dispose]();

        await expect(
            capabilityFor(sink).issuePermit(new Uint8Array([9, 9, 9]), "shared-key")
        ).resolves.toBe(ISSUED_PERMIT);
        expect(sink.issues).toHaveLength(2);
    });
});

describe("TargetBoundCommandTransport", () => {
    test("carries the bound caller and nothing mutable", { tags: "p1" }, () => {
        const transport = capabilityFor(new RecordingSink()).transport();

        expect(transport.caller).toBe(runActor);
        expect(Object.isFrozen(transport)).toBe(true);
    });

    test("refuses a Tenant caller", { tags: "p0" }, () => {
        expect(() => new TargetBoundCommandTransport(tenantActor)).toThrow(TypeError);
    });
});

describe("TargetBoundCommandAuthenticator", () => {
    test("authenticates a command whose caller is the bound Actor", { tags: "p0" }, async () => {
        const authenticator = new TargetBoundCommandAuthenticator(tenant);
        const transport = new TargetBoundCommandTransport(runActor);
        const envelope = envelopeFor({ kind: "actor", actor: runActor });
        const envelopeDigest = Digest.sha256(CommandEnvelopeCodec.encode(envelope));

        const authentication = await authenticator.authenticate(
            transport,
            envelope,
            envelopeDigest
        );

        expect(authentication).toBeDefined();
        expect(authentication?.matches(envelopeDigest, envelope, tenant)).toBe(true);
        expect(
            authentication?.matches(envelopeDigest, envelope, new TenantId("other-tenant"))
        ).toBe(false);
    });

    /**
     * An Actor that holds a capability minted for itself must not obtain a decision
     * attributed to another Actor. This is the unforgeability property the whole
     * capability design exists for: the envelope names its caller, and a caller the
     * capability did not establish authenticates to nothing.
     */
    test("refuses a command that names any other Actor", { tags: "p0" }, async () => {
        const authenticator = new TargetBoundCommandAuthenticator(tenant);
        const transport = new TargetBoundCommandTransport(runActor);
        const impostors = [
            new ActorRef("run", new ActorId("other-run")),
            new ActorRef("workspace", new ActorId("bound-run"))
        ];

        for (const actor of impostors) {
            const envelope = envelopeFor({ kind: "actor", actor });
            const digest = Digest.sha256(CommandEnvelopeCodec.encode(envelope));

            await expect(
                authenticator.authenticate(transport, envelope, digest)
            ).resolves.toBeUndefined();
        }
    });

    test(
        "refuses a command that names a Principal rather than an Actor",
        { tags: "p0" },
        async () => {
            const authenticator = new TargetBoundCommandAuthenticator(tenant);
            const transport = new TargetBoundCommandTransport(runActor);
            const envelope = envelopeFor({
                kind: "principal",
                principal: new PrincipalRef(tenant, new PrincipalId("operator"))
            });
            const digest = Digest.sha256(CommandEnvelopeCodec.encode(envelope));

            await expect(
                authenticator.authenticate(transport, envelope, digest)
            ).resolves.toBeUndefined();
        }
    );
});

/**
 * Every bound the capability holds is attacker-reachable, so each one is tested at the
 * exact value it admits and at the first value it refuses, and each refusal is proven to
 * happen before the sink rather than after it. The constants come from the module that
 * declares them; a literal here would be a second source of truth that could drift.
 */
describe("TargetBoundTenantAuthority bounds", () => {
    test(
        `admits ${MAXIMUM_KEYED_CALLS} distinct idempotency keys and refuses the next`,
        { tags: "p0" },
        async () => {
            const sink = new RecordingSink();
            const capability = capabilityFor(sink);
            const payload = new Uint8Array([1]);

            for (let index = 0; index < MAXIMUM_KEYED_CALLS; index += 1) {
                await expect(capability.issuePermit(payload, `key-${index}`)).resolves.toBe(
                    ISSUED_PERMIT
                );
            }
            expect(sink.issues).toHaveLength(MAXIMUM_KEYED_CALLS);

            await expectAsyncFailure(
                () => capability.issuePermit(payload, `key-${MAXIMUM_KEYED_CALLS}`),
                "operation.invalid-input"
            );
            // The refusal happened before the sink: the call count did not move.
            expect(sink.issues).toHaveLength(MAXIMUM_KEYED_CALLS);

            // A key already admitted is still a redelivery rather than a new key, so the
            // ceiling bounds distinct keys and does not stop a retry.
            await expect(capability.issuePermit(payload, "key-0")).resolves.toBe(ISSUED_PERMIT);
            expect(sink.issues).toHaveLength(MAXIMUM_KEYED_CALLS + 1);
        }
    );

    test(
        `admits a ${MAXIMUM_IDEMPOTENCY_KEY_LENGTH}-character key and refuses one longer`,
        { tags: "p0" },
        async () => {
            const sink = new RecordingSink();
            const capability = capabilityFor(sink);
            const payload = new Uint8Array([2]);
            const atLimit = "k".repeat(MAXIMUM_IDEMPOTENCY_KEY_LENGTH);
            const pastLimit = "k".repeat(MAXIMUM_IDEMPOTENCY_KEY_LENGTH + 1);

            await expect(capability.issuePermit(payload, atLimit)).resolves.toBe(ISSUED_PERMIT);
            expect(sink.issues).toHaveLength(1);
            expect(sink.issues[0]?.key).toBe(atLimit);

            await expectAsyncFailure(
                () => capability.issuePermit(payload, pastLimit),
                "operation.invalid-input"
            );
            expect(sink.issues).toHaveLength(1);

            // The same bound guards the projection path, which shares the admission step.
            await expectAsyncFailure(
                () => capability.projectLeaseEvidence(payload, pastLimit),
                "operation.invalid-input"
            );
            expect(sink.projections).toHaveLength(0);
        }
    );

    test(
        `admits a ${SQL_BLOB_LIMIT_BYTES}-byte payload and refuses one byte more`,
        { tags: "p1" },
        async () => {
            const sink = new RecordingSink();
            const capability = capabilityFor(sink);
            const atLimit = new Uint8Array(SQL_BLOB_LIMIT_BYTES);
            const pastLimit = new Uint8Array(SQL_BLOB_LIMIT_BYTES + 1);

            await expect(capability.issuePermit(atLimit, "at-limit")).resolves.toBe(ISSUED_PERMIT);
            expect(sink.issues).toHaveLength(1);
            expect(sink.issues[0]?.payload.byteLength).toBe(SQL_BLOB_LIMIT_BYTES);

            await expectAsyncFailure(
                () => capability.issuePermit(pastLimit, "past-limit"),
                "operation.invalid-input"
            );
            // Refused before the sink, and before the key was retained, so an over-limit
            // payload cannot consume one of the capability's distinct-key slots either.
            expect(sink.issues).toHaveLength(1);
            await expect(capability.issuePermit(atLimit, "past-limit")).resolves.toBe(
                ISSUED_PERMIT
            );
            expect(sink.issues).toHaveLength(2);

            await expectAsyncFailure(
                () => capability.projectLeaseEvidence(pastLimit, "past-limit-projection"),
                "operation.invalid-input"
            );
            expect(sink.projections).toHaveLength(0);
        }
    );
});
