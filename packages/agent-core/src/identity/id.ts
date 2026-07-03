import { TextId } from "../core";

export class PrincipalId extends TextId {
    public constructor(value: string) {
        super(value, "Principal ID");
    }
}

export class TenantId extends TextId {
    public constructor(value: string) {
        super(value, "Tenant ID");
    }
}

export class MembershipId extends TextId {
    public constructor(value: string) {
        super(value, "Membership ID");
    }
}
