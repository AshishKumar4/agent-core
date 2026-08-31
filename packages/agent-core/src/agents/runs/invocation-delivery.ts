import {
    Digest,
    RecordCodec,
    TextId,
    compareCanonicalText,
    encodeCanonicalJson,
    type JsonValue
} from "../../core";
import { RunCommitId } from "../../execution-references";
import { InvocationId } from "../../interaction-references";
import { EffectAttemptId } from "../../invocation-references";
import {
    CodecRecord,
    requireExactFields,
    requireInteger,
    requireObject,
    requireString
} from "../record-data";
import { RunId } from "./id";

const DELIVERY_DOMAIN = "agent-core.run-invocation-delivery.v1";

/**
 * Why the Run addresses the Invocation owner about one published item (SPEC §5.6).
 *
 * The two cases are separate classes because they carry different facts, not because a
 * reader has to remember what a label means. An admission names nothing else: the Run has
 * taken the item into its own obligation and the Invocation owner may start the work.
 * A cancellation names the terminal commit the Run ended on, so the owner can read the
 * exact terminalization the request came from rather than trust that one happened.
 *
 * Neither case carries a failure kind, and there is no field one could travel in. §7.4
 * builds `aborted` only from cancellation that reached the attempt, and the Run is not the
 * party that observes that: it observes its own end. A request from here is therefore a
 * request, and the Invocation owner's own target observation is what classifies the
 * attempt. A Run that shipped a verdict would be asserting a fact about a live controller
 * it cannot see, including after a restart that left no controller at all.
 */
export abstract class RunInvocationDeliveryCause {
    /** The Run took the published item into its own obligation. */
    public static get admission(): RunInvocationDeliveryCause {
        return admissionCause;
    }

    /** The Run ended at this exact terminal commit while the item was still owed. */
    public static cancellation(terminalCommit: RunCommitId): RunInvocationDeliveryCause {
        return new CancellationCause(terminalCommit);
    }

    public abstract readonly kind: "admission" | "cancellation";

    /** The terminal commit a cancellation names; an admission names none. */
    public abstract readonly terminalCommit: RunCommitId | undefined;

    public abstract toData(): JsonValue;

    public equals(other: RunInvocationDeliveryCause): boolean {
        if (!(other instanceof RunInvocationDeliveryCause) || other.kind !== this.kind) {
            return false;
        }
        const mine = this.terminalCommit;
        return mine === undefined
            ? other.terminalCommit === undefined
            : other.terminalCommit?.equals(mine) === true;
    }

    public static fromData(value: JsonValue): RunInvocationDeliveryCause {
        const object = requireObject(value, "Run invocation delivery cause");
        const kind = requireString(object["kind"], "Run invocation delivery cause kind");
        if (kind === "admission") {
            requireExactFields(object, ["kind"], [], "Run invocation admission cause");
            return RunInvocationDeliveryCause.admission;
        }
        if (kind === "cancellation") {
            requireExactFields(
                object,
                ["kind", "terminalCommit"],
                [],
                "Run invocation cancellation cause"
            );
            return RunInvocationDeliveryCause.cancellation(
                new RunCommitId(
                    requireString(object["terminalCommit"], "Run invocation cancellation commit")
                )
            );
        }
        throw new TypeError("Run invocation delivery cause kind is invalid");
    }
}

/**
 * Exported for one reason: a codec that embeds a delivery seals every class its encoded graph
 * reaches, and the project's codec rule admits only explicitly named classes. Nothing
 * constructs these directly — the factories on the base class are the way in.
 */
export class AdmissionCause extends RunInvocationDeliveryCause {
    public readonly kind = "admission" as const;
    public readonly terminalCommit = undefined;

    public toData(): JsonValue {
        return { kind: this.kind };
    }
}

export class CancellationCause extends RunInvocationDeliveryCause {
    public readonly kind = "cancellation" as const;

    public constructor(public readonly terminalCommit: RunCommitId) {
        super();
        if (terminalCommit.constructor !== RunCommitId) {
            throw new TypeError("Run invocation cancellation names its exact terminal commit");
        }
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return { kind: this.kind, terminalCommit: this.terminalCommit.value };
    }
}

const admissionCause: RunInvocationDeliveryCause = Object.freeze(new AdmissionCause());

export interface RunInvocationDeliveryInit {
    readonly run: RunId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
    readonly cause: RunInvocationDeliveryCause;
}

/**
 * One message the Run owes the Invocation owner about one published item (SPEC §5.6, §6.1).
 *
 * There is no cross-Actor transaction, so a message that existed only in the response to
 * the Run transaction would be lost by a lost response: terminalization cannot run twice on
 * a terminal Run, and publication cannot be replayed from a Turn that has ended. The
 * message is therefore a durable record the Run keeps until the owner acknowledges it, and
 * delivery is at-least-once with the record as the replay source.
 *
 * The identity is derived from every field, so the same publication or the same
 * terminalization produces the same message rather than a second one, and a forged
 * acknowledgement cannot discharge a message the Run never wrote. It names the exact
 * `EffectAttempt` because that is what the owner re-reads its own state against: an item
 * whose attempt has moved on is a different attempt, and this message says nothing about it.
 */
