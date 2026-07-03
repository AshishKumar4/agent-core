import type { ProtectionDomain } from "../facets";
import type { Revision } from "../record";
import type { GrantId } from "./id";

export type GrantStatus = "active" | "revoked";

export class GrantRecord {
    public constructor(
        public readonly id: GrantId,
        public readonly domain: ProtectionDomain,
        public readonly status: GrantStatus,
        public readonly revision: Revision,
        public readonly parentId: GrantId | undefined = undefined
    ) {
    }

    public get live(): boolean {
        return this.status === "active";
    }

    public permits(domain: ProtectionDomain): boolean {
        return this.live && this.domain.equals(domain);
    }

    public revoke(): GrantRecord {
        if (this.status === "revoked") {
            return this;
        }

        return new GrantRecord(
            this.id,
            this.domain,
            "revoked",
            this.revision.next(),
            this.parentId
        );
    }
}
