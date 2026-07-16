// @ts-nocheck
import { RecordCodec, Revision, type JsonValue, type RecordVersion } from "../core";
import {
    BindingName,
    EventPattern,
    FieldMove,
    OperationRef,
    PayloadMapping,
    type DedupePolicy
} from "../facets";
import { SubscriptionId } from "../interaction-references";
import {
    decodeRevision,
    encodeRevision,
    requireArray,
    requireFields,
    requireObject,
    requireString
} from "./codec";
import { validatePayloadMapping } from "./policy";
import type { RouteAuthority } from "./value";

export interface SubscriptionInit {
    readonly id: SubscriptionId;
    readonly revision: Revision;
    readonly source: EventPattern;
    readonly target: OperationRef;
    readonly mapping: PayloadMapping;
    readonly dedupe: DedupePolicy;
    readonly authority: RouteAuthority;
}

class SubscriptionCodecV1 extends RecordCodec<Subscription> {
    public constructor() {
        super("workspace.subscription", { major: 1, minor: 0 });
    }

    protected encodePayload(subscription: Subscription): JsonValue {
        return {
            id: subscription.id.value,
            revision: encodeRevision(subscription.revision),
            source: subscription.source.toData(),
            target: subscription.target.value,
            mapping: subscription.mapping.toData(),
            dedupe: subscription.dedupe,
            authority: {
                kind: subscription.authority.kind,
                binding: subscription.authority.binding.value
            }
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): Subscription {
        const object = requireObject(payload, "Subscription payload");
        requireFields(
            object,
            ["authority", "dedupe", "id", "mapping", "revision", "source", "target"],
            "Subscription payload"
        );
        const authority = requireObject(object["authority"]!, "Subscription authority");
        requireFields(authority, ["binding", "kind"], "Subscription authority");
        return new Subscription({
            id: new SubscriptionId(requireString(object["id"], "Subscription ID")),
            revision: decodeRevision(object["revision"], "Subscription revision"),
            source: EventPattern.fromData(object["source"]!),
            target: new OperationRef(requireString(object["target"], "Subscription target")),
            mapping: new PayloadMapping(
                requireArray(object["mapping"], "Subscription mapping").map(FieldMove.fromData)
            ),
            dedupe: decodeDedupe(object["dedupe"]),
            authority: decodeAuthority(authority)
        });
    }
}

export class Subscription {
    public static readonly codec: RecordCodec<Subscription> = new SubscriptionCodecV1();

    public static encode(subscription: Subscription): Uint8Array {
        return Subscription.codec.encode(subscription);
    }

    public static decode(bytes: Uint8Array): Subscription {
        return Subscription.codec.decode(bytes);
    }

    public readonly id: SubscriptionId;
    public readonly revision: Revision;
    public readonly source: EventPattern;
    public readonly target: OperationRef;
    public readonly mapping: PayloadMapping;
    public readonly dedupe: DedupePolicy;
    public readonly authority: RouteAuthority;

    public constructor(init: SubscriptionInit) {
        validatePayloadMapping(init.mapping);
        this.id = init.id;
        this.revision = init.revision;
        this.source = EventPattern.decode(EventPattern.encode(init.source));
        this.target = init.target;
        this.mapping = PayloadMapping.decode(PayloadMapping.encode(init.mapping));
        this.dedupe = init.dedupe;
        this.authority = Object.freeze({
            kind: init.authority.kind,
            binding: init.authority.binding
        });
        Object.freeze(this);
    }

    public revise(init: Omit<SubscriptionInit, "id" | "revision">): Subscription {
        return new Subscription({
            ...init,
            id: this.id,
            revision: this.revision.next()
        });
    }
}

function decodeDedupe(value: JsonValue | undefined): DedupePolicy {
    if (value === "none" || value === "event" || value === "causation" || value === "payload") {
        return value;
    }
    throw new TypeError("Subscription dedupe policy is invalid");
}

function decodeAuthority(value: { readonly [key: string]: JsonValue }): RouteAuthority {
    const kind = value["kind"];
    if (kind !== "initiator" && kind !== "delegated") {
        throw new TypeError("Subscription authority kind is invalid");
    }
    return {
        kind,
        binding: new BindingName(requireString(value["binding"], "Subscription binding"))
    };
}
