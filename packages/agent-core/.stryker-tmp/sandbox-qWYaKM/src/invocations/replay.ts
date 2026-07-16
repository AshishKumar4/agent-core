// @ts-nocheck
import {
    Digest,
    RecordCodec,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue,
    type RecordVersion
} from "../core";
import type { FacetData } from "../facets";
import { PrincipalId, PrincipalRef, TenantId } from "../identity";
import type { MediatedReplayExecutionIdentity } from "../operations";
import {
    requireArray,
    requireDigest,
    requireExactObject,
    requireNonnegativeInteger,
    requireObject,
    requireString
} from "./codec";
import { ReceiptId } from "./id";
import { InvocationId } from "../interaction-references";
import { invocationError } from "./error";

const REPLAY_ID_DOMAIN = "agent-core.mediated-replay.v1";

export type MediatedReplayShape =
    { readonly kind: "single" } | { readonly kind: "batch"; readonly itemCount: number };

export interface InvocationInterceptorTrace {
    readonly interceptor: string;
    readonly contributor: string;
    readonly cutPoint: "operation.before" | "operation.after";
    readonly before: Digest;
    readonly after: Digest;
    readonly outcome: "unchanged" | "rewritten";
}

export interface MediatedReplayItem {
    readonly itemIndex: number;
    readonly rawPayloadIdentity: Digest;
    readonly preparedArguments?: FacetData;
    readonly before?: readonly InvocationInterceptorTrace[];
    readonly effectOutput?: FacetData;
    readonly receipt?: ReceiptId;
    readonly after?: readonly InvocationInterceptorTrace[];
    readonly presentation?: FacetData;
}

export interface MediatedReplayReservation {
    readonly scope: string;
    readonly requestKey: string;
    readonly facet: string;
    readonly operation: string;
    readonly descriptorDigest: Digest;
    readonly principal: PrincipalRef;
    readonly authorityIdentity: Digest;
    readonly packageOperationPin: Digest;
    readonly execution: MediatedReplayExecutionIdentity;
    readonly shape: MediatedReplayShape;
    readonly rawPayloadIdentities: readonly Digest[];
}

export class MediatedReplayRecord {
    public readonly id: Digest;
    public readonly items: readonly MediatedReplayItem[];

    public constructor(
        public readonly scope: string,
        public readonly requestKey: string,
        public readonly facet: string,
        public readonly operation: string,
        public readonly descriptorDigest: Digest,
        public readonly principal: PrincipalRef,
        public readonly authorityIdentity: Digest,
        public readonly packageOperationPin: Digest,
        public readonly execution: MediatedReplayExecutionIdentity,
        public readonly shape: MediatedReplayShape,
        items: readonly MediatedReplayItem[],
        public readonly invocation: InvocationId | undefined,
        public readonly revision: Revision
    ) {
        requireCanonical(scope, "Replay scope");
        requireCanonical(requestKey, "Replay request key");
        requireCanonical(facet, "Replay Facet reference");
        requireCanonical(operation, "Replay operation");
        if (principal.constructor !== PrincipalRef) {
            throw new TypeError("Replay Principal must use the exact PrincipalRef class");
        }
        if (execution.kind !== "lease" && execution.kind !== "route") {
            throw new TypeError("Replay execution identity kind is invalid");
        }
        this.principal = new PrincipalRef(principal.tenantId, principal.principalId);
        const itemCount = shape.kind === "single" ? 1 : shape.itemCount;
        if (!Number.isSafeInteger(itemCount) || itemCount <= 0 || items.length !== itemCount) {
            throw new TypeError("Replay items must exactly match the nonempty payload shape");
        }
        this.items = Object.freeze(items.map((item, index) => copyItem(item, index)));
        validatePhases(this.items, invocation, revision.value);
        this.id = replayId({
            scope,
            requestKey,
            facet,
            operation,
            descriptorDigest,
            principal,
            authorityIdentity,
            packageOperationPin,
            execution,
            shape,
            rawPayloadIdentities: this.items.map((item) => item.rawPayloadIdentity)
        });
        Object.freeze(descriptorDigest);
        Object.freeze(authorityIdentity);
        Object.freeze(packageOperationPin);
        Object.freeze(execution.digest);
        Object.freeze(execution);
        Object.freeze(this.id);
        Object.freeze(this);
    }

