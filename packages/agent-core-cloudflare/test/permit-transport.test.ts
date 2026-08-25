import { AgentCoreError, Digest } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import type { CloudflareErrorPort, CloudflareOperationalErrorCode } from "../src/error.js";
import {
    CapabilityAuthorityPermitIssuance,
    CapabilityAuthorityPermitRecords,
    CapabilityTargetLeaseEvidenceProjection,
    type TenantAuthorityCapabilityChannel,
    type TenantAuthorityCapabilityStub
} from "../src/permit-transport.js";
import { malformedInput } from "./assertions.js";

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

/**
 * The stub arrives from the platform, so the shapes under test include the ones the
 * declared interface forbids and a live RPC parameter can still deliver.
 */
function malformedStub<Value>(value: Value): TenantAuthorityCapabilityStub {
    return malformedInput<TenantAuthorityCapabilityStub, Value>(value);
}

const ISSUED_PERMIT = new Uint8Array([11, 22, 33]);
const ISSUED_RECORD = new Uint8Array([44, 55]);
const PROJECTED_EVIDENCE = new Uint8Array([66, 77, 88]);

interface KeyedCall {
    readonly payload: Uint8Array;
    readonly key: string;
}

interface LookupCall {
    readonly nonce: string;
    readonly digest: string;
}

class FakeCapability implements TenantAuthorityCapabilityStub {
    public readonly issues: KeyedCall[] = [];
    public readonly lookups: LookupCall[] = [];
    public readonly projections: KeyedCall[] = [];
    public issueReply: Uint8Array = ISSUED_PERMIT;
    public lookupReply: Uint8Array | undefined = ISSUED_RECORD;
    public projectReply: Uint8Array = PROJECTED_EVIDENCE;

    public async issuePermit(request: Uint8Array, idempotencyKey: string): Promise<Uint8Array> {
        this.issues.push({ payload: request, key: idempotencyKey });
        return this.issueReply;
    }

    public async issuedPermit(nonce: string, digest: string): Promise<Uint8Array | undefined> {
        this.lookups.push({ nonce, digest });
        return this.lookupReply;
    }

    public async projectLeaseEvidence(
        evidence: Uint8Array,
        idempotencyKey: string
    ): Promise<Uint8Array> {
        this.projections.push({ payload: evidence, key: idempotencyKey });
        return this.projectReply;
    }
}

const tenantActor = new ActorRef("tenant", new ActorId("reachable-tenant"));
const otherTenantActor = new ActorRef("tenant", new ActorId("unreachable-tenant"));
const runActor = new ActorRef("run", new ActorId("source-run"));

function channelFor(capability: TenantAuthorityCapabilityStub): TenantAuthorityCapabilityChannel {
    return { issuer: tenantActor, capability, errors };
}

async function issueThrough(capability: TenantAuthorityCapabilityStub): Promise<Uint8Array> {
    return new CapabilityAuthorityPermitIssuance(channelFor(capability)).issue(
        new Uint8Array([1]),
        "reply-shape"
    );
}

async function lookupThrough(
    capability: TenantAuthorityCapabilityStub
): Promise<Uint8Array | undefined> {
    return new CapabilityAuthorityPermitRecords(channelFor(capability)).issued(
        tenantActor,
        "nonce-1",
        Digest.sha256(new Uint8Array([1]))
    );
}

async function projectThrough(capability: TenantAuthorityCapabilityStub): Promise<Uint8Array> {
    return new CapabilityTargetLeaseEvidenceProjection(channelFor(capability)).project(
        new Uint8Array([1]),
        "reply-shape"
    );
}

