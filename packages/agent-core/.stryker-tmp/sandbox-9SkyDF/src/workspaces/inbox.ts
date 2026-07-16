// @ts-nocheck
import { RecordCodec, type JsonValue, type RecordVersion } from "../core";
import { TurnId } from "../execution-references";
import { EventId } from "../interaction-references";
import { requireFields, requireInteger, requireObject, requireString } from "./codec";
import { InboxReferenceId } from "./id";

export interface InboxEventReferenceInit {
    readonly id: InboxReferenceId;
    readonly turn: TurnId;
    readonly event: EventId;
    readonly sequence: number;
    readonly leaseEpoch: number;
}

class InboxEventReferenceCodecV1 extends RecordCodec<InboxEventReference> {
    public constructor() {
        super("workspace.inbox-reference", { major: 1, minor: 0 });
    }

    protected encodePayload(reference: InboxEventReference): JsonValue {
        return {
            id: reference.id.value,
            turn: reference.turn.value,
            event: reference.event.value,
            sequence: reference.sequence,
            leaseEpoch: reference.leaseEpoch
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): InboxEventReference {
        const object = requireObject(payload, "Inbox reference payload");
        requireFields(
            object,
            ["event", "id", "leaseEpoch", "sequence", "turn"],
            "Inbox reference payload"
        );
        return new InboxEventReference({
            id: new InboxReferenceId(requireString(object["id"], "Inbox reference ID")),
            turn: new TurnId(requireString(object["turn"], "Inbox Turn ID")),
            event: new EventId(requireString(object["event"], "Inbox Event ID")),
            sequence: requireInteger(object["sequence"], "Inbox sequence"),
            leaseEpoch: requireInteger(object["leaseEpoch"], "Inbox lease epoch")
        });
    }
}

export class InboxEventReference {
    public static readonly codec: RecordCodec<InboxEventReference> =
        new InboxEventReferenceCodecV1();

    public static encode(reference: InboxEventReference): Uint8Array {
        return InboxEventReference.codec.encode(reference);
    }

    public static decode(bytes: Uint8Array): InboxEventReference {
        return InboxEventReference.codec.decode(bytes);
    }

    public readonly init: InboxEventReferenceInit;

    public constructor(init: InboxEventReferenceInit) {
        if (
            !Number.isSafeInteger(init.sequence) ||
            init.sequence < 0 ||
            !Number.isSafeInteger(init.leaseEpoch) ||
            init.leaseEpoch < 0
        ) {
            throw new TypeError(
                "Inbox sequence and lease epoch must be non-negative safe integers"
            );
        }
        this.init = Object.freeze({ ...init });
        Object.freeze(this);
    }

    public get id(): InboxReferenceId {
        return this.init.id;
    }
    public get turn(): TurnId {
        return this.init.turn;
    }
    public get event(): EventId {
        return this.init.event;
    }
    public get sequence(): number {
        return this.init.sequence;
    }
    public get leaseEpoch(): number {
        return this.init.leaseEpoch;
    }
}
