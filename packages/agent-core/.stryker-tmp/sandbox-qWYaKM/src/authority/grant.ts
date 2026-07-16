// @ts-nocheck
import { RecordCodec, type JsonValue, type RecordVersion } from "../core";
import { AgentCoreError } from "../errors";
import { CapabilitySpec, isCapabilityEffect, type CapabilityEffect } from "../facets";
import { MembershipId, type ScopeRef, type SubjectRef } from "../identity";
import {
    requireBoolean,
    requireExact,
    requireObject,
    requireSafeInteger,
    requireString,
    type JsonObject
} from "./data";
import { GrantId } from "./id";
import {
    decodeAuthorityScope,
    decodeAuthoritySubject,
    encodeAuthorityScope,
    encodeAuthoritySubject,
    scopeKey,
    subjectKey
} from "./reference";

export type GrantEffect = CapabilityEffect;

export type GrantOrigin =
    | { readonly kind: "direct" }
    | {
          readonly kind: "role";
          readonly membershipId: MembershipId;
          readonly roleName: string;
          readonly ruleOrdinal: number;
          readonly guest: boolean;
      };

export interface GrantInit {
    readonly id: GrantId;
    readonly scope: ScopeRef;
    readonly subject: SubjectRef;
    readonly effect: GrantEffect;
    readonly capability: CapabilitySpec;
    readonly origin: GrantOrigin;
    readonly attenuationOf?: GrantId;
    readonly state?: GrantState;
}

export abstract class GrantState {
    public static get active(): GrantState {
        return activeGrantState;
    }

    public static get revoked(): GrantState {
        return revokedGrantState;
    }

    public abstract readonly name: "active" | "revoked";
    public abstract revoke(): GrantState;

    public get isActive(): boolean {
        return this.name === "active";
    }
}

class ActiveGrantState extends GrantState {
    public readonly name = "active";
    public revoke(): GrantState {
        return GrantState.revoked;
    }
}

class RevokedGrantState extends GrantState {
    public readonly name = "revoked";
    public revoke(): GrantState {
        return this;
    }
}

const activeGrantState = Object.freeze(new ActiveGrantState());
const revokedGrantState = Object.freeze(new RevokedGrantState());

class GrantCodecV1 extends RecordCodec<Grant> {
    public constructor() {
        super("authority.grant", { major: 1, minor: 0 });
    }

    protected encodePayload(grant: Grant): JsonValue {
        return grant.toData();
    }

    protected decodePayload(payload: JsonValue, _version: RecordVersion): Grant {
        return Grant.fromData(payload);
    }
}

export class Grant {
    public static readonly codec: RecordCodec<Grant> = new GrantCodecV1();
    public readonly state: GrantState;
    public readonly attenuationOf: GrantId | undefined;
    public readonly origin: GrantOrigin;
    public readonly subject: SubjectRef;

    public constructor(
        public readonly id: GrantId,
        public readonly scope: ScopeRef,
        subject: SubjectRef,
        public readonly effect: GrantEffect,
        public readonly capability: CapabilitySpec,
        origin: GrantOrigin,
        attenuationOf?: GrantId,
        state: GrantState = GrantState.active
    ) {
        if (!isCapabilityEffect(effect)) throw new TypeError("Grant effect is invalid");
        if (effect === "deny" && attenuationOf !== undefined) {
            throw new TypeError("Deny Grants cannot be attenuated or delegated");
        }
        validateOrigin(origin);
        this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
        this.origin = Object.freeze({ ...origin });
        this.attenuationOf = attenuationOf;
        this.state = state;
        Object.freeze(this);
    }

    public static create(init: GrantInit): Grant {
        return new Grant(
            init.id,
            init.scope,
            init.subject,
            init.effect,
            init.capability,
            init.origin,
            init.attenuationOf,
            init.state
        );
    }

    public static encode(grant: Grant): Uint8Array {
        return Grant.codec.encode(grant);
    }

    public static decode(bytes: Uint8Array): Grant {
        return Grant.codec.decode(bytes);
    }

    public get isLive(): boolean {
        return this.state.isActive;
    }

    public revoke(): Grant {
        return new Grant(
            this.id,
            this.scope,
            this.subject,
            this.effect,
            this.capability,
            this.origin,
            this.attenuationOf,
            this.state.revoke()
        );
    }

    public canAttenuate(child: Grant): boolean {
        return (
            this.effect === "allow" &&
            (!child.isLive || this.isLive) &&
            this.capability.covers(child.capability) &&
            child.scope.path.some((scope) => scope.equals(this.scope)) &&
            this.scope.path.length <= child.scope.path.length
        );
    }

