import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../../src/errors";
import { ActorId, ActorRef } from "../../src/actors";
import { Revision, encodeCanonicalJson } from "../../src/core";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import { Grant, GrantId, ScopeEpoch } from "../../src/authority";
import { Binding } from "../../src/authority/binding";
import { InvalidationWatermark, PathEpochEvidence } from "../../src/authority/epoch";
import { PrincipalId, ProjectId, ScopeRef, TenantId } from "../../src/identity";
import { PrincipalRef } from "../identity/internal-fixture";
import {
    allowGrant,
    capability,
    principal,
    projectScope,
    tenantScope,
    workspaceScope
} from "./fixture";

describe("authority value records", () => {
    test("canonicalizes capability sets and enforces argument constraints", () => {
        const spec = new CapabilitySpec({
            facetPattern: "workspace:mail.*",
            operations: ["send", "read", "send"],
            impacts: ["mutate", "observe"],
            argumentConstraints: { "message.channel": "internal" }
        });

        expect(spec.operations).toEqual(["read", "send"]);
        expect(spec.impacts).toEqual(["observe", "mutate"]);
        expect(
            spec.matches({
                facet: "workspace:mail.instance",
                operation: "send",
                impact: "mutate",
                arguments: { message: { channel: "internal" } }
            })
        ).toBe(true);
        expect(
            spec.matches({
                facet: "workspace:mail.instance",
                operation: "send",
                impact: "mutate",
                arguments: { message: { channel: "external" } }
            })
        ).toBe(false);
        expect(Object.isFrozen(spec.argumentConstraints)).toBe(true);
    });

    test("accepts only equal-or-narrower delegated capabilities", () => {
        const parent = new CapabilitySpec({
            facetPattern: "workspace:mail.*",
            impacts: ["observe", "mutate"]
        });
        const narrow = new CapabilitySpec({
            facetPattern: "workspace:mail.instance",
            operations: ["read"],
            impacts: ["observe"],
            argumentConstraints: { folder: "inbox" }
        });
        const wider = capability(["observe", "administer"]);

        expect(parent.covers(narrow)).toBe(true);
        expect(narrow.covers(parent)).toBe(false);
        expect(parent.covers(wider)).toBe(false);
    });

    test("[authority.grant] [authority.scope-epoch] round-trips retained authority records through canonical codecs", () => {
        const grant = allowGrant("grant-codec");
        const epoch = new ScopeEpoch(workspaceScope, 3);

        expect(Grant.decode(Grant.encode(grant)).toData()).toEqual(grant.toData());
        expect(ScopeEpoch.decode(ScopeEpoch.encode(epoch)).toData()).toEqual(epoch.toData());
    });

    test("rejects malformed and unknown-major capability bytes", () => {
        const unknownMajor = encodeCanonicalJson({
            kind: "authority.capability-spec",
            version: { major: 2, minor: 0 },
            payload: {
                argumentConstraints: {},
                facetPattern: "*",
                impacts: ["observe"],
                operations: []
            }
        });
        expect(() => CapabilitySpec.decode(unknownMajor)).toThrow(
            new AgentCoreError(
                "codec.unknown-major",
                "Unsupported authority.capability-spec codec major 2"
            )
        );
        expect(
            () => new CapabilitySpec({ facetPattern: "mail.[x]", impacts: ["observe"] })
        ).toThrow(TypeError);
    });

    test("advances Scope epochs immutably", () => {
        const initial = ScopeEpoch.initial(tenantScope);
        const next = initial.next();

        expect(initial.epoch).toBe(0);
        expect(next.epoch).toBe(1);
        expect(next.scope).toBe(tenantScope);
        expect(Object.isFrozen(initial)).toBe(true);
    });

    test("rejects extra Project ancestry for a projectless Workspace", () => {
        const tenant = tenantScope;
        const project = ScopeRef.project(tenant.tenantId, new ProjectId("extra-project"));
        const projectless = ScopeRef.workspace(tenant.tenantId, workspaceScope.workspaceId!);

        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(tenant, 1),
                    new ScopeEpoch(project, 1),
                    new ScopeEpoch(projectless, 1)
                ])
        ).toThrow(/canonical ancestry/);
    });

    test("[authority.path-epoch-evidence] round-trips exact path evidence and reports changed Scopes", () => {
        const path = new PathEpochEvidence([
            new ScopeEpoch(tenantScope, 2),
            new ScopeEpoch(projectScope, 3),
            new ScopeEpoch(workspaceScope, 4)
        ]);
        const changed = new PathEpochEvidence([
            new ScopeEpoch(tenantScope, 2),
            new ScopeEpoch(projectScope, 4),
            new ScopeEpoch(workspaceScope, 4)
        ]);

        expect(PathEpochEvidence.decode(PathEpochEvidence.encode(path)).equals(path)).toBe(true);
        expect(path.staleScopes(changed).map((scope) => scope.kind)).toEqual(["project"]);
    });

    test("[authority.invalidation-watermark] joins qualified Actor-local watermarks monotonically", () => {
        const ownerTenant = new TenantId("watermark-owner");
        const owner = new ActorRef("workspace", new ActorId("watermark-workspace"));
        const holder = new PrincipalRef(new TenantId("foreign-home"), new PrincipalId("guest"));
        const localScope = ScopeRef.tenant(ownerTenant);
        const initial = InvalidationWatermark.empty(ownerTenant, owner, holder);
        const joined = initial.join([new ScopeEpoch(localScope, 3)]);
        const unchanged = joined.join([new ScopeEpoch(localScope, 2)]);

        expect(unchanged).toBe(joined);
        expect(joined.dominates(initial)).toBe(true);
        expect(
            InvalidationWatermark.decode(InvalidationWatermark.encode(joined)).dominates(joined)
        ).toBe(true);
    });

    test("[authority.binding] keeps Binding identity immutable while advancing local generations", () => {
        const domain = new ProtectionDomain("backend", "model", "no-secrets");
        const binding = Binding.active(
            workspaceScope,
            principal,
            domain,
            new BindingName("mail"),
            new GrantId("binding-grant"),
            new FacetRef("workspace:mail.instance")
        );
        const replacement = binding.replace(
            new GrantId("binding-grant-next"),
            new FacetRef("workspace:mail.next")
        );

        expect(Binding.decode(Binding.encode(replacement)).generation).toBe(1);
        expect(replacement.deactivate().resolves).toBe(false);
        expect(() =>
            binding.assertCanReplace(
                new Binding(
                    workspaceScope,
                    principal,
                    domain,
                    binding.name,
                    binding.grantId,
                    binding.facet,
                    2,
                    "active",
                    new Revision(2)
                )
            )
        ).toThrow(/next generation/);
    });
});

describe("Grant model", () => {
    test("revokes immutably and cannot restore live authority", () => {
        const active = allowGrant("grant-revoke");
        const revoked = active.revoke();

        expect(active.isLive).toBe(true);
        expect(revoked.isLive).toBe(false);
        expect(revoked.revoke()).toEqual(revoked);
        expect(Object.isFrozen(active)).toBe(true);
        expect(Object.isFrozen(revoked)).toBe(true);
    });

    test("[C13-AUTH-PLANE] prohibits deny attenuation", () => {
        expect(
            () =>
                new Grant(
                    new GrantId("grant-deny"),
                    workspaceScope,
                    principal,
                    "deny",
                    capability(),
                    { kind: "direct" },
                    new GrantId("grant-parent")
                )
        ).toThrow("Deny Grants cannot be attenuated or delegated");
    });
});
