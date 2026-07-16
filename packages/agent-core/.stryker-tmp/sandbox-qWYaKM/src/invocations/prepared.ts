// @ts-nocheck
import { ActorId, ActorRef, type ActorKind } from "../actors";
import {
    Digest,
    RecordCodec,
    encodeCanonicalJson,
    type JsonValue,
    type RecordVersion
} from "../core";
import { canonicalFacetData, type FacetData } from "../facets";
import {
    requireArray,
    requireCanonicalText,
    requireDigest,
    requireExactObject,
    requireObject,
    requireString,
    sameJson,
    immutableReference,
    type StructuralCodec
} from "./codec";
import { AuditRecordId, InvocationId, RouteReservationId } from "../interaction-references";
import { OperationPin } from "./operation-pin";
import { invocationError } from "./error";

const ITEM_KEY_DOMAIN = "agent-core.item.v1";
const HEADER_DIGEST_DOMAIN = "agent-core.prepared-header.v1";
const INTENT_DIGEST_DOMAIN = "agent-core.prepared-invocation.v1";

export interface PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs> {
    readonly lease: StructuralCodec<Lease>;
    readonly authority: StructuralCodec<Authority>;
    readonly domain: StructuralCodec<Domain>;
    readonly pathEpochs: StructuralCodec<PathEpochs>;
}

export interface PreparedInvocationHeaderInit<Lease, Authority, Domain, PathEpochs> {
    readonly id: InvocationId;
    readonly operation: OperationPin;
    readonly domain: Domain;
    readonly actor: ActorRef;
    readonly authority: Authority;
    readonly pathEpochs: PathEpochs;
    readonly lease?: Lease;
    readonly route?: RouteReservationId;
    readonly projectionDigest?: Digest;
    readonly auditCause: AuditRecordId;
    readonly idempotencySeed: string;
}

export class PreparedInvocationHeader<Lease, Authority, Domain, PathEpochs> {
    public constructor(
        public readonly id: InvocationId,
        public readonly operation: OperationPin,
        public readonly domain: Domain,
        public readonly actor: ActorRef,
        public readonly authority: Authority,
        public readonly pathEpochs: PathEpochs,
        public readonly lease: Lease | undefined,
        public readonly route: RouteReservationId | undefined,
        public readonly projectionDigest: Digest | undefined,
        public readonly auditCause: AuditRecordId,
        public readonly idempotencySeed: string
    ) {
        if (
            id.constructor !== InvocationId ||
            auditCause.constructor !== AuditRecordId ||
            (route !== undefined && route.constructor !== RouteReservationId)
        ) {
            throw new TypeError("Prepared invocation identifiers must use exact context classes");
        }
        requireCanonicalText(idempotencySeed, "Invocation idempotency seed");
        if ((route === undefined) !== (projectionDigest === undefined)) {
            throw new TypeError("Route and projection digest must be present together");
        }
        if (projectionDigest !== undefined) Object.freeze(projectionDigest);
        Object.freeze(this);
    }
}

export class PreparedItem {
    public readonly arguments: FacetData;

    public constructor(
        argumentsValue: FacetData,
        public readonly idempotencyKey: string
    ) {
        requireCanonicalText(idempotencyKey, "Invocation item key");
        this.arguments = canonicalFacetData(argumentsValue);
        Object.freeze(this);
    }
}

export type PreparedPayload =
    | { readonly kind: "single"; readonly item: PreparedItem }
    | { readonly kind: "batch"; readonly items: readonly [PreparedItem, ...PreparedItem[]] };

export type UnpreparedPayload =
    | { readonly kind: "single"; readonly item: FacetData }
    | { readonly kind: "batch"; readonly items: readonly [FacetData, ...FacetData[]] };

export class PreparedInvocation<Lease, Authority, Domain, PathEpochs> {
    private constructor(
        public readonly header: PreparedInvocationHeader<Lease, Authority, Domain, PathEpochs>,
        public readonly payload: PreparedPayload,
        public readonly intentDigest: Digest
    ) {
        Object.freeze(intentDigest);
        Object.freeze(this);
    }

    public static encode<Lease, Authority, Domain, PathEpochs>(
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>,
        codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>
    ): Uint8Array {
        return new PreparedInvocationCodec(codecs).encode(record);
    }

    public static decode<Lease, Authority, Domain, PathEpochs>(
        bytes: Uint8Array,
        codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>
    ): PreparedInvocation<Lease, Authority, Domain, PathEpochs> {
        return new PreparedInvocationCodec(codecs).decode(bytes);
    }