    public assertCanReplace(next: Grant): void {
        if (
            scopeKey(this.scope) !== scopeKey(next.scope) ||
            subjectKey(this.subject) !== subjectKey(next.subject) ||
            this.attenuationOf?.value !== next.attenuationOf?.value ||
            !sameOriginIdentity(this.origin, next.origin)
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Grant subject, Scope, origin, and attenuation lineage are immutable"
            );
        }
        if (!this.isLive && next.isLive) {
            throw new AgentCoreError("protocol.invalid-state", "Revoked Grants cannot reactivate");
        }
        if (
            this.origin.kind === "direct" &&
            !bytesEqual(Grant.encode(this.revoke()), Grant.encode(next))
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Direct Grants are immutable except for revocation"
            );
        }
    }

    public toData(): JsonObject {
        return {
            attenuationOf: this.attenuationOf?.value ?? null,
            capability: this.capability.toData(),
            effect: this.effect,
            id: this.id.value,
            origin: encodeOrigin(this.origin),
            scope: encodeAuthorityScope(this.scope),
            state: this.state.name,
            subject: encodeAuthoritySubject(this.subject)
        };
    }

    public static fromData(value: JsonValue | undefined): Grant {
        const object = requireObject(value, "Grant");
        requireExact(
            object,
            ["attenuationOf", "capability", "effect", "id", "origin", "scope", "state", "subject"],
            "Grant"
        );
        const attenuation = object["attenuationOf"];
        if (attenuation !== null && typeof attenuation !== "string") {
            throw new TypeError("Grant attenuation parent must be a string or null");
        }
        return new Grant(
            new GrantId(requireString(object, "id", "Grant ID")),
            decodeAuthorityScope(object["scope"]!),
            decodeAuthoritySubject(object["subject"]!),
            requireEffect(object["effect"]),
            CapabilitySpec.fromData(object["capability"]),
            decodeOrigin(object["origin"]),
            attenuation === null ? undefined : new GrantId(attenuation),
            requireState(object["state"])
        );
    }
}

function encodeOrigin(origin: GrantOrigin): JsonObject {
    return origin.kind === "direct"
        ? { kind: origin.kind }
        : {
              guest: origin.guest,
              kind: origin.kind,
              membershipId: origin.membershipId.value,
              roleName: origin.roleName,
              ruleOrdinal: origin.ruleOrdinal
          };
}

function decodeOrigin(value: JsonValue | undefined): GrantOrigin {
    const object = requireObject(value, "Grant origin");
    const kind = requireString(object, "kind", "Grant origin kind");
    if (kind === "direct") {
        requireExact(object, ["kind"], "Direct Grant origin");
        return { kind };
    }
    if (kind === "role") {
        requireExact(
            object,
            ["guest", "kind", "membershipId", "roleName", "ruleOrdinal"],
            "Role Grant origin"
        );
        return {
            kind,
            membershipId: new MembershipId(requireString(object, "membershipId", "Membership ID")),
            roleName: requireString(object, "roleName", "Role name"),
            ruleOrdinal: requireSafeInteger(object, "ruleOrdinal", "Role rule ordinal"),
            guest: requireBoolean(object, "guest", "Role guest flag")
        };
    }
    throw new TypeError("Grant origin kind is invalid");
}

function validateOrigin(origin: GrantOrigin): void {
    if (origin.kind === "direct") return;
    if (
        !(origin.membershipId instanceof MembershipId) ||
        origin.roleName.length === 0 ||
        origin.roleName.length > 256 ||
        !Number.isSafeInteger(origin.ruleOrdinal) ||
        origin.ruleOrdinal < 0
    ) {
        throw new TypeError("Role Grant origin is invalid");
    }
}

function sameOriginIdentity(left: GrantOrigin, right: GrantOrigin): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "direct" || right.kind === "direct") return true;
    return (
        left.membershipId.equals(right.membershipId) &&
        left.ruleOrdinal === right.ruleOrdinal &&
        left.guest === right.guest
    );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function requireEffect(value: JsonValue | undefined): GrantEffect {
    if (isCapabilityEffect(value)) return value;
    throw new TypeError("Grant effect is invalid");
}

function requireState(value: JsonValue | undefined): GrantState {
    if (value === "active") return GrantState.active;
    if (value === "revoked") return GrantState.revoked;
    throw new TypeError("Grant state is invalid");
}
