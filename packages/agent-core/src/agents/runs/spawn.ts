import { ContentRef, Digest, RecordCodec, type JsonValue } from "../../core";
import { PrincipalId } from "../../identity";
import { TurnId } from "../../execution-references";
import { ReceiptId } from "../../invocation-references";
import { InvocationId } from "../../interaction-references";
import {
    CodecRecord,
    digestFromData,
    requireExactFields,
    requireInteger,
    requireObject,
    requireString,
    requireTimestamp
} from "../record-data";
import { RunId, SpawnReservationId } from "./id";
import type { LeaseToken } from "./lease";

export class SpawnReservation extends CodecRecord {
    public static get codec(): RecordCodec<SpawnReservation> {
        return SpawnReservationCodec;
    }
    readonly #recordedAt: number;

    public constructor(
        public readonly id: SpawnReservationId,
        public readonly parentRun: RunId,
        public readonly parentTurn: TurnId,
        public readonly childRun: RunId,
        token: LeaseToken,
        public readonly configuration: Digest,
        public readonly rootContent: ContentRef,
        public readonly invocation: InvocationId,
        public readonly receipt: ReceiptId,
        public readonly attenuation: Digest,
        recordedAt: Date
    ) {
        super();
        if (!token.turn.equals(parentTurn)) {
            throw new TypeError("Spawn reservation token must name the spawning Turn");
        }
        if (!Number.isSafeInteger(token.epoch) || token.epoch < 0) {
            throw new TypeError("Spawn reservation token epoch is invalid");
        }
        if (parentRun.equals(childRun)) throw new TypeError("Spawn child Run must be distinct");
        this.token = Object.freeze({ turn: token.turn, holder: token.holder, epoch: token.epoch });
        this.#recordedAt = recordedAt.getTime();
        if (!Number.isFinite(this.#recordedAt))
            throw new TypeError("Spawn reservation time is invalid");
        Object.freeze(this);
    }

    public readonly token: LeaseToken;

    public get recordedAt(): Date {
        return new Date(this.#recordedAt);
    }

    public toData(): JsonValue {
        return {
            attenuation: this.attenuation.value,
            childRun: this.childRun.value,
            configuration: this.configuration.value,
            id: this.id.value,
            invocation: this.invocation.value,
            parentRun: this.parentRun.value,
            parentTurn: this.parentTurn.value,
            receipt: this.receipt.value,
            recordedAt: this.#recordedAt,
            rootContent: this.rootContent.value,
            token: {
                epoch: this.token.epoch,
                holder: this.token.holder.value,
                turn: this.token.turn.value
            }
        };
    }

    public static fromData(value: JsonValue): SpawnReservation {
        const object = requireObject(value, "Spawn reservation");
        requireExactFields(
            object,
            [
                "attenuation",
                "childRun",
                "configuration",
                "id",
                "invocation",
                "parentRun",
                "parentTurn",
                "receipt",
                "recordedAt",
                "rootContent",
                "token"
            ],
            [],
            "Spawn reservation"
        );
        const token = requireObject(object["token"]!, "Spawn token");
        requireExactFields(token, ["epoch", "holder", "turn"], [], "Spawn token");
        return new SpawnReservation(
            new SpawnReservationId(requireString(object["id"], "Spawn reservation ID")),
            new RunId(requireString(object["parentRun"], "Spawn parent Run")),
            new TurnId(requireString(object["parentTurn"], "Spawn parent Turn")),
            new RunId(requireString(object["childRun"], "Spawn child Run")),
            Object.freeze({
                turn: new TurnId(requireString(token["turn"], "Spawn token Turn")),
                holder: new PrincipalId(requireString(token["holder"], "Spawn token holder")),
                epoch: requireInteger(token["epoch"], "Spawn token epoch")
            }),
            digestFromData(object["configuration"], "Spawn configuration"),
            new ContentRef(requireString(object["rootContent"], "Spawn root content")),
            new InvocationId(requireString(object["invocation"], "Spawn Invocation")),
            new ReceiptId(requireString(object["receipt"], "Spawn Receipt")),
            digestFromData(object["attenuation"], "Spawn attenuation"),
            requireTimestamp(object["recordedAt"], "Spawn reservation timestamp")
        );
    }
}

class SpawnCodec extends RecordCodec<SpawnReservation> {
    public constructor() {
        super("run.spawn-reservation", { major: 1, minor: 0 });
    }
    protected encodePayload(value: SpawnReservation): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): SpawnReservation {
        return SpawnReservation.fromData(value);
    }
}

export const SpawnReservationCodec: RecordCodec<SpawnReservation> = new SpawnCodec();

export abstract class RunSpawnPort<Transaction> {
    public abstract verify(transaction: Transaction, reservation: SpawnReservation): boolean;
}