    public static create<Lease, Authority, Domain, PathEpochs>(
        init: PreparedInvocationHeaderInit<Lease, Authority, Domain, PathEpochs>,
        payload: UnpreparedPayload,
        codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>
    ): PreparedInvocation<Lease, Authority, Domain, PathEpochs> {
        requireNonemptyPayload(payload);
        const header = canonicalHeader(init, codecs);
        const headerData = encodeHeader(header, codecs);
        const headerDigest = structuralDigest(HEADER_DIGEST_DOMAIN, headerData);
        const shape: JsonValue =
            payload.kind === "single"
                ? { kind: "single" }
                : { itemCount: payload.items.length, kind: "batch" };
        const argumentsList = payload.kind === "single" ? [payload.item] : payload.items;
        const items = argumentsList.map((argumentsValue, itemIndex) => {
            const canonicalArguments = canonicalFacetData(argumentsValue);
            const argumentDigest = Digest.sha256(encodeCanonicalJson(canonicalArguments));
            const keyDigest = Digest.sha256(
                encodeCanonicalJson([
                    ITEM_KEY_DOMAIN,
                    headerDigest.value,
                    shape,
                    itemIndex,
                    argumentDigest.value,
                    header.idempotencySeed
                ])
            );
            return new PreparedItem(canonicalArguments, `${ITEM_KEY_DOMAIN}:${keyDigest.value}`);
        });
        const preparedPayload: PreparedPayload =
            payload.kind === "single"
                ? Object.freeze({ kind: "single", item: items[0]! })
                : Object.freeze({
                      kind: "batch",
                      items: Object.freeze(items) as unknown as readonly [
                          PreparedItem,
                          ...PreparedItem[]
                      ]
                  });
        const intentData = {
            domain: INTENT_DIGEST_DOMAIN,
            header: headerData,
            payload: encodePayload(preparedPayload)
        } as const;
        return new PreparedInvocation(
            header,
            preparedPayload,
            Digest.sha256(encodeCanonicalJson(intentData))
        );
    }

    public get itemCount(): number {
        return this.payload.kind === "single" ? 1 : this.payload.items.length;
    }

    public item(index: number): PreparedItem {
        if (!Number.isSafeInteger(index) || index < 0) {
            throw invocationError(
                "state.invalid-transition",
                "Invocation item index must be a non-negative safe integer"
            );
        }
        const item =
            this.payload.kind === "single"
                ? index === 0
                    ? this.payload.item
                    : undefined
                : this.payload.items[index];
        if (item === undefined) {
            throw invocationError(
                "state.invalid-transition",
                "Invocation item index is out of range"
            );
        }
        return item;
    }
}

export class PreparedInvocationCodec<Lease, Authority, Domain, PathEpochs> extends RecordCodec<
    PreparedInvocation<Lease, Authority, Domain, PathEpochs>
> {
    public constructor(
        private readonly codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>
    ) {
        super("invocation.prepared", { major: 1, minor: 0 });
    }

    protected encodePayload(
        record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>
    ): JsonValue {
        return {
            header: encodeHeader(record.header, this.codecs),
            intentDigest: record.intentDigest.value,
            payload: encodePayload(record.payload)
        };
    }

    protected decodePayload(
        payload: JsonValue,
        _version: RecordVersion
    ): PreparedInvocation<Lease, Authority, Domain, PathEpochs> {
        const object = requireExactObject(
            payload,
            ["header", "intentDigest", "payload"],
            "Prepared invocation"
        );
        const header = decodeHeader(object["header"]!, this.codecs);
        const encodedPayload = decodePayload(object["payload"]!);
        const argumentsPayload: UnpreparedPayload =
            encodedPayload.kind === "single"
                ? { kind: "single", item: encodedPayload.item.arguments }
                : {
                      kind: "batch",
                      items: encodedPayload.items.map(
                          (item) => item.arguments
                      ) as unknown as readonly [FacetData, ...FacetData[]]
                  };
        const record = PreparedInvocation.create(
            {
                id: header.id,
                operation: header.operation,
                domain: header.domain,
                actor: header.actor,
                authority: header.authority,
                pathEpochs: header.pathEpochs,
                ...(header.lease === undefined ? {} : { lease: header.lease }),
                ...(header.route === undefined
                    ? {}
                    : {
                          route: header.route,
                          projectionDigest: header.projectionDigest!
                      }),
                auditCause: header.auditCause,
                idempotencySeed: header.idempotencySeed
            },
            argumentsPayload,
            this.codecs
        );
        if (
            !record.intentDigest.equals(requireDigest(object, "intentDigest")) ||
            !sameJson(encodePayload(record.payload), encodePayload(encodedPayload))
        ) {
            throw new TypeError(
                "Prepared invocation identity does not match its canonical derivation"
            );
        }
        return record;
    }
}

function canonicalHeader<Lease, Authority, Domain, PathEpochs>(
    init: PreparedInvocationHeaderInit<Lease, Authority, Domain, PathEpochs>,
    codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>
): PreparedInvocationHeader<Lease, Authority, Domain, PathEpochs> {
    const actor = new ActorRef(init.actor.kind, new ActorId(init.actor.id.value));
    Object.freeze(actor.id);
    Object.freeze(actor);
    return new PreparedInvocationHeader(
        init.id,
        OperationPin.fromData(init.operation.toData()),
        immutableReference(codecs.domain.decode(codecs.domain.encode(init.domain))),
        actor,
        immutableReference(codecs.authority.decode(codecs.authority.encode(init.authority))),
        immutableReference(codecs.pathEpochs.decode(codecs.pathEpochs.encode(init.pathEpochs))),
        init.lease === undefined
            ? undefined
            : immutableReference(codecs.lease.decode(codecs.lease.encode(init.lease))),
        init.route,
        init.projectionDigest === undefined ? undefined : new Digest(init.projectionDigest.value),
        init.auditCause,
        init.idempotencySeed
    );
}

