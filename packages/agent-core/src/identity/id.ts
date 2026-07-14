import { TextId } from "../core";

export class PrincipalId extends TextId {
    public constructor(value: string) {
        super(value, "Principal ID");
    }
}

export class TeamId extends TextId {
    public constructor(value: string) {
        super(value, "Team ID");
    }
}

export class TenantId extends TextId {
    public constructor(value: string) {
        super(value, "Tenant ID");
    }
}

export class ProjectId extends TextId {
    public constructor(value: string) {
        super(value, "Project ID");
    }
}

export class WorkspaceId extends TextId {
    public constructor(value: string) {
        super(value, "Workspace ID");
    }
}

export class MembershipId extends TextId {
    public constructor(value: string) {
        super(value, "Membership ID");
    }
}

export class GuestTrustId extends TextId {
    public constructor(value: string) {
        super(value, "Guest trust ID");
    }
}

export class RoleName extends TextId {
    public constructor(value: string) {
        super(value, "Role name");
        if (value.trim() !== value || value.trim().length === 0) {
            throw new TypeError("Role name must be a nonblank canonical string");
        }
    }
}
