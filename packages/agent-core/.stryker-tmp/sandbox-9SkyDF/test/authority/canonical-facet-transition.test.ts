// @ts-nocheck
import { describe, expect, test } from "vitest";
import * as authority from "../../src/authority";
import { Grant, GrantId } from "../../src/authority";
import { Binding } from "../../src/authority/binding";
import { Revision } from "../../src/core";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    PrincipalId,
    RoleRule,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";

describe("coordinated FacetRef and CapabilitySpec transition", () => {
    test("[C13-AUTH-ROLE-MATERIALIZATION] retains the exact W3 CapabilitySpec through Role and Grant runtime records", () => {
        const capability = new CapabilitySpec({
            facetPattern: "workspace:mail.*",
            impacts: ["observe"]
        });
        const roleRule = new RoleRule("allow", capability);
        const grant = new Grant(
            new GrantId("canonical-capability"),
            scope,
            subject,
            "allow",
            capability,
            { kind: "direct" }
        );

        expect(roleRule.capability).toBe(capability);
        expect(grant.capability).toBe(capability);
        expect(Grant.decode(Grant.encode(grant)).capability).toBeInstanceOf(CapabilitySpec);
        expect("CapabilitySpec" in authority).toBe(false);
    });

    test("[C13-AUTH-BINDING-RESOLUTION] retains the exact W3 FacetRef through Binding runtime records", () => {
        const facet = new FacetRef("workspace:mail.primary");
        const binding = new Binding(
            scope,
            subject,
            new ProtectionDomain("backend", "canonical", "no-secrets"),
            new BindingName("mail"),
            new GrantId("canonical-binding"),
            facet,
            0,
            "active",
            Revision.initial()
        );

        expect(binding.facet).toBe(facet);
        expect(Binding.decode(Binding.encode(binding)).facet).toBeInstanceOf(FacetRef);
        expect(() => new FacetRef("workspace:mail:forged")).toThrow(/<scope>:<instance>/);
    });
});

const tenant = new TenantId("canonical-tenant");
const scope = ScopeRef.workspace(tenant, new WorkspaceId("canonical-workspace"));
const subject = SubjectRef.principal(new PrincipalId("canonical-principal"));