    public static reserve(reservation: MediatedReplayReservation): MediatedReplayRecord {
        const itemCount = reservation.shape.kind === "single" ? 1 : reservation.shape.itemCount;
        if (reservation.rawPayloadIdentities.length !== itemCount) {
            throw invalidTransition("Replay reservation payload identities do not match its shape");
        }
        return new MediatedReplayRecord(
            reservation.scope,
            reservation.requestKey,
            reservation.facet,
            reservation.operation,
            reservation.descriptorDigest,
            reservation.principal,
            reservation.authorityIdentity,
            reservation.packageOperationPin,
            reservation.execution,
            reservation.shape,
            reservation.rawPayloadIdentities.map((rawPayloadIdentity, itemIndex) => ({
                itemIndex,
                rawPayloadIdentity
            })),
            undefined,
            Revision.initial()
        );
    }

    public static encode(record: MediatedReplayRecord): Uint8Array {
        return MediatedReplayRecordCodec.encode(record);
    }

    public static decode(bytes: Uint8Array): MediatedReplayRecord {
        return MediatedReplayRecordCodec.decode(bytes);
    }

    public prepare(
        invocation: InvocationId,
        argumentsByItem: readonly FacetData[],
        tracesByItem: readonly (readonly InvocationInterceptorTrace[])[]
    ): MediatedReplayRecord {
        if (
            this.invocation !== undefined ||
            argumentsByItem.length !== this.items.length ||
            tracesByItem.length !== this.items.length
        ) {
            throw invalidTransition(
                "Replay preparation must complete one reserved payload exactly once"
            );
        }
        return this.transition(
            this.items.map((item, index) => ({
                ...item,
                preparedArguments: canonicalData(argumentsByItem[index]!),
                before: copyTraces(tracesByItem[index]!, "operation.before")
            })),
            invocation
        );
    }

    public recordEffect(
        itemIndex: number,
        output: FacetData,
        receipt: ReceiptId
    ): MediatedReplayRecord {
        const item = this.requirePreparedItem(itemIndex);
        if (item.effectOutput !== undefined || item.receipt !== undefined) {
            throw invalidTransition("Replay effect output is immutable");
        }
        return this.replaceItem(itemIndex, {
            ...item,
            effectOutput: canonicalData(output),
            receipt
        });
    }

    public recordTerminal(itemIndex: number, receipt: ReceiptId): MediatedReplayRecord {
        const item = this.requirePreparedItem(itemIndex);
        if (item.effectOutput !== undefined || item.receipt !== undefined) {
            throw invalidTransition("Replay terminal result is immutable");
        }
        return this.replaceItem(itemIndex, { ...item, receipt });
    }

    public present(
        itemIndex: number,
        traces: readonly InvocationInterceptorTrace[],
        presentation: FacetData
    ): MediatedReplayRecord {
        const item = this.requirePreparedItem(itemIndex);
        if (
            item.effectOutput === undefined ||
            item.receipt === undefined ||
            item.after !== undefined ||
            item.presentation !== undefined
        ) {
            throw invalidTransition("Replay presentation requires one unpresented effect output");
        }
        return this.replaceItem(itemIndex, {
            ...item,
            after: copyTraces(traces, "operation.after"),
            presentation: canonicalData(presentation)
        });
    }

    public get complete(): boolean {
        return this.items.every(
            (item) =>
                item.receipt !== undefined &&
                (item.effectOutput === undefined || item.presentation !== undefined)
        );
    }

