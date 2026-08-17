import { RecordCodec, Revision, isJsonObject, type JsonValue, type RecordVersion } from "../core";
import {
    BindingName,
    ContributionAttribution,
    EventPattern,
    FieldMove,
    OperationRef,
    PayloadMapping,
    dataRecord,
    type DedupePolicy
} from "../facets";
import { AgentCoreError } from "../errors";
import { SubscriptionId } from "../interaction-references";
import {
    decodeRevision,
    encodeRevision,
    requireArray,
    requireFields,
    requireObject,
    requireOptionalFields,
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
    /**
     * SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): present exactly when a Facet's
     * `commands` or `automations` contribution materialized this Subscription, absent when
     * a caller created it directly. Its presence is what puts the Subscription in that
     * Facet's §4.1 withdrawal set.
     */
    readonly contribution?: ContributionAttribution | undefined;
    /**
     * SPEC §4.1: present only on the revision a withdrawal writes, on the same terms as
     * `terminal` on a retired Surface's last View (§6.3). A retired Subscription resolves
     * no further reservation.
     */
    readonly retired?: true | undefined;
}

/**
 * Major 2 carries the §4.2 attribution of the Facet contribution that materialized the
 * Subscription and the §4.1 retirement marker a withdrawal writes. Both are encoded by
 * presence: a Subscription no Facet contributed carries no attribution key, and a live one
 * carries no `retired` key.
 */
class SubscriptionCodecV2 extends RecordCodec<Subscription> {
    public constructor() {
        super("workspace.subscription", { major: 2, minor: 0 });
    }

    protected encodePayload(subscription: Subscription): JsonValue {
        return dataRecord({
            id: subscription.id.value,
            revision: encodeRevision(subscription.revision),
            source: subscription.source.toData(),
            target: subscription.target.value,
            mapping: subscription.mapping.toData(),
            dedupe: subscription.dedupe,
            authority: {
                kind: subscription.authority.kind,
                binding: subscription.authority.binding.value
            },
            contribution: encodeContribution(subscription.contribution),
            retired: subscription.retired
        });
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): Subscription {
        const object = requireObject(payload, "Subscription payload");
        requireOptionalFields(
            object,
            ["authority", "dedupe", "id", "mapping", "revision", "source", "target"],
            ["contribution", "retired"],
            "Subscription payload"
        );
        const authority = requireObject(object["authority"], "Subscription authority");
        requireFields(authority, ["binding", "kind"], "Subscription authority");
        const contribution = object["contribution"];
        const retired = object["retired"];
        if (retired !== undefined && retired !== true) {
            throw new TypeError("Subscription retirement is encoded by presence");
        }
        return new Subscription({
            id: new SubscriptionId(requireString(object["id"], "Subscription ID")),
            revision: decodeRevision(object["revision"], "Subscription revision"),
            source: EventPattern.fromData(object["source"]),
            target: new OperationRef(requireString(object["target"], "Subscription target")),
            mapping: new PayloadMapping(
                requireArray(object["mapping"], "Subscription mapping").map(FieldMove.fromData)
            ),
            dedupe: decodeDedupe(object["dedupe"]),
            authority: decodeAuthority(authority),
            contribution: contribution === undefined ? undefined : decodeContribution(contribution),
            retired: retired === undefined ? undefined : true
        });
    }
}

export class Subscription {
    public static readonly codec: RecordCodec<Subscription> = new SubscriptionCodecV2();

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
    public readonly contribution: ContributionAttribution | undefined;
    public readonly retired: true | undefined;

    public constructor(init: SubscriptionInit) {
        validatePayloadMapping(init.mapping);
        if (init.retired !== undefined && init.retired !== true) {
            throw new TypeError("Subscription retirement is declared by presence");
        }
        if (
            init.contribution !== undefined &&
            !(init.contribution instanceof ContributionAttribution)
        ) {
            throw new TypeError("Subscription contribution must carry canonical attribution");
        }
        this.contribution = init.contribution;
        this.retired = init.retired;
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

    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the retirement revision a withdrawal writes
     * for a Subscription its Facet's `commands` or `automations` contribution materialized.
     */
    public retire(): Subscription {
        if (this.contribution === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Only a contributed Subscription is retired by withdrawal"
            );
        }
        return new Subscription({
            id: this.id,
            revision: this.revision.next(),
            source: this.source,
            target: this.target,
            mapping: this.mapping,
            dedupe: this.dedupe,
            authority: this.authority,
            contribution: this.contribution,
            retired: true
        });
    }
}

function encodeContribution(
    attribution: ContributionAttribution | undefined
): JsonValue | undefined {
    return attribution === undefined
        ? undefined
        : { contributor: attribution.contributor.value, package: attribution.package.toData() };
}

function decodeContribution(value: JsonValue): ContributionAttribution {
    if (!isJsonObject(value)) {
        throw new TypeError("Subscription contribution must be an object");
    }
    return ContributionAttribution.decodeFields(value, "Subscription contribution");
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
