import type { ActorRef } from "@agent-core/core/actors";
import type { Digest } from "@agent-core/core";
import { AuthorityPermitIssuedRecordSource } from "@agent-core/core/authority";
import {
    AuthorityPermitIssuanceTransport,
    TargetLeaseEvidenceProjectionTransport
} from "@agent-core/core/mediation";
import { operationalFailure, type CloudflareErrorPort } from "./error.js";
import { isPlatformMethod, isPlatformObject } from "./platform-value.js";

/**
 * A target-bound Tenant capability as the Actor that received it addresses it. The
 * methods are the whole surface, and there is no disposer: Cloudflare disposes a stub
 * received in an RPC parameter when that call returns
 * (https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call),
 * so the caller that minted the capability owns its lifetime and this Actor must not
 * release a handle it did not create.
 */
export interface TenantAuthorityCapabilityStub {
    issuePermit(request: Uint8Array, idempotencyKey: string): Promise<Uint8Array>;
    issuedPermit(nonce: string, digest: string): Promise<Uint8Array | undefined>;
    projectLeaseEvidence(evidence: Uint8Array, idempotencyKey: string): Promise<Uint8Array>;
}

/** What every capability-backed transport needs, and nothing more. */
export interface TenantAuthorityCapabilityChannel {
    /** The Tenant Actor this capability reaches. */
    readonly issuer: ActorRef;
    readonly capability: TenantAuthorityCapabilityStub;
    readonly errors: CloudflareErrorPort;
}

/**
 * Carries the target's immutable permit request to its Tenant. The request bytes are
 * opaque here and travel unchanged: this profile authenticates who asked, and the Tenant
 * decides what the answer is.
 */
export class CapabilityAuthorityPermitIssuance extends AuthorityPermitIssuanceTransport {
    readonly #channel: TenantAuthorityCapabilityChannel;

    public constructor(channel: TenantAuthorityCapabilityChannel) {
        super();
        requireCapability(channel);
        this.#channel = channel;
    }

    public async issue(request: Uint8Array, idempotencyKey: string): Promise<Uint8Array> {
        return requireReply(
            this.#channel,
            "permit issuance",
            await this.#channel.capability.issuePermit(request, idempotencyKey)
        );
    }
}

/**
 * Authenticates an issued permit against the Tenant's own record of it. A permit the
 * target holds proves nothing on its own, because the transport that delivered it is
 * exactly what a substitution attacks; the record the issuing Tenant still holds is what
 * settles it.
 */
export class CapabilityAuthorityPermitRecords extends AuthorityPermitIssuedRecordSource {
    readonly #channel: TenantAuthorityCapabilityChannel;

    public constructor(channel: TenantAuthorityCapabilityChannel) {
        super();
        requireCapability(channel);
        this.#channel = channel;
    }

    public async issued(
        issuer: ActorRef,
        nonce: string,
        digest: Digest
    ): Promise<Uint8Array | undefined> {
        if (!issuer.equals(this.#channel.issuer)) {
            operationalFailure(
                this.#channel.errors,
                "authority.denied",
                "An issued-permit lookup named a Tenant this capability does not reach"
            );
        }
        const record = await this.#channel.capability.issuedPermit(nonce, digest.value);
        if (record === undefined) return undefined;
        return requireReply(this.#channel, "issued-permit lookup", record);
    }
}

/**
 * Projects a source Actor's own committed lease attestation to its Tenant. This runs on
 * the source side of a mediated call, under the source's own capability, so no target
 * ever forwards evidence bytes or speaks as the source.
 */
export class CapabilityTargetLeaseEvidenceProjection extends TargetLeaseEvidenceProjectionTransport {
    readonly #channel: TenantAuthorityCapabilityChannel;

    public constructor(channel: TenantAuthorityCapabilityChannel) {
        super();
        requireCapability(channel);
        this.#channel = channel;
    }

    public async project(evidence: Uint8Array, idempotencyKey: string): Promise<Uint8Array> {
        return requireReply(
            this.#channel,
            "lease evidence projection",
            await this.#channel.capability.projectLeaseEvidence(evidence, idempotencyKey)
        );
    }
}

/** A stub as it arrives, before its three methods are established. */
interface TenantAuthorityCapabilityCandidate {
    readonly issuePermit?: unknown;
    readonly issuedPermit?: unknown;
    readonly projectLeaseEvidence?: unknown;
}

function requireCapability(channel: TenantAuthorityCapabilityChannel): void {
    if (!isPlatformObject(channel.capability)) {
        operationalFailure(
            channel.errors,
            "operation.invalid-output",
            "A Tenant capability stub has an invalid shape"
        );
    }
    if (channel.issuer.kind !== "tenant") {
        throw new TypeError("A Tenant capability channel requires a Tenant Actor issuer");
    }
    const capability: TenantAuthorityCapabilityCandidate = channel.capability;
    const complete =
        isPlatformMethod(capability.issuePermit) &&
        isPlatformMethod(capability.issuedPermit) &&
        isPlatformMethod(capability.projectLeaseEvidence);
    if (complete) return;
    operationalFailure(
        channel.errors,
        "operation.invalid-output",
        "A Tenant capability stub has an invalid shape"
    );
}

/**
 * A reply that is not bytes is a broken transport rather than a Tenant decision, and the
 * distinction matters: core refuses a substituted decision, and it can only do that on a
 * reply it can decode.
 */
function requireReply(
    channel: TenantAuthorityCapabilityChannel,
    subject: string,
    reply: Uint8Array
): Uint8Array {
    if (!(reply instanceof Uint8Array) || reply.byteLength === 0) {
        operationalFailure(
            channel.errors,
            "operation.invalid-output",
            `A ${subject} returned no Tenant reply bytes`
        );
    }
    return reply;
}