describe("capability-backed Tenant transports", () => {
    /**
     * The bytes are opaque at this seam: the Tenant decides what a permit says, so a
     * transport that altered or re-wrapped either direction would be deciding instead of
     * carrying.
     */
    test("carries the request and the Tenant reply unchanged", { tags: "p0" }, async () => {
        const capability = new FakeCapability();
        const request = new Uint8Array([1, 2, 3]);

        const reply = await new CapabilityAuthorityPermitIssuance(channelFor(capability)).issue(
            request,
            "issue-1"
        );

        expect(reply).toBe(ISSUED_PERMIT);
        expect(capability.issues).toEqual([{ payload: request, key: "issue-1" }]);
        expect(capability.issues[0]?.payload).toBe(request);
    });

    test("carries the evidence and the Tenant reply unchanged", { tags: "p0" }, async () => {
        const capability = new FakeCapability();
        const evidence = new Uint8Array([4, 5, 6]);

        const reply = await new CapabilityTargetLeaseEvidenceProjection(
            channelFor(capability)
        ).project(evidence, "project-1");

        expect(reply).toBe(PROJECTED_EVIDENCE);
        expect(capability.projections).toEqual([{ payload: evidence, key: "project-1" }]);
        expect(capability.projections[0]?.payload).toBe(evidence);
    });

    /**
     * The record source takes a `Digest` and the stub takes text, so the transport owns
     * that one conversion. Passing anything but the canonical hexadecimal value would
     * look up a record the Tenant never keyed.
     */
    test("looks a record up under the digest's canonical value", { tags: "p0" }, async () => {
        const capability = new FakeCapability();
        const digest = Digest.sha256(new Uint8Array([7, 8, 9]));

        const reply = await new CapabilityAuthorityPermitRecords(channelFor(capability)).issued(
            tenantActor,
            "nonce-1",
            digest
        );

        expect(reply).toBe(ISSUED_RECORD);
        expect(capability.lookups).toEqual([{ nonce: "nonce-1", digest: digest.value }]);
        expect(digest.value).toMatch(/^[0-9a-f]{64}$/);
    });

    test("requires a Tenant Actor issuer", { tags: "p0" }, () => {
        const channel: TenantAuthorityCapabilityChannel = {
            issuer: runActor,
            capability: new FakeCapability(),
            errors
        };

        expect(() => new CapabilityAuthorityPermitIssuance(channel)).toThrow(TypeError);
        expect(() => new CapabilityAuthorityPermitRecords(channel)).toThrow(TypeError);
        expect(() => new CapabilityTargetLeaseEvidenceProjection(channel)).toThrow(TypeError);
    });

    /**
     * A stub missing any one method is a broken capability, and finding that out at the
     * first call would mean discovering it mid-decision instead of at construction.
     */
    test("refuses a stub missing any one method", { tags: "p0" }, () => {
        const issuePermit = async (): Promise<Uint8Array> => ISSUED_PERMIT;
        const issuedPermit = async (): Promise<Uint8Array | undefined> => ISSUED_RECORD;
        const projectLeaseEvidence = async (): Promise<Uint8Array> => PROJECTED_EVIDENCE;
        const incomplete = [
            malformedStub({ issuedPermit, projectLeaseEvidence }),
            malformedStub({ issuePermit, projectLeaseEvidence }),
            malformedStub({ issuePermit, issuedPermit }),
            malformedStub(undefined)
        ];

        for (const capability of incomplete) {
            const channel = channelFor(capability);

            expectOperationalConstruction(() => new CapabilityAuthorityPermitIssuance(channel));
            expectOperationalConstruction(() => new CapabilityAuthorityPermitRecords(channel));
            expectOperationalConstruction(
                () => new CapabilityTargetLeaseEvidenceProjection(channel)
            );
        }
    });

    test("refuses a reply that is not Tenant bytes", { tags: "p0" }, async () => {
        const capability = new FakeCapability();
        capability.issueReply = malformedInput<Uint8Array, string>("permit");
        capability.projectReply = malformedInput<Uint8Array, null>(null);
        capability.lookupReply = malformedInput<Uint8Array, number>(7);

        await expectAsyncFailure(() => issueThrough(capability), "operation.invalid-output");
        await expectAsyncFailure(() => projectThrough(capability), "operation.invalid-output");
        await expectAsyncFailure(() => lookupThrough(capability), "operation.invalid-output");
    });

    test("refuses an empty reply", { tags: "p0" }, async () => {
        const capability = new FakeCapability();
        capability.issueReply = new Uint8Array();
        capability.projectReply = new Uint8Array();
        capability.lookupReply = new Uint8Array();

        await expectAsyncFailure(() => issueThrough(capability), "operation.invalid-output");
        await expectAsyncFailure(() => projectThrough(capability), "operation.invalid-output");
        await expectAsyncFailure(() => lookupThrough(capability), "operation.invalid-output");
    });

    /**
     * A capability reaches exactly one Tenant. Forwarding a lookup that named another one
     * would let a target authenticate a permit against a record it has no authority over.
     */
    test("refuses a lookup naming a Tenant it cannot reach", { tags: "p0" }, async () => {
        const capability = new FakeCapability();
        const records = new CapabilityAuthorityPermitRecords(channelFor(capability));

        await expectAsyncFailure(
            () => records.issued(otherTenantActor, "nonce-1", Digest.sha256(new Uint8Array([1]))),
            "authority.denied"
        );
        await expectAsyncFailure(
            () => records.issued(runActor, "nonce-1", Digest.sha256(new Uint8Array([1]))),
            "authority.denied"
        );

        expect(capability.lookups).toEqual([]);
    });

    /**
     * No record is an answer, not a broken reply. Applying the empty-reply refusal here
     * would turn "this Tenant issued no such permit" into a transport failure and hide
     * the very denial the authenticator needs.
     */
    test(
        "reports an absent record as absent rather than as a broken reply",
        { tags: "p0" },
        async () => {
            const capability = new FakeCapability();
            capability.lookupReply = undefined;

            await expect(lookupThrough(capability)).resolves.toBeUndefined();
            expect(capability.lookups).toHaveLength(1);
        }
    );
});

function expectOperationalConstruction<Transport>(construct: () => Transport): void {
    try {
        construct();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code: "operation.invalid-output" });
        return;
    }
    throw new TypeError("Expected an invalid capability stub to be refused");
}
