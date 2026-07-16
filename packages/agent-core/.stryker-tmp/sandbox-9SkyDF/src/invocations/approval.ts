// @ts-nocheck
import { Digest, RecordCodec, Revision, type JsonValue, type RecordVersion } from "../core";
import { AgentCoreError } from "../errors";
import { PrincipalId } from "../identity";
import {
    requireDate,
    requireDigest,
    requireExactObject,
    requireNullableDate,
    requireNullableString,
    requireNonnegativeInteger,
    requireString,
    validDate
} from "./codec";
import { ApprovalId, EffectAttemptId } from "./id";
import { InvocationId } from "../interaction-references";
import { invocationError } from "./error";

export type ApprovalState =
    | { readonly kind: "pending" }
    | { readonly kind: "approved"; readonly by: PrincipalId; readonly at: Date }
    | {
          readonly kind: "denied";
          readonly by: PrincipalId;
          readonly at: Date;
          readonly reason: string;
      }
    | { readonly kind: "expired"; readonly at: Date }
    | {
          readonly kind: "consumed";
          readonly by: PrincipalId;
          readonly approvedAt: Date;
          readonly at: Date;
          readonly firstAttempt: EffectAttemptId;
      };

export class Approval {
    readonly #requestedAt: number;
    readonly #expiresAt: number | undefined;
    readonly #state: ApprovalState;

    public static encode(record: Approval): Uint8Array {
        return ApprovalCodec.encode(record);
    }

    public static decode(bytes: Uint8Array): Approval {
        return ApprovalCodec.decode(bytes);
    }

    public constructor(
        public readonly id: ApprovalId,
        public readonly invocation: InvocationId,
        public readonly intentDigest: Digest,
        requestedAt: Date,
        expiresAt: Date | undefined,
        public readonly revision: Revision,
        state: ApprovalState
    ) {
        if (id.constructor !== ApprovalId || invocation.constructor !== InvocationId) {
            throw new TypeError("Approval identifiers must use exact context classes");
        }
        Object.freeze(intentDigest);
        this.#requestedAt = validDate(requestedAt, "Approval request time");
        this.#expiresAt =
            expiresAt === undefined ? undefined : validDate(expiresAt, "Approval expiry");
        if (this.#expiresAt !== undefined && this.#expiresAt <= this.#requestedAt) {
            throw new TypeError("Approval expiry must be after its request time");
        }
        this.#state = copyState(state);
        validateState(this.#state, this.#requestedAt, this.#expiresAt, revision.value);
        Object.freeze(this);
    }

    public static pending(
        id: ApprovalId,
        invocation: InvocationId,
        intentDigest: Digest,
        requestedAt: Date,
        expiresAt?: Date
    ): Approval {
        return new Approval(
            id,
            invocation,
            intentDigest,
            requestedAt,
            expiresAt,
            Revision.initial(),
            { kind: "pending" }
        );
    }

    public get requestedAt(): Date {
        return new Date(this.#requestedAt);
    }

    public get expiresAt(): Date | undefined {
        return this.#expiresAt === undefined ? undefined : new Date(this.#expiresAt);
    }

    public get state(): ApprovalState {
        return copyState(this.#state);
    }

    public approve(by: PrincipalId, at: Date): Approval {
        this.requirePending("approve");
        this.requireBeforeExpiry(at);
        return this.transition({ kind: "approved", by, at });
    }

    public deny(by: PrincipalId, at: Date, reason: string): Approval {
        this.requirePending("deny");
        this.requireBeforeExpiry(at);
        requireDenialReason(reason);
        return this.transition({ kind: "denied", by, at, reason });
    }

    public expire(at: Date): Approval {
        this.requirePending("expire");
        const expiresAt = this.#expiresAt;
        const time = validDate(at, "Approval expiration time");
        if (expiresAt === undefined || time < expiresAt) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Approval cannot expire before its deadline"
            );
        }
        return this.transition({ kind: "expired", at });
    }

    public consume(firstAttempt: EffectAttemptId, at: Date): Approval {
        if (this.state.kind !== "approved") {
            throw new AgentCoreError(
                "invocation.invalid",
                "Approval consumption requires approved state"
            );
        }
        this.requireBeforeExpiry(at);
        const time = validDate(at, "Approval consumption time");
        if (time < this.state.at.getTime()) {
            throw invocationError(
                "state.invalid-transition",
                "Approval consumption cannot precede approval"
            );
        }
        return this.transition({
            kind: "consumed",
            by: this.state.by,
            approvedAt: this.state.at,
            at,
            firstAttempt
        });
    }

    private transition(state: ApprovalState): Approval {
        return new Approval(
            this.id,
            this.invocation,
            this.intentDigest,
            this.requestedAt,
            this.expiresAt,
            this.revision.next(),
            state
        );
    }

    private requirePending(action: string): void {
        if (this.state.kind !== "pending") {
            throw new AgentCoreError(
                "invocation.invalid",
                `Approval ${action} requires pending state`
            );
        }
    }

    private requireBeforeExpiry(at: Date): void {
        const time = validDate(at, "Approval decision time");
        if (time < this.#requestedAt) {
            throw invocationError(
                "state.invalid-transition",
                "Approval decision cannot precede request"
            );
        }
        if (this.#expiresAt !== undefined && time >= this.#expiresAt) {
            throw new AgentCoreError("invocation.invalid", "Approval decision is past its expiry");
        }
    }
}

class ApprovalRecordCodec extends RecordCodec<Approval> {
    public constructor() {
        super("invocation.approval", { major: 1, minor: 0 });
    }

