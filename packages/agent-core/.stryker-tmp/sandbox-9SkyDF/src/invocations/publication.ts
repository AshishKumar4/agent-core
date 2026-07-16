// @ts-nocheck
import {
    Digest,
    RecordCodec,
    Revision,
    encodeCanonicalJson,
    type JsonValue,
    type RecordVersion
} from "../core";
import {
    requireDate,
    requireExactObject,
    requireNonnegativeInteger,
    requireString,
    validDate
} from "./codec";
import { ReceiptId } from "./id";
import { AuditRecordId, InvocationId } from "../interaction-references";
import type { ReceiptObservation } from "./ports";
import { invocationError } from "./error";

const PUBLICATION_ID_DOMAIN = "agent-core.invocation-publication.v1";

export type InvocationPublicationState =
    | {
          readonly kind: "pending";
          readonly eventPublishedAt?: Date;
          readonly commitAppendedAt?: Date;
      }
    | {
          readonly kind: "published";
          readonly eventPublishedAt: Date;
          readonly commitAppendedAt: Date;
      };

export class InvocationPublicationOutbox {
    public readonly id: Digest;
    readonly #state: InvocationPublicationState;

    public constructor(
        public readonly observation: ReceiptObservation,
        state: InvocationPublicationState,
        public readonly revision: Revision
    ) {
        this.id = Digest.sha256(
            encodeCanonicalJson({
                domain: PUBLICATION_ID_DOMAIN,
                audit: observation.audit.value,
                invocation: observation.invocation.value,
                receipt: observation.receipt.value
            })
        );
        this.#state = copyState(state);
        const acknowledgements =
            Number(state.eventPublishedAt !== undefined) +
            Number(state.commitAppendedAt !== undefined);
        if (
            revision.value !== acknowledgements ||
            (state.kind === "published") !== (acknowledgements === 2)
        ) {
            throw new TypeError("Invocation publication revision does not match its state");
        }
        Object.freeze(this.id);
        Object.freeze(this);
    }

    public static pending(observation: ReceiptObservation): InvocationPublicationOutbox {
        return new InvocationPublicationOutbox(
            observation,
            { kind: "pending" },
            Revision.initial()
        );
    }

    public static encode(record: InvocationPublicationOutbox): Uint8Array {
        return InvocationPublicationOutboxCodec.encode(record);
    }

    public static decode(bytes: Uint8Array): InvocationPublicationOutbox {
        return InvocationPublicationOutboxCodec.decode(bytes);
    }

    public get state(): InvocationPublicationState {
        return copyState(this.#state);
    }

    public eventPublished(at: Date): InvocationPublicationOutbox {
        return this.acknowledge("event", at);
    }

    public commitAppended(at: Date): InvocationPublicationOutbox {
        return this.acknowledge("commit", at);
    }

    public follows(current: InvocationPublicationOutbox): boolean {
        const previous = current.state;
        const next = this.#state;
        const addedEvent =
            previous.eventPublishedAt === undefined && next.eventPublishedAt !== undefined;
        const addedCommit =
            previous.commitAppendedAt === undefined && next.commitAppendedAt !== undefined;
        return (
            this.id.equals(current.id) &&
            this.revision.value === current.revision.value + 1 &&
            addedEvent !== addedCommit &&
            sameTime(previous.eventPublishedAt, next.eventPublishedAt, addedEvent) &&
            sameTime(previous.commitAppendedAt, next.commitAppendedAt, addedCommit)
        );
    }

    private acknowledge(sink: "event" | "commit", at: Date): InvocationPublicationOutbox {
        const state = this.#state;
        if (
            state.kind === "published" ||
            (sink === "event" ? state.eventPublishedAt : state.commitAppendedAt) !== undefined
        ) {
            throw invocationError(
                "state.invalid-transition",
                `Invocation ${sink} publication acknowledgement is immutable`
            );
        }
        const eventPublishedAt = sink === "event" ? at : state.eventPublishedAt;
        const commitAppendedAt = sink === "commit" ? at : state.commitAppendedAt;
        return new InvocationPublicationOutbox(
            this.observation,
            eventPublishedAt !== undefined && commitAppendedAt !== undefined
                ? { kind: "published", eventPublishedAt, commitAppendedAt }
                : {
                      kind: "pending",
                      ...(eventPublishedAt === undefined ? {} : { eventPublishedAt }),
                      ...(commitAppendedAt === undefined ? {} : { commitAppendedAt })
                  },
            this.revision.next()
        );
    }
}

class InvocationPublicationOutboxCodecV1 extends RecordCodec<InvocationPublicationOutbox> {
    public constructor() {
        super("invocation.publication-outbox", { major: 1, minor: 0 });
    }

