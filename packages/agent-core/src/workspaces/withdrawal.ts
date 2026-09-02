import {
    Digest,
    RecordCodec,
    SemVer,
    TextId,
    canonicalTupleKey,
    compareCanonicalText,
    isJsonObject,
    type JsonValue,
    type RecordVersion
} from "../core";
import { PackageId, PackagePin } from "../definition-references";
import { ContributionAttribution, FacetPackageId, FacetRef } from "../facets";
import {
    InvocationId,
    type AuditRecordId,
    type RouteReservationId,
    type SubscriptionId
} from "../interaction-references";
import { requireArray, requireFields, requireObject, requireString } from "./codec";
import type { WorkspacePersistence } from "./persistence";
import type { Subscription } from "./subscription";

/** The routing records one withdrawal retired, and the reservations it terminated. */
export interface RoutingWithdrawal {
    readonly subscriptions: readonly SubscriptionId[];
    readonly rejected: readonly RouteReservationId[];
}

/** Mints the audit identity the owning Actor writes each terminal rejection under. */
export interface RoutingWithdrawalAuditPort {
    deliveryAudit(): AuditRecordId;
}

export const WITHDRAWN_TARGET_REASON = "facet-withdrawn";

/**
 * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the routing Actor's half of a withdrawal. It
 * retires the Subscriptions the named `ContributionAttribution` — the exact FacetRef and
 * PackagePin pair — materialized, so no further reservation is appended against an
 * unresolvable target, and it admits every reservation already appended and not yet
 * prepared to a terminal rejected RouteDelivery. A reservation that reached preparation is
 * left alone: it drains as an Invocation item under C13-FACET-WITHDRAWAL-DRAIN. Another
 * release of the same Facet is a different contribution and owns a different withdrawal.
 */
export class WorkspaceRoutingWithdrawal<Transaction> {
    public constructor(
        private readonly persistence: WorkspacePersistence<Transaction>,
        private readonly audits: RoutingWithdrawalAuditPort
    ) {}

    public contributed(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): readonly Subscription[] {
        return this.persistence.listContributedSubscriptions(transaction, attribution);
    }

    public retire(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): RoutingWithdrawal {
        const contributed = this.contributed(transaction, attribution);
        const retired = new Set(contributed.map((subscription) => subscription.id.value));
        for (const subscription of contributed) {
            this.persistence.retireSubscription(transaction, subscription);
        }
        const rejected: RouteReservationId[] = [];
        for (const reservation of this.persistence.listReservations(transaction)) {
            if (!retired.has(reservation.subscription.value)) continue;
            if (this.persistence.findDelivery(transaction, reservation.id) !== undefined) continue;
            if (
                this.persistence.findProjectionByReservation(transaction, reservation.id) !==
                undefined
            ) {
                continue;
            }
            this.persistence.appendWithdrawalRejection(
                transaction,
                reservation,
                this.audits.deliveryAudit(),
                WITHDRAWN_TARGET_REASON
            );
            rejected.push(reservation.id);
        }
        return Object.freeze({
            subscriptions: Object.freeze(contributed.map((subscription) => subscription.id)),
            rejected: Object.freeze(rejected)
        });
    }
}

/**
 * SPEC §4.1 (C13-FACET-WITHDRAWAL-DRAIN): the Workspace Actor's durable capture of one
 * withdrawal's drain set. The transaction that begins a withdrawal stops admitting
 * Invocations against the withdrawing Facet, so the admitted items are finite at that
 * transaction and never grow; this record is that set, frozen, written in the same
 * transaction that retires the records. A later completion attempt reads the captured items
 * rather than querying again — a host can neither report completion by discarding a live
 * item nor be held open by an item admitted after admission stopped — and a later admission
 * reads the capture to refuse the release it names, which is what makes the stop survive a
 * restart instead of living only inside the transaction that froze the set.
 *
 * The captured items carry no terminality. Whether an item has reached a terminal current
 * Receipt is the Invocation plane's answer (§7.4), read at each completion attempt, so this
 * record holds no second copy of Receipt state (§8.4).
 */
export class WithdrawalDrainCapture {
    public static get codec(): RecordCodec<WithdrawalDrainCapture> {
        return withdrawalDrainCaptureCodecInstance;
    }

    public static encode(capture: WithdrawalDrainCapture): Uint8Array {
        return WithdrawalDrainCapture.codec.encode(capture);
    }

    public static decode(bytes: Uint8Array): WithdrawalDrainCapture {
        return WithdrawalDrainCapture.codec.decode(bytes);
    }

    /** The record key of the withdrawal of one exact contribution: FacetRef and PackagePin. */
    public static keyFor(attribution: ContributionAttribution): string {
        return canonicalTupleKey("workspace.withdrawal-drain", [
            attribution.contributor.value,
            attribution.package.toData()
        ]);
    }

    public readonly attribution: ContributionAttribution;
    public readonly items: readonly InvocationId[];

    public constructor(attribution: ContributionAttribution, items: readonly InvocationId[]) {
        if (!(attribution instanceof ContributionAttribution)) {
            throw new TypeError("Withdrawal drain capture requires its contribution attribution");
        }
        for (const item of items) {
            if (item.constructor !== InvocationId) {
                throw new TypeError("Withdrawal drain capture holds exact InvocationIds");
            }
        }
        this.attribution = attribution;
        this.items = Object.freeze(
            [...new Map(items.map((item) => [item.value, item])).values()].sort((left, right) =>
                compareCanonicalText(left.value, right.value)
            )
        );
        Object.freeze(this);
    }

    public get key(): string {
        return WithdrawalDrainCapture.keyFor(this.attribution);
    }

    /** True exactly when the captured set names this item, so nothing else can drain here. */
    public captures(item: InvocationId): boolean {
        return this.items.some((captured) => captured.equals(item));
    }
}

class WithdrawalDrainCaptureCodecV1 extends RecordCodec<WithdrawalDrainCapture> {
    public constructor() {
        super(
            [
                WithdrawalDrainCapture,
                ContributionAttribution,
                InvocationId,
                TextId,
                FacetRef,
                FacetPackageId,
                PackageId,
                PackagePin,
                Digest,
                SemVer
            ],
            "workspace.withdrawal-drain-capture",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(capture: WithdrawalDrainCapture): JsonValue {
        return {
            contribution: {
                contributor: capture.attribution.contributor.value,
                package: capture.attribution.package.toData()
            },
            items: capture.items.map((item) => item.value)
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): WithdrawalDrainCapture {
        const object = requireObject(payload, "Withdrawal drain capture payload");
        requireFields(object, ["contribution", "items"], "Withdrawal drain capture payload");
        const contribution = object["contribution"];
        if (!isJsonObject(contribution)) {
            throw new TypeError("Withdrawal drain capture contribution must be an object");
        }
        return new WithdrawalDrainCapture(
            ContributionAttribution.decodeFields(
                contribution,
                "Withdrawal drain capture contribution"
            ),
            requireArray(object["items"], "Withdrawal drain capture items").map(
                (item, index) =>
                    new InvocationId(requireString(item, `Withdrawal drain item ${index}`))
            )
        );
    }
}

const withdrawalDrainCaptureCodecInstance = new WithdrawalDrainCaptureCodecV1();