    private requirePreparedItem(itemIndex: number): MediatedReplayItem {
        if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) {
            throw new TypeError("Replay item index must be a non-negative safe integer");
        }
        const item = this.items[itemIndex];
        if (
            this.invocation === undefined ||
            item?.preparedArguments === undefined ||
            item.before === undefined
        ) {
            throw new TypeError("Replay item has not completed preparation");
        }
        return item;
    }

    private replaceItem(itemIndex: number, item: MediatedReplayItem): MediatedReplayRecord {
        const items = [...this.items];
        items[itemIndex] = item;
        return this.transition(items, this.invocation);
    }

    private transition(
        items: readonly MediatedReplayItem[],
        invocation: InvocationId | undefined
    ): MediatedReplayRecord {
        return new MediatedReplayRecord(
            this.scope,
            this.requestKey,
            this.facet,
            this.operation,
            this.descriptorDigest,
            this.principal,
            this.authorityIdentity,
            this.packageOperationPin,
            this.execution,
            this.shape,
            items,
            invocation,
            this.revision.next()
        );
    }
}

class MediatedReplayRecordCodecV1 extends RecordCodec<MediatedReplayRecord> {
    public constructor() {
        super("invocation.mediated-replay", { major: 1, minor: 0 });
    }

    protected encodePayload(record: MediatedReplayRecord): JsonValue {
        return {
            authorityIdentity: record.authorityIdentity.value,
            descriptorDigest: record.descriptorDigest.value,
            execution: { digest: record.execution.digest.value, kind: record.execution.kind },
            facet: record.facet,
            id: record.id.value,
            invocation: record.invocation?.value ?? null,
            items: record.items.map(encodeItem),
            operation: record.operation,
            packageOperationPin: record.packageOperationPin.value,
            principal: {
                principal: record.principal.principalId.value,
                tenant: record.principal.tenantId.value
            },
            requestKey: record.requestKey,
            revision: record.revision.value,
            scope: record.scope,
            shape: record.shape
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): MediatedReplayRecord {
        const object = requireExactObject(
            payload,
            [
                "descriptorDigest",
                "authorityIdentity",
                "execution",
                "facet",
                "id",
                "invocation",
                "items",
                "operation",
                "packageOperationPin",
                "principal",
                "requestKey",
                "revision",
                "scope",
                "shape"
            ],
            "Mediated replay"
        );
        const invocation = object["invocation"];
        if (invocation !== null && typeof invocation !== "string") {
            throw new TypeError("Replay invocation must be a string or null");
        }
        const record = new MediatedReplayRecord(
            requireString(object, "scope"),
            requireString(object, "requestKey"),
            requireString(object, "facet"),
            requireString(object, "operation"),
            requireDigest(object, "descriptorDigest"),
            decodePrincipal(object["principal"]!),
            requireDigest(object, "authorityIdentity"),
            requireDigest(object, "packageOperationPin"),
            decodeExecution(object["execution"]!),
            decodeShape(object["shape"]!),
            requireArray(object, "items").map(decodeItem),
            invocation === null ? undefined : new InvocationId(invocation),
            new Revision(requireNonnegativeInteger(object, "revision"))
        );
        if (record.id.value !== requireString(object, "id")) {
            throw new TypeError("Replay ID does not match its canonical reservation identity");
        }
        return record;
    }
}

function replayId(reservation: MediatedReplayReservation): Digest {
    return Digest.sha256(
        encodeCanonicalJson({
            domain: REPLAY_ID_DOMAIN,
            authorityIdentity: reservation.authorityIdentity.value,
            descriptorDigest: reservation.descriptorDigest.value,
            execution: {
                digest: reservation.execution.digest.value,
                kind: reservation.execution.kind
            },
            facet: reservation.facet,
            operation: reservation.operation,
            packageOperationPin: reservation.packageOperationPin.value,
            principal: {
                principal: reservation.principal.principalId.value,
                tenant: reservation.principal.tenantId.value
            },
            rawPayloadIdentities: reservation.rawPayloadIdentities.map((digest) => digest.value),
            requestKey: reservation.requestKey,
            scope: reservation.scope,
            shape: reservation.shape
        })
    );
}

function decodePrincipal(value: JsonValue): PrincipalRef {
    const object = requireExactObject(value, ["principal", "tenant"], "Replay Principal");
    return new PrincipalRef(
        new TenantId(requireString(object, "tenant")),
        new PrincipalId(requireString(object, "principal"))
    );
}

function decodeExecution(value: JsonValue): MediatedReplayExecutionIdentity {
    const object = requireExactObject(value, ["digest", "kind"], "Replay execution identity");
    const kind = requireString(object, "kind");
    if (kind !== "lease" && kind !== "route") {
        throw new TypeError("Replay execution identity kind is invalid");
    }
    return Object.freeze({ kind, digest: requireDigest(object, "digest") });
}

function copyItem(item: MediatedReplayItem, expectedIndex: number): MediatedReplayItem {
    if (item.itemIndex !== expectedIndex)
        throw new TypeError("Replay item index must equal its position");
    return Object.freeze({
        itemIndex: item.itemIndex,
        rawPayloadIdentity: new Digest(item.rawPayloadIdentity.value),
        ...(item.preparedArguments === undefined
            ? {}
            : { preparedArguments: canonicalData(item.preparedArguments) }),
        ...(item.before === undefined
            ? {}
            : { before: copyTraces(item.before, "operation.before") }),
        ...(item.effectOutput === undefined
            ? {}
            : { effectOutput: canonicalData(item.effectOutput) }),
        ...(item.receipt === undefined ? {} : { receipt: item.receipt }),
        ...(item.after === undefined ? {} : { after: copyTraces(item.after, "operation.after") }),
        ...(item.presentation === undefined
            ? {}
            : { presentation: canonicalData(item.presentation) })
    });
}

function validatePhases(
    items: readonly MediatedReplayItem[],
    invocation: InvocationId | undefined,
    revision: number
): void {
    const prepared = items.every(
        (item) => item.preparedArguments !== undefined && item.before !== undefined
    );
    if ((invocation !== undefined) !== prepared || (invocation === undefined && revision !== 0)) {
        throw new TypeError("Replay preparation phase is inconsistent");
    }
    for (const item of items) {
        if (
            (item.effectOutput !== undefined && item.receipt === undefined) ||
            (item.after === undefined) !== (item.presentation === undefined) ||
            (item.presentation !== undefined && item.effectOutput === undefined)
        ) {
            throw new TypeError("Replay item phases are inconsistent");
        }
    }
}

function copyTraces(
    traces: readonly InvocationInterceptorTrace[],
    cutPoint: InvocationInterceptorTrace["cutPoint"]
): readonly InvocationInterceptorTrace[] {
    return Object.freeze(
        traces.map((trace) => {
            if (trace.cutPoint !== cutPoint)
                throw new TypeError("Replay trace has the wrong cut point");
            return Object.freeze({
                interceptor: trace.interceptor,
                contributor: trace.contributor,
                cutPoint,
                before: new Digest(trace.before.value),
                after: new Digest(trace.after.value),
                outcome: trace.outcome
            });
        })
    );
}

function encodeItem(item: MediatedReplayItem): JsonValue {
    return {
        after: item.after?.map(encodeTrace) ?? null,
        before: item.before?.map(encodeTrace) ?? null,
        effectOutput: item.effectOutput ?? null,
        itemIndex: item.itemIndex,
        phase:
            item.presentation !== undefined
                ? "presented"
                : item.effectOutput !== undefined
                  ? "effect"
                  : item.receipt !== undefined
                    ? "terminal"
                    : item.preparedArguments !== undefined
                      ? "prepared"
                      : "reserved",
        preparedArguments: item.preparedArguments ?? null,
        presentation: item.presentation ?? null,
        rawPayloadIdentity: item.rawPayloadIdentity.value,
        receipt: item.receipt?.value ?? null
    };
}

function decodeItem(value: JsonValue): MediatedReplayItem {
    const object = requireExactObject(
        value,
        [
            "after",
            "before",
            "effectOutput",
            "itemIndex",
            "phase",
            "preparedArguments",
            "presentation",
            "rawPayloadIdentity",
            "receipt"
        ],
        "Replay item"
    );
    const receipt = object["receipt"];
    const phase = requireString(object, "phase");
    if (receipt !== null && typeof receipt !== "string")
        throw new TypeError("Replay Receipt is malformed");
    if (
        phase !== "reserved" &&
        phase !== "prepared" &&
        phase !== "effect" &&
        phase !== "terminal" &&
        phase !== "presented"
    ) {
        throw new TypeError("Replay item phase is invalid");
    }
    return {
        itemIndex: requireNonnegativeInteger(object, "itemIndex"),
        rawPayloadIdentity: requireDigest(object, "rawPayloadIdentity"),
        ...(phase === "reserved"
            ? {}
            : {
                  preparedArguments: object["preparedArguments"]!,
                  before: requireArray(object, "before").map(decodeTrace)
              }),
        ...(phase === "effect" || phase === "presented"
            ? {
                  effectOutput: object["effectOutput"]!,
                  receipt: new ReceiptId(receipt as string)
              }
            : {}),
        ...(phase === "terminal" ? { receipt: new ReceiptId(receipt as string) } : {}),
        ...(phase === "presented"
            ? {
                  after: requireArray(object, "after").map(decodeTrace),
                  presentation: object["presentation"]!
              }
            : {})
    };
}

function encodeTrace(trace: InvocationInterceptorTrace): JsonValue {
    return {
        after: trace.after.value,
        before: trace.before.value,
        contributor: trace.contributor,
        cutPoint: trace.cutPoint,
        interceptor: trace.interceptor,
        outcome: trace.outcome
    };
}

function decodeTrace(value: JsonValue): InvocationInterceptorTrace {
    const object = requireExactObject(
        value,
        ["after", "before", "contributor", "cutPoint", "interceptor", "outcome"],
        "Replay interceptor trace"
    );
    const cutPoint = requireString(object, "cutPoint");
    const outcome = requireString(object, "outcome");
    if (
        (cutPoint !== "operation.before" && cutPoint !== "operation.after") ||
        (outcome !== "unchanged" && outcome !== "rewritten")
    ) {
        throw new TypeError("Replay interceptor trace is invalid");
    }
    return {
        interceptor: requireString(object, "interceptor"),
        contributor: requireString(object, "contributor"),
        cutPoint,
        before: requireDigest(object, "before"),
        after: requireDigest(object, "after"),
        outcome
    };
}

function decodeShape(value: JsonValue): MediatedReplayShape {
    const candidate = requireObject(value, "Replay shape");
    if (candidate["kind"] === "single") {
        requireExactObject(value, ["kind"], "Single replay shape");
        return Object.freeze({ kind: "single" });
    }
    const object = requireExactObject(value, ["itemCount", "kind"], "Batch replay shape");
    if (requireString(object, "kind") !== "batch") throw new TypeError("Replay shape is invalid");
    return Object.freeze({
        kind: "batch",
        itemCount: requireNonnegativeInteger(object, "itemCount")
    });
}

function requireCanonical(value: string, subject: string): void {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new TypeError(`${subject} must be canonical`);
    }
}

function canonicalData(value: FacetData): FacetData {
    return decodeCanonicalJson(encodeCanonicalJson(value)) as FacetData;
}

function invalidTransition(message: string) {
    return invocationError("state.invalid-transition", message);
}

export const MediatedReplayRecordCodec: RecordCodec<MediatedReplayRecord> =
    new MediatedReplayRecordCodecV1();
