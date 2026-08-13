import { ActorId, ActorRef } from "../../src/actors";
import {
    Digest,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    jsonDataParser,
    requireNonempty,
    type JsonValue
} from "../../src/core";
import { OperationRef } from "../../src/facets";
import { PackageId } from "../../src/definition";
import {
    ApprovalCodec,
    AttemptReceipt,
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
    type StructuralCodec,
    type UnpreparedPayload
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
    readonly ledger: TestInvocationLedger<Transaction>;
    transaction<Result>(operation: (transaction: Transaction) => Result): Result;
    restart(): void;
    dispose(): void;
}

const testReference = jsonDataParser((message) => new TypeError(message));

export const referenceCodec: StructuralCodec<string> = Object.freeze({
    encode(value: string): JsonValue {
        if (value.length === 0) throw new TypeError("Test reference is required");
        return value;
    },
    decode(value: JsonValue): string {
        return testReference.nonemptyString(value, "Test reference");
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

export class TestInvocationLedger<Transaction> extends InvocationLedger<
    Transaction,
    string,
    string,
    string,
    string,
    string
> {
    public prepare(
        transaction: Transaction,
        record: PreparedInvocation<string, string, string, string>
    ): void {
        this.prepareUnchecked(transaction, record);
    }

    public supersedeReceipt(transaction: Transaction, receipt: AttemptReceipt): void {
        this.supersedeReceiptUnchecked(transaction, receipt);
    }
}

export function createLedger<Transaction>(
    persistence: TestPersistence<Transaction>,
    options: { readonly timeAdmits?: (time: Date) => boolean } = {}
): TestInvocationLedger<Transaction> {
    const timeAdmits = options.timeAdmits ?? ((time: Date) => Number.isFinite(time.getTime()));
    return new TestInvocationLedger(
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
                return timeAdmits(time);
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
    const header = {
        id: new InvocationId(id),
        operation: operationPin(id, options.approvalRequired ?? false),
        domain: `domain:${id}`,
        actor: new ActorRef("run", new ActorId(`actor:${id}`)),
        authority: `authority:${id}`,
        pathEpochs: `epochs:${id}`,
        auditCause: new AuditRecordId(`audit:${id}`),
        idempotencySeed: options.seed ?? `seed:${id}`
    };
    return PreparedInvocation.create(
        options.lease === undefined ? header : { ...header, lease: options.lease },
        unpreparedPayload(payload),
        {
            ...preparedReferenceCodecs
        }
    );
}

/** Reads a fixture payload as the single or batch request PreparedInvocation.create takes. */
function unpreparedPayload(
    payload: JsonValue | readonly [JsonValue, ...JsonValue[]]
): UnpreparedPayload {
    const items: readonly JsonValue[] | undefined = Array.isArray(payload) ? payload : undefined;
    if (items === undefined) return { kind: "single", item: payload };
    return { kind: "batch", items: requireNonempty(items, "Prepared batch payload") };
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

/** A decoded record's own object, writable so one field of it can be corrupted. */
export type MutableJsonObject = { [key: string]: JsonValue };

/**
 * Decodes a canonically encoded record, lets a suite corrupt one field of its payload, and
 * re-encodes it, so a decoder can be offered a record only its own writer could have made.
 */
export function mutateRecord(
    bytes: Uint8Array,
    mutate: (payload: MutableJsonObject) => void
): Uint8Array {
    const envelope = mutableObject(decodeCanonicalJson(bytes));
    mutate(mutableObject(envelope["payload"]));
    return encodeCanonicalJson(envelope);
}

/** Reads a decoded record's array field as the array its writer encoded. */
export function jsonEntries(value: JsonValue | undefined): readonly JsonValue[] {
    if (!Array.isArray(value)) throw new TypeError("Expected an array in the decoded record");
    return value;
}

/** Reads a decoded record's object field as one this suite may corrupt before re-encoding. */
export function mutableObject(value: JsonValue | undefined): MutableJsonObject {
    if (!isJsonObject(value)) throw new TypeError("Expected an object in the decoded record");
    // SAFETY: the record was decoded from bytes inside `mutateRecord` and is owned by the
    // suite alone; dropping readonly is what lets the corruption be applied before the record
    // is re-encoded and offered back to the decoder under test.
    return value as MutableJsonObject;
}