export class RunInvocationDelivery extends CodecRecord {
    public static get codec(): RecordCodec<RunInvocationDelivery> {
        return RunInvocationDeliveryCodec;
    }

    public readonly id: Digest;
    public readonly run: RunId;
    public readonly invocation: InvocationId;
    public readonly itemIndex: number;
    public readonly itemKey: string;
    public readonly attempt: EffectAttemptId;
    public readonly cause: RunInvocationDeliveryCause;

    public constructor(init: RunInvocationDeliveryInit) {
        super();
        if (
            init.run.constructor !== RunId ||
            init.invocation.constructor !== InvocationId ||
            init.attempt.constructor !== EffectAttemptId
        ) {
            throw new TypeError("Run invocation delivery identifiers use exact context classes");
        }
        if (!Number.isSafeInteger(init.itemIndex) || init.itemIndex < 0) {
            throw new TypeError("Run invocation delivery item index is invalid");
        }
        if (init.itemKey.length === 0 || init.itemKey !== init.itemKey.trim()) {
            throw new TypeError("Run invocation delivery item key must be canonical");
        }
        if (!(init.cause instanceof RunInvocationDeliveryCause)) {
            throw new TypeError("Run invocation delivery requires its exact cause");
        }
        this.run = init.run;
        this.invocation = init.invocation;
        this.itemIndex = init.itemIndex;
        this.itemKey = init.itemKey;
        this.attempt = init.attempt;
        this.cause = init.cause;
        this.id = Digest.sha256(
            encodeCanonicalJson({
                attempt: this.attempt.value,
                cause: this.cause.toData(),
                domain: DELIVERY_DOMAIN,
                invocation: this.invocation.value,
                itemIndex: this.itemIndex,
                itemKey: this.itemKey,
                run: this.run.value
            })
        );
        Object.freeze(this.id);
        Object.freeze(this);
    }

    /** Every field decides the identity, so equal identity is equal content. */
    public equals(other: RunInvocationDelivery): boolean {
        return other instanceof RunInvocationDelivery && other.id.equals(this.id);
    }

    public toData(): JsonValue {
        return {
            attempt: this.attempt.value,
            cause: this.cause.toData(),
            id: this.id.value,
            invocation: this.invocation.value,
            itemIndex: this.itemIndex,
            itemKey: this.itemKey,
            run: this.run.value
        };
    }

    public static fromData(value: JsonValue): RunInvocationDelivery {
        const object = requireObject(value, "Run invocation delivery");
        requireExactFields(
            object,
            ["attempt", "cause", "id", "invocation", "itemIndex", "itemKey", "run"],
            [],
            "Run invocation delivery"
        );
        const record = new RunInvocationDelivery({
            run: new RunId(requireString(object["run"], "Run invocation delivery Run")),
            invocation: new InvocationId(
                requireString(object["invocation"], "Run invocation delivery Invocation")
            ),
            itemIndex: requireInteger(object["itemIndex"], "Run invocation delivery item index"),
            itemKey: requireString(object["itemKey"], "Run invocation delivery item key"),
            attempt: new EffectAttemptId(
                requireString(object["attempt"], "Run invocation delivery EffectAttempt")
            ),
            cause: RunInvocationDeliveryCause.fromData(object["cause"] ?? null)
        });
        if (record.id.value !== requireString(object["id"], "Run invocation delivery ID")) {
            throw new TypeError("Run invocation delivery ID does not match its own content");
        }
        return record;
    }
}

class RunInvocationDeliveryRecordCodec extends RecordCodec<RunInvocationDelivery> {
    public constructor() {
        super(
            [
                RunInvocationDelivery,
                RunInvocationDeliveryCause,
                AdmissionCause,
                CancellationCause,
                CodecRecord,
                Digest,
                TextId,
                RunId,
                RunCommitId,
                InvocationId,
                EffectAttemptId
            ],
            "run.invocation-delivery",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(value: RunInvocationDelivery): JsonValue {
        return value.toData();
    }

    protected decodePayload(value: JsonValue): RunInvocationDelivery {
        return RunInvocationDelivery.fromData(value);
    }
}

export const RunInvocationDeliveryCodec: RecordCodec<RunInvocationDelivery> =
    new RunInvocationDeliveryRecordCodec();

/**
 * The Run's pending messages in one canonical order, with no message twice.
 *
 * The order is by derived identity rather than by arrival, because arrival order is not a
 * fact the record keeps and two hosts replaying the same outbox must read the same
 * sequence. Acknowledged messages are removed instead of marked: the message is a command,
 * and what durably records that the command existed is the Run's own admission obligation
 * and terminal snapshot, plus the Invocation owner's Receipt. Keeping discharged commands
 * would grow the Run record without bound and add a second place to ask whether an item
 * was addressed.
 */
export function canonicalDeliveries(
    deliveries: readonly RunInvocationDelivery[]
): readonly RunInvocationDelivery[] {
    const ordered = [...deliveries].sort((left, right) =>
        compareCanonicalText(left.id.value, right.id.value)
    );
    let previous: RunInvocationDelivery | undefined;
    for (const delivery of ordered) {
        if (previous?.id.equals(delivery.id) === true) {
            throw new TypeError("Run invocation delivery outbox holds one message twice");
        }
        previous = delivery;
    }
    return Object.freeze(ordered);
}