    protected encodePayload(record: InvocationPublicationOutbox): JsonValue {
        const state = record.state;
        return {
            audit: record.observation.audit.value,
            id: record.id.value,
            invocation: record.observation.invocation.value,
            receipt: record.observation.receipt.value,
            revision: record.revision.value,
            state: {
                commitAppendedAt: state.commitAppendedAt?.toISOString() ?? null,
                eventPublishedAt: state.eventPublishedAt?.toISOString() ?? null,
                kind: state.kind
            }
        };
    }

    protected decodePayload(
        payload: JsonValue,
        _version: RecordVersion
    ): InvocationPublicationOutbox {
        const object = requireExactObject(
            payload,
            ["audit", "id", "invocation", "receipt", "revision", "state"],
            "Invocation publication outbox"
        );
        const stateValue = object["state"]!;
        const state = requireExactObject(
            stateValue,
            ["commitAppendedAt", "eventPublishedAt", "kind"],
            "Invocation publication state"
        );
        const kind = requireString(state, "kind");
        const eventValue = state["eventPublishedAt"];
        const commitValue = state["commitAppendedAt"];
        if (
            (eventValue !== null && typeof eventValue !== "string") ||
            (commitValue !== null && typeof commitValue !== "string")
        ) {
            throw new TypeError("Publication acknowledgement times must be strings or null");
        }
        const eventPublishedAt =
            eventValue === null ? undefined : requireDate(state, "eventPublishedAt");
        const commitAppendedAt =
            commitValue === null ? undefined : requireDate(state, "commitAppendedAt");
        const record = new InvocationPublicationOutbox(
            Object.freeze({
                invocation: new InvocationId(requireString(object, "invocation")),
                receipt: new ReceiptId(requireString(object, "receipt")),
                audit: new AuditRecordId(requireString(object, "audit"))
            }),
            kind === "pending"
                ? {
                      kind,
                      ...(eventPublishedAt === undefined ? {} : { eventPublishedAt }),
                      ...(commitAppendedAt === undefined ? {} : { commitAppendedAt })
                  }
                : kind === "published" &&
                    eventPublishedAt !== undefined &&
                    commitAppendedAt !== undefined
                  ? { kind, eventPublishedAt, commitAppendedAt }
                  : invalidState(),
            new Revision(requireNonnegativeInteger(object, "revision"))
        );
        if (record.id.value !== requireString(object, "id")) {
            throw new TypeError("Invocation publication ID does not match its observation");
        }
        return record;
    }
}

function copyState(state: InvocationPublicationState): InvocationPublicationState {
    const eventPublishedAt = copyDate(state.eventPublishedAt, "Event publication time");
    const commitAppendedAt = copyDate(state.commitAppendedAt, "Commit append time");
    return state.kind === "pending"
        ? Object.freeze({
              kind: state.kind,
              ...(eventPublishedAt === undefined ? {} : { eventPublishedAt }),
              ...(commitAppendedAt === undefined ? {} : { commitAppendedAt })
          })
        : Object.freeze({
              kind: state.kind,
              eventPublishedAt: eventPublishedAt!,
              commitAppendedAt: commitAppendedAt!
          });
}

function copyDate(value: Date | undefined, subject: string): Date | undefined {
    return value === undefined ? undefined : new Date(validDate(value, subject));
}

function sameTime(previous: Date | undefined, next: Date | undefined, added: boolean): boolean {
    return added
        ? previous === undefined && next !== undefined
        : previous?.getTime() === next?.getTime();
}

function invalidState(): never {
    throw invocationError("state.invalid-transition", "Invocation publication state is invalid");
}

export const InvocationPublicationOutboxCodec: RecordCodec<InvocationPublicationOutbox> =
    new InvocationPublicationOutboxCodecV1();