function encodeHeader<Lease, Authority, Domain, PathEpochs>(
    header: PreparedInvocationHeader<Lease, Authority, Domain, PathEpochs>,
    codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>
): JsonValue {
    return {
        actor: { id: header.actor.id.value, kind: header.actor.kind },
        auditCause: header.auditCause.value,
        authority: codecs.authority.encode(header.authority),
        domain: codecs.domain.encode(header.domain),
        id: header.id.value,
        idempotencySeed: header.idempotencySeed,
        lease: header.lease === undefined ? null : codecs.lease.encode(header.lease),
        operation: header.operation.toData(),
        pathEpochs: codecs.pathEpochs.encode(header.pathEpochs),
        projectionDigest: header.projectionDigest?.value ?? null,
        route: header.route?.value ?? null
    };
}

function decodeHeader<Lease, Authority, Domain, PathEpochs>(
    value: JsonValue,
    codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>
): PreparedInvocationHeader<Lease, Authority, Domain, PathEpochs> {
    const object = requireExactObject(
        value,
        [
            "actor",
            "auditCause",
            "authority",
            "domain",
            "id",
            "idempotencySeed",
            "lease",
            "operation",
            "pathEpochs",
            "projectionDigest",
            "route"
        ],
        "Prepared invocation header"
    );
    const actor = requireExactObject(object["actor"], ["id", "kind"], "Prepared invocation actor");
    const lease = object["lease"];
    const route = object["route"];
    const projectionDigest = object["projectionDigest"];
    if (
        (route === null) !== (projectionDigest === null) ||
        (route !== null && typeof route !== "string") ||
        (projectionDigest !== null && typeof projectionDigest !== "string")
    ) {
        throw new TypeError("Prepared invocation route evidence is malformed");
    }
    return new PreparedInvocationHeader(
        new InvocationId(requireString(object, "id")),
        OperationPin.fromData(object["operation"]!),
        codecs.domain.decode(object["domain"]!),
        new ActorRef(
            requireActorKind(requireString(actor, "kind")),
            new ActorId(requireString(actor, "id"))
        ),
        codecs.authority.decode(object["authority"]!),
        codecs.pathEpochs.decode(object["pathEpochs"]!),
        lease === null ? undefined : codecs.lease.decode(lease!),
        route === null ? undefined : new RouteReservationId(route as string),
        projectionDigest === null ? undefined : new Digest(projectionDigest as string),
        new AuditRecordId(requireString(object, "auditCause")),
        requireString(object, "idempotencySeed")
    );
}

function encodePayload(payload: PreparedPayload): JsonValue {
    return payload.kind === "single"
        ? { item: encodeItem(payload.item), kind: "single" }
        : { items: payload.items.map(encodeItem), kind: "batch" };
}

function encodeItem(item: PreparedItem): JsonValue {
    return { arguments: item.arguments, idempotencyKey: item.idempotencyKey };
}

function decodePayload(value: JsonValue): PreparedPayload {
    const object = requireObject(value, "Prepared invocation payload");
    const kind = object["kind"];
    if (kind === "single") {
        const exact = requireExactObject(object, ["item", "kind"], "Single invocation payload");
        return Object.freeze({ kind, item: decodeItem(exact["item"]!) });
    }
    if (kind === "batch") {
        const exact = requireExactObject(object, ["items", "kind"], "Batch invocation payload");
        const values = requireArray(exact, "items");
        if (values.length === 0) throw new TypeError("Prepared invocation batch must be nonempty");
        return Object.freeze({
            kind,
            items: Object.freeze(values.map(decodeItem)) as unknown as readonly [
                PreparedItem,
                ...PreparedItem[]
            ]
        });
    }
    throw new TypeError("Prepared invocation payload kind is invalid");
}

function decodeItem(value: JsonValue): PreparedItem {
    const object = requireExactObject(value, ["arguments", "idempotencyKey"], "Prepared item");
    return new PreparedItem(object["arguments"]!, requireString(object, "idempotencyKey"));
}

function structuralDigest(domain: string, value: JsonValue): Digest {
    return Digest.sha256(encodeCanonicalJson({ domain, value }));
}

function requireNonemptyPayload(payload: UnpreparedPayload): void {
    if (payload.kind === "batch" && payload.items.length === 0) {
        throw new TypeError("Prepared invocation batch must be nonempty");
    }
}

function requireActorKind(value: string): ActorKind {
    if (
        value === "tenant" ||
        value === "workspace" ||
        value === "run" ||
        value === "environment" ||
        value === "slate"
    )
        return value;
    throw new TypeError("Prepared invocation Actor kind is invalid");
}