    protected encodePayload(record: Approval): JsonValue {
        return {
            expiresAt: record.expiresAt?.toISOString() ?? null,
            id: record.id.value,
            intentDigest: record.intentDigest.value,
            invocation: record.invocation.value,
            requestedAt: record.requestedAt.toISOString(),
            revision: record.revision.value,
            state: encodeState(record.state)
        };
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): Approval {
        const object = requireExactObject(
            payload,
            ["expiresAt", "id", "intentDigest", "invocation", "requestedAt", "revision", "state"],
            "Approval"
        );
        return new Approval(
            new ApprovalId(requireString(object, "id")),
            new InvocationId(requireString(object, "invocation")),
            requireDigest(object, "intentDigest"),
            requireDate(object, "requestedAt"),
            requireNullableDate(object, "expiresAt"),
            new Revision(requireNonnegativeInteger(object, "revision")),
            decodeState(object["state"]!)
        );
    }
}

function encodeState(state: ApprovalState): JsonValue {
    switch (state.kind) {
        case "pending":
            return { kind: state.kind };
        case "approved":
            return { at: state.at.toISOString(), by: state.by.value, kind: state.kind };
        case "denied":
            return {
                at: state.at.toISOString(),
                by: state.by.value,
                kind: state.kind,
                reason: state.reason
            };
        case "expired":
            return { at: state.at.toISOString(), kind: state.kind };
        case "consumed":
            return {
                approvedAt: state.approvedAt.toISOString(),
                at: state.at.toISOString(),
                by: state.by.value,
                firstAttempt: state.firstAttempt.value,
                kind: state.kind
            };
    }
}

function decodeState(value: JsonValue): ApprovalState {
    const object = requireExactObjectForState(value);
    const kind = requireString(object, "kind");
    switch (kind) {
        case "pending":
            requireExactObject(value, ["kind"], "Pending approval state");
            return Object.freeze({ kind });
        case "approved": {
            const exact = requireExactObject(value, ["at", "by", "kind"], "Approved state");
            return copyState({
                kind,
                by: new PrincipalId(requireString(exact, "by")),
                at: requireDate(exact, "at")
            });
        }
        case "denied": {
            const exact = requireExactObject(value, ["at", "by", "kind", "reason"], "Denied state");
            return copyState({
                kind,
                by: new PrincipalId(requireString(exact, "by")),
                at: requireDate(exact, "at"),
                reason: requireString(exact, "reason")
            });
        }
        case "expired": {
            const exact = requireExactObject(value, ["at", "kind"], "Expired state");
            return copyState({ kind, at: requireDate(exact, "at") });
        }
        case "consumed": {
            const exact = requireExactObject(
                value,
                ["approvedAt", "at", "by", "firstAttempt", "kind"],
                "Consumed state"
            );
            return copyState({
                kind,
                by: new PrincipalId(requireString(exact, "by")),
                approvedAt: requireDate(exact, "approvedAt"),
                at: requireDate(exact, "at"),
                firstAttempt: new EffectAttemptId(requireString(exact, "firstAttempt"))
            });
        }
        default:
            throw new TypeError("Approval state kind is invalid");
    }
}

function requireExactObjectForState(value: JsonValue): { readonly [key: string]: JsonValue } {
    const object =
        value === null || Array.isArray(value) || typeof value !== "object" ? undefined : value;
    if (
        object === undefined ||
        requireNullableString(object as { readonly [key: string]: JsonValue }, "kind") === undefined
    ) {
        throw new TypeError("Approval state is malformed");
    }
    return object as { readonly [key: string]: JsonValue };
}

function copyState(state: ApprovalState): ApprovalState {
    switch (state.kind) {
        case "pending":
            return Object.freeze({ kind: state.kind });
        case "approved":
            return Object.freeze({ kind: state.kind, by: state.by, at: new Date(state.at) });
        case "denied":
            return Object.freeze({
                kind: state.kind,
                by: state.by,
                at: new Date(state.at),
                reason: state.reason
            });
        case "expired":
            return Object.freeze({ kind: state.kind, at: new Date(state.at) });
        case "consumed":
            return Object.freeze({
                kind: state.kind,
                by: state.by,
                approvedAt: new Date(state.approvedAt),
                at: new Date(state.at),
                firstAttempt: state.firstAttempt
            });
    }
}

function validateState(
    state: ApprovalState,
    requestedAt: number,
    expiresAt: number | undefined,
    revision: number
): void {
    if (state.kind === "pending") {
        if (revision !== 0) throw new TypeError("Pending Approval must have initial revision");
        return;
    }
    const time = validDate(state.at, "Approval state time");
    if (time < requestedAt) throw new TypeError("Approval state cannot precede request");
    if (state.kind === "expired") {
        if (revision !== 1 || expiresAt === undefined || time < expiresAt) {
            throw new TypeError("Expired Approval must be its first transition at or after expiry");
        }
        return;
    }
    if (state.kind === "denied" && state.reason.trim().length === 0) {
        throw new TypeError("Approval denial reason must not be blank");
    }
    if (state.kind === "approved" || state.kind === "denied") {
        if (revision !== 1 || (expiresAt !== undefined && time >= expiresAt)) {
            throw new TypeError("Approval decision must be its first transition before expiry");
        }
        return;
    }
    const approvedAt = validDate(state.approvedAt, "Approval time");
    if (
        revision !== 2 ||
        approvedAt < requestedAt ||
        approvedAt > time ||
        (expiresAt !== undefined && (approvedAt >= expiresAt || time >= expiresAt))
    ) {
        throw new TypeError("Consumed Approval must follow an unexpired approved transition");
    }
}

export const ApprovalCodec: RecordCodec<Approval> = new ApprovalRecordCodec();

function requireDenialReason(reason: string): void {
    if (reason.trim().length === 0) {
        throw new TypeError("Approval denial reason must not be blank");
    }
}
