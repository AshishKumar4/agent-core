import type { Facet } from "../facets/facet";
import type { BindingName } from "../facets/id";
import type { OperationCatalog } from "../facets/operation";
import { OperationCatalog as Catalog } from "../facets/operation";
import type { ProtectionDomain } from "../facets/protection";
import type { Revision } from "../record";
import type { GrantRecord } from "./grant";
import type { BindingId, GrantId } from "./id";

export class BindingAuthority {
    public constructor(
        public readonly bindingId: BindingId,
        public readonly grantId: GrantId,
        public readonly domain: ProtectionDomain
    ) {
    }

    public matches(other: BindingAuthority): boolean {
        return this.bindingId.equals(other.bindingId)
            && this.grantId.equals(other.grantId)
            && this.domain.equals(other.domain);
    }
}

export interface AuthorityVerifier {
    permits(authority: BindingAuthority): boolean;
}

export class BindingRecord {
    public constructor(
        public readonly id: BindingId,
        public readonly name: BindingName,
        public readonly grantId: GrantId,
        public readonly revision: Revision
    ) {
    }
}

export class ResolvedBinding {
    public constructor(
        public readonly record: BindingRecord,
        public readonly grant: GrantRecord,
        public readonly facet: Facet
    ) {
        if (!record.name.equals(facet.name)) {
            throw new TypeError("Resolved Binding name must match the bound Facet name");
        }

        if (!record.grantId.equals(grant.id)) {
            throw new TypeError("Resolved Binding must reference its Grant record");
        }
    }

    public get id(): BindingId {
        return this.record.id;
    }

    public get name(): BindingName {
        return this.record.name;
    }

    public get revision(): Revision {
        return this.record.revision;
    }

    public get live(): boolean {
        return this.grant.live;
    }

    public get authority(): BindingAuthority {
        return new BindingAuthority(this.record.id, this.grant.id, this.grant.domain);
    }

    public resolve(domain: ProtectionDomain): Facet {
        if (!this.grant.permits(domain)) {
            throw new TypeError("Binding resolution requires a live Grant for the requested domain");
        }

        return this.facet;
    }

    public operations(): OperationCatalog {
        if (!this.live) {
            return Catalog.empty();
        }

        return operationsForFacet(this.facet, this.authority);
    }
}

function operationsForFacet(facet: Facet, authority: BindingAuthority): OperationCatalog {
    return facet.children().facets.reduce(
        (catalog, child) => catalog.merge(operationsForFacet(child, authority)),
        Catalog.from(facet.name, facet.operations(), authority, () => facet.active)
    );
}
