// @ts-nocheck
import { RecordCodec, Revision, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import {
    requireIdentityFields,
    requireIdentityObject,
    requireIdentityRevision,
    requireIdentityString
} from "./codec";
import { MembershipId, RoleName } from "./id";
import {
    GuestVerification,
    isFreshGuestVerification,
    isRestoredGuestVerification,
    restoreGuestVerification
} from "./guest-verification";
import { decodeScopeRef, encodeScopeRef, type ScopeRef } from "./scope";
import { decodeSubjectRef, encodeSubjectRef, type SubjectRef } from "./subject";

export type MembershipState = "active" | "suspended" | "revoked";

abstract class MembershipLifecycle {
    public abstract readonly state: MembershipState;
    public abstract transition(next: MembershipState): MembershipLifecycle;
    public static from(state: MembershipState): MembershipLifecycle {
        if (state === "active") return activeMembership;
        if (state === "suspended") return suspendedMembership;
        return revokedMembership;
    }
}

class ActiveMembershipLifecycle extends MembershipLifecycle {
    public readonly state = "active" as const;
    public transition(next: MembershipState): MembershipLifecycle {
        return MembershipLifecycle.from(next);
    }
}

class SuspendedMembershipLifecycle extends MembershipLifecycle {
    public readonly state = "suspended" as const;
    public transition(next: MembershipState): MembershipLifecycle {
        if (next === "active") {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Suspended Memberships require replacement rather than reactivation"
            );
        }
        return MembershipLifecycle.from(next);
    }
}

class RevokedMembershipLifecycle extends MembershipLifecycle {
    public readonly state = "revoked" as const;
    public transition(next: MembershipState): MembershipLifecycle {
        if (next !== "revoked") {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "A revoked Membership cannot be reactivated"
            );
        }
        return this;
    }
}

const activeMembership = Object.freeze(new ActiveMembershipLifecycle());
const suspendedMembership = Object.freeze(new SuspendedMembershipLifecycle());
const revokedMembership = Object.freeze(new RevokedMembershipLifecycle());
const restoredMembershipToken = Object.freeze({});

class MembershipRecordCodec extends RecordCodec<Membership> {
    public constructor() {
        super("identity.membership", { major: 1, minor: 0 });
    }

    protected encodePayload(membership: Membership): JsonValue {
        return {
            id: membership.id.value,
            guestVerification: membership.guestVerification?.toData() ?? null,
            revision: membership.revision.value,
            role: membership.role.value,
            scope: encodeScopeRef(membership.scope),
            state: membership.state,
            subject: encodeSubjectRef(membership.subject)
        };
    }

    protected decodePayload(payload: JsonValue): Membership {
        const object = requireIdentityObject(payload, "Membership payload");
        requireIdentityFields(
            object,
            ["guestVerification", "id", "revision", "role", "scope", "state", "subject"],
            "Membership payload"
        );
        const guestVerification = object["guestVerification"];
        return new Membership(
            new MembershipId(requireIdentityString(object["id"], "Membership ID")),
            decodeScopeRef(object["scope"]!),
            decodeSubjectRef(object["subject"]!),
            new RoleName(requireIdentityString(object["role"], "Membership role")),
            requireMembershipState(object["state"]),
            requireIdentityRevision(object["revision"], "Membership revision"),
            guestVerification === null ? undefined : restoreGuestVerification(guestVerification!),
            restoredMembershipToken
        );
    }
}

export class Membership {
    public static readonly codec: RecordCodec<Membership> = new MembershipRecordCodec();
    readonly #lifecycle: MembershipLifecycle;
    public readonly subject: SubjectRef;

    public constructor(
        public readonly id: MembershipId,
        public readonly scope: ScopeRef,
        subject: SubjectRef,
        public readonly role: RoleName,
        state: MembershipState,
        public readonly revision: Revision,
        public readonly guestVerification?: GuestVerification,
        internalToken?: object
    ) {
        this.#lifecycle = MembershipLifecycle.from(requireMembershipState(state));
        this.subject = decodeSubjectRef(encodeSubjectRef(subject));
        if ((subject.kind === "foreign") !== (guestVerification !== undefined)) {
            if (guestVerification !== undefined) {
                throw new TypeError("Only foreign Memberships may carry guest verification");
            }
        }
        if (
            subject.kind === "foreign" &&
            guestVerification !== undefined &&
            !guestVerification.admits(subject, guestVerification.verifiedAt)
        ) {
            throw new TypeError("Membership guest verification does not match its subject");
        }
        if (
            guestVerification !== undefined &&
            !isFreshGuestVerification(guestVerification) &&
            !(
                internalToken === restoredMembershipToken &&
                isRestoredGuestVerification(guestVerification)
            )
        ) {
            throw new TypeError("Membership guest verification lacks host provenance");
        }
        Object.freeze(this);
    }

    public static encode(membership: Membership): Uint8Array {
        return Membership.codec.encode(membership);
    }

    public static decode(bytes: Uint8Array): Membership {
        return Membership.codec.decode(bytes);
    }

    public get isActive(): boolean {
        return this.#lifecycle.state === "active";
    }

    public get state(): MembershipState {
        return this.#lifecycle.state;
    }

    public revise(role: RoleName, state: MembershipState): Membership {
        if (state !== "active" && state !== "suspended" && state !== "revoked") {
            throw new AgentCoreError("protocol.invalid-state", "Membership state is invalid");
        }
        const lifecycle = this.#lifecycle.transition(state);
        if (this.revision.value === Number.MAX_SAFE_INTEGER) {
            throw new AgentCoreError("protocol.invalid-state", "Membership revision is exhausted");
        }
        return new Membership(
            this.id,
            this.scope,
            this.subject,
            role,
            lifecycle.state,
            this.revision.next(),
            this.guestVerification,
            isRestoredGuestVerification(this.guestVerification!)
                ? restoredMembershipToken
                : undefined
        );
    }

    public withGuestVerification(verification: GuestVerification): Membership {
        if (
            this.subject.kind !== "foreign" ||
            this.guestVerification !== undefined ||
            !isFreshGuestVerification(verification) ||
            !verification.admits(this.subject, verification.verifiedAt)
        ) {
            throw new AgentCoreError(
                "authority.denied",
                "Guest verification does not match an unverified foreign Membership"
            );
        }
        return new Membership(
            this.id,
            this.scope,
            this.subject,
            this.role,
            this.state,
            this.revision,
            verification
        );
    }

    public suspend(): Membership {
        return this.revise(this.role, "suspended");
    }

    public activate(): Membership {
        return this.revise(this.role, "active");
    }

    public revoke(): Membership {
        return this.revise(this.role, "revoked");
    }
}

function requireMembershipState(value: JsonValue | undefined): MembershipState {
    if (value === "active" || value === "suspended" || value === "revoked") {
        return value;
    }
    throw new TypeError("Membership state is invalid");
}
