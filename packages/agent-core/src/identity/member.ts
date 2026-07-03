import type { Revision } from "../record";
import type { MembershipId, PrincipalId, TenantId } from "./id";

export type MembershipRole = "owner" | "admin" | "member";

export type MembershipStatus = "active" | "suspended" | "revoked";

export class Membership {
    public constructor(
        public readonly id: MembershipId,
        public readonly tenantId: TenantId,
        public readonly principalId: PrincipalId,
        public readonly role: MembershipRole,
        public readonly status: MembershipStatus,
        public readonly revision: Revision
    ) {
    }

    public get isActive(): boolean {
        return this.status === "active";
    }

    public get isOwner(): boolean {
        return this.role === "owner" && this.isActive;
    }

    public revise(role: MembershipRole, status: MembershipStatus): Membership {
        return new Membership(
            this.id,
            this.tenantId,
            this.principalId,
            role,
            status,
            this.revision.next()
        );
    }
}
