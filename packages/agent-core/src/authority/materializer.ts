import type { Membership, Role, RoleRule } from "../identity";
import { AgentCoreError } from "../errors";
import type { CapabilitySpec } from "../facets";
import { bytesEqual } from "./data";
import { Grant } from "./grant";
import { GrantId } from "./id";
import { scopeKey } from "./reference";
import type { ScopeRef } from "../identity";

export interface RoleGrantMaterializationInput {
    readonly membership: Membership;
    readonly role: Role;
    readonly existing: readonly Grant[];
}

export class RoleGrantMaterialization {
    public readonly desiredRecords: readonly Grant[];
    public readonly changedRecords: readonly Grant[];
    public readonly affectedScopes: readonly ScopeRef[];

    public constructor(
        desiredRecords: readonly Grant[],
        changedRecords: readonly Grant[],
        affectedScopes: readonly ScopeRef[]
    ) {
        this.desiredRecords = canonicalGrants(desiredRecords);
        this.changedRecords = canonicalGrants(changedRecords);
        this.affectedScopes = Object.freeze(
            [...affectedScopes].sort((left, right) => scopeKey(left).localeCompare(scopeKey(right)))
        );
        Object.freeze(this);
    }

    public get semanticNoop(): boolean {
        return this.changedRecords.length === 0;
    }
}

export class RoleGrantMaterializer {
    public materialize(input: RoleGrantMaterializationInput): RoleGrantMaterialization {
        if (!input.membership.role.equals(input.role.name)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Membership role and materialized Role must match"
            );
        }
        if (
            input.membership.subject.kind === "foreign" &&
            input.membership.subject.verifiedVia.value === "handshake"
        ) {
            throw new AgentCoreError(
                "authority.denied",
                "Handshake is a guest bootstrap scheme and cannot materialize Grants"
            );
        }
        const membershipId = input.membership.id;
        const owned = input.existing.filter(
            (grant) =>
                grant.origin.kind === "role" && grant.origin.membershipId.equals(membershipId)
        );
        if (new Set(owned.map((grant) => grant.id.value)).size !== owned.length) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Role materialization input contains duplicate Grant IDs"
            );
        }

        const desiredActiveRecords = input.membership.isActive
            ? materializeActive(input.membership, input.role)
            : [];
        const ownedById = new Map(owned.map((grant) => [grant.id.value, grant]));
        const desiredActive = desiredActiveRecords.map((record) => {
            const previous = ownedById.get(record.id.value);
            return previous?.isLive === false ? record.revoke() : record;
        });
        const activeIds = new Set(desiredActive.map((grant) => grant.id.value));
        const obsolete = owned
            .filter((grant) => !activeIds.has(grant.id.value))
            .map((grant) => grant.revoke());
        const desiredRecords = [...desiredActive, ...obsolete];
        const previousById = new Map(owned.map((grant) => [grant.id.value, grant]));
        const changedRecords = desiredRecords.filter((record) => {
            const previous = previousById.get(record.id.value);
            return (
                previous === undefined || !bytesEqual(Grant.encode(previous), Grant.encode(record))
            );
        });
        const affected = new Map<string, ScopeRef>();
        for (const changed of changedRecords) affected.set(scopeKey(changed.scope), changed.scope);
        return new RoleGrantMaterialization(desiredRecords, changedRecords, [...affected.values()]);
    }
}

function materializeActive(membership: Membership, role: Role): readonly Grant[] {
    const guest = membership.subject.kind === "foreign";
    if (guest && membership.guestVerification === undefined) return [];
    const records: Grant[] = [];
    role.rules.forEach((rule, ruleOrdinal) => {
        const capability = roleCapability(rule);
        if (guest && rule.effect === "allow" && capability.grantsElevation()) return;
        records.push(
            new Grant(
                GrantId.forRole(membership.id, ruleOrdinal),
                membership.scope,
                membership.subject,
                rule.effect,
                capability,
                {
                    kind: "role",
                    membershipId: membership.id,
                    roleName: role.name.value,
                    ruleOrdinal,
                    guest
                }
            )
        );
    });
    return records;
}

function roleCapability(rule: RoleRule): CapabilitySpec {
    return rule.capability;
}

function canonicalGrants(grants: readonly Grant[]): readonly Grant[] {
    const ordered = [...grants].sort((left, right) => left.id.value.localeCompare(right.id.value));
    if (new Set(ordered.map((grant) => grant.id.value)).size !== ordered.length) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Role materialization output Grant IDs must be unique"
        );
    }
    return Object.freeze(ordered);
}
