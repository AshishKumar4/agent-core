import { ActorId, ActorRef } from "../../src/actors";
import { Digest, SemVer, type JsonValue } from "../../src/core";
import { OperationRef } from "../../src/facets";
import { PackageId } from "../../src/definition";
import {
    ApprovalCodec,
    AuthorityAdmissionReference,
    AuditRecordId,
    EffectAttemptCodec,
    InvocationId,
    InvocationContinuationCodec,
    InvocationLedger,
    InvocationPlacementPin,
    ItemClaimCodec,
    OperationPin,
    PreparedInvocation,
    PreparedInvocationCodec,
    ReceiptCodec,
    type InvocationPersistence,
    type StructuralCodec
} from "../../src/invocations";

export type TestReference = string;
export type TestPersistence<Transaction> = InvocationPersistence<
    Transaction,
    TestReference,
    TestReference,
    TestReference,
    TestReference,
    TestReference
>;

export interface InvocationHarness<Transaction> {
    readonly persistence: TestPersistence<Transaction>;
    readonly ledger: InvocationLedger<
        Transaction,
        TestReference,
        TestReference,
        TestReference,
        TestReference,
        TestReference
    >;
    transaction<Result>(operation: (transaction: Transaction) => Result): Result;
    restart(): void;
    dispose(): void;
}

export const referenceCodec: StructuralCodec<string> = Object.freeze({
    encode(value: string): JsonValue {
        if (value.length === 0) throw new TypeError("Test reference is required");
        return value;
    },
    decode(value: JsonValue): string {
        if (typeof value !== "string" || value.length === 0) {
            throw new TypeError("Test reference must be a string");
        }
        return value;
    }
});

export const preparedReferenceCodecs = Object.freeze({
    lease: referenceCodec,
    authority: referenceCodec,
    domain: referenceCodec,
    pathEpochs: referenceCodec
});
export const preparedCodec = new PreparedInvocationCodec(preparedReferenceCodecs);
export const claimCodec = new ItemClaimCodec(referenceCodec);
export const attemptCodec = new EffectAttemptCodec(referenceCodec, referenceCodec);
export const continuationCodec = new InvocationContinuationCodec(referenceCodec);

export const invocationCodecs = Object.freeze({
    prepared: preparedCodec,
    approval: ApprovalCodec,
    continuation: continuationCodec,
    claim: claimCodec,
    attempt: attemptCodec,
    receipt: ReceiptCodec
});

export function createLedger<Transaction>(
    persistence: TestPersistence<Transaction>
): InvocationLedger<Transaction, string, string, string, string, string> {
    return new InvocationLedger(
        persistence,
        referenceCodec,
        {
            admits(_transaction, invocation): boolean {
                return (
                    invocation.header.actor.id.value === `actor:${invocation.header.id.value}` &&
                    invocation.header.domain === `domain:${invocation.header.id.value}` &&
                    invocation.header.auditCause.value === `audit:${invocation.header.id.value}`
                );
            }
        },
        {
            admits(_transaction, time): boolean {
                return Number.isFinite(time.getTime());
            }
        },
        {
            admits(_transaction, claim): boolean {
                return claim.owner.worker.value !== "stale-worker";
            }
        },
        {
            admits(_transaction, admission, context): boolean {
                const expected = admissionFor(
                    context.invocation.value,
                    context.itemIndex,
                    context.ordinal
                );
                return (
                    admission.reference === expected.reference &&
                    admission.digest.equals(expected.digest) &&
                    context.authority === `authority:${context.invocation.value}` &&
                    context.domain === `domain:${context.invocation.value}` &&
                    context.pathEpochs === `epochs:${context.invocation.value}` &&
                    context.itemKey.startsWith("agent-core.item.v1:") &&
                    context.intentDigest.value.length === 64
                );
            }
        }
    );
}

export function prepared(
    id: string,
    payload: JsonValue | readonly [JsonValue, ...JsonValue[]] = { value: id },
    options: {
        readonly lease?: string;
        readonly seed?: string;
        readonly approvalRequired?: boolean;
    } = {}
): PreparedInvocation<string, string, string, string> {
    return PreparedInvocation.create(
        {
            id: new InvocationId(id),
            operation: operationPin(id, options.approvalRequired ?? false),
            domain: `domain:${id}`,
            actor: new ActorRef("run", new ActorId(`actor:${id}`)),
            authority: `authority:${id}`,
            pathEpochs: `epochs:${id}`,
            ...(options.lease === undefined ? {} : { lease: options.lease }),
            auditCause: new AuditRecordId(`audit:${id}`),
            idempotencySeed: options.seed ?? `seed:${id}`
        },
        Array.isArray(payload)
            ? { kind: "batch", items: payload as unknown as readonly [JsonValue, ...JsonValue[]] }
            : { kind: "single", item: payload as JsonValue },
        {
            ...preparedReferenceCodecs
        }
    );
}

export function operationPin(id: string, approvalRequired = false): OperationPin {
    const placement = new InvocationPlacementPin({
        manifest: ["bundled", "provider"],
        policy: ["bundled", "provider"],
        substrate: ["bundled", "provider"],
        trust: ["bundled", "provider"],
        selected: "provider"
    });
    return OperationPin.create({
        operation: new OperationRef(`operation:${id}`),
        target: `target:${id}`,
        package: new PackageId(`package:${id}`),
        version: new SemVer("1.0.0"),
        manifestDigest: digest(`manifest:${id}`),
        descriptorDigest: digest(`descriptor:${id}`),
        configurationDigest: digest(`configuration:${id}`),
        runtimeDigest: digest(`runtime:${id}`),
        activationGeneration: `generation:${id}`,
        registration: `registration:${id}`,
        impact: "externalSend",
        approvalRequired,
        placement
    });
}

export function admissionFor(
    invocation: string,
    itemIndex: number,
    ordinal: number
): AuthorityAdmissionReference<string> {
    const reference = `admit:${invocation}:${itemIndex}:${ordinal}`;
    return new AuthorityAdmissionReference(reference, digest(reference));
}

export function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}
