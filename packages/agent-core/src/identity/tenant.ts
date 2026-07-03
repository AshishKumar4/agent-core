import type { Revision } from "../record";
import type { TenantId } from "./id";

export type TenantKind = "personal" | "organization" | "service";

export type TenantStatus = "active" | "suspended" | "deleted";

export class Tenant {
    public constructor(
        public readonly id: TenantId,
        public readonly kind: TenantKind,
        public readonly status: TenantStatus,
        public readonly authorizationRevision: Revision
    ) {
    }

    public get acceptsMutation(): boolean {
        return this.status === "active";
    }

    public revise(status: TenantStatus): Tenant {
        return new Tenant(this.id, this.kind, status, this.authorizationRevision.next());
    }
}
