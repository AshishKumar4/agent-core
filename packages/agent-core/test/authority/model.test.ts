import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../../src/errors";
import { ActorId, ActorRef } from "../../src/actors";
import { Revision, encodeCanonicalJson } from "../../src/core";
import { BindingName, CapabilitySpec, FacetRef, ProtectionDomain } from "../../src/facets";
import { Grant, GrantId, ScopeEpoch } from "../../src/authority";
import { Binding } from "../../src/authority/binding";
import { InvalidationWatermark, PathEpochEvidence } from "../../src/authority/epoch";
import {
    MembershipId,
    PrincipalId,
    ProjectId,
    ScopeRef,
    SubjectRef,
    TenantId
} from "../../src/identity";
import { PrincipalRef } from "../identity/internal-fixture";
import {
    allowGrant,
    capability,
    otherPrincipalId,
    principal,
    projectScope,
    tenantScope,
    workspaceScope
} from "./fixture";

describe("authority value records", () => {
    test("canonicalizes capability sets and enforces argument constraints", { tags: "p0" }, () => {
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

    test("accepts only equal-or-narrower delegated capabilities", { tags: "p0" }, () => {
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

    test("[authority.grant] [authority.scope-epoch] round-trips retained authority records through canonical codecs", { tags: "p0" }, () => {
        const grant = allowGrant("grant-codec");
        const epoch = new ScopeEpoch(workspaceScope, 3);

        expect(Grant.decode(Grant.encode(grant)).toData()).toEqual(grant.toData());
        expect(ScopeEpoch.decode(ScopeEpoch.encode(epoch)).toData()).toEqual(epoch.toData());
    });

    test("rejects malformed and unknown-major capability bytes", { tags: "p0" }, () => {
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

    test("advances Scope epochs immutably", { tags: "p0" }, () => {
        const initial = ScopeEpoch.initial(tenantScope);
        const next = initial.next();

        expect(initial.epoch).toBe(0);
        expect(next.epoch).toBe(1);
        expect(next.scope).toBe(tenantScope);
        expect(Object.isFrozen(initial)).toBe(true);
    });

    test("rejects extra Project ancestry for a projectless Workspace", { tags: "p0" }, () => {
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

    test("[authority.path-epoch-evidence] round-trips exact path evidence and reports changed Scopes", { tags: "p0" }, () => {
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

    test("[authority.invalidation-watermark] joins qualified Actor-local watermarks monotonically", { tags: "p0" }, () => {
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

    test("[authority.binding] keeps Binding identity immutable while advancing local generations", { tags: "p0" }, () => {
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
    test("revokes immutably and cannot restore live authority", { tags: "p0" }, () => {
        const active = allowGrant("grant-revoke");
        const revoked = active.revoke();

        expect(active.isLive).toBe(true);
        expect(revoked.isLive).toBe(false);
        expect(revoked.revoke()).toEqual(revoked);
        expect(Object.isFrozen(active)).toBe(true);
        expect(Object.isFrozen(revoked)).toBe(true);
    });

    test("[C13-AUTH-PLANE] prohibits deny attenuation", { tags: "p0" }, () => {
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

    test("attenuation requires an allow-effect parent", { tags: "p0" }, () => {
        const parent = allowGrant("attenuate-parent");
        const child = allowGrant("attenuate-child", principal, workspaceScope, capability(), parent.id);
        const deny = new Grant(
            new GrantId("attenuate-deny"),
            workspaceScope,
            principal,
            "deny",
            capability(),
            { kind: "direct" }
        );

        expect(parent.canAttenuate(child)).toBe(true);
        expect(deny.canAttenuate(child)).toBe(false);
    });

    test("role Grant replacement pins subject, Scope, origin, and lineage exactly", { tags: "p0" }, () => {
        const base = roleGrant();
        expect(() => base.assertCanReplace(roleGrant({ spec: capability(["mutate"]) }))).not.toThrow();
        expect(() => base.assertCanReplace(roleGrant().revoke())).not.toThrow();

        const violations: readonly (readonly [string, Grant])[] = [
            ["scope", roleGrant({ scope: tenantScope })],
            ["subject", roleGrant({ subject: SubjectRef.principal(otherPrincipalId) })],
            ["attenuation lineage", roleGrant({ attenuationOf: new GrantId("role-replace-parent") })],
            ["membership", roleGrant({ membershipId: new MembershipId("role-replace-other") })],
            ["rule ordinal", roleGrant({ ruleOrdinal: 1 })],
            ["guest flag", roleGrant({ guest: true })],
            ["origin kind", allowGrant("role-replace")]
        ];
        for (const [field, next] of violations) {
            const error = caughtAgentCoreError(() => base.assertCanReplace(next));
            expect(error.code, field).toBe("protocol.invalid-state");
            expect(error.message, field).toBe(
                "Grant subject, Scope, origin, and attenuation lineage are immutable"
            );
        }

        const reactivation = caughtAgentCoreError(() => base.revoke().assertCanReplace(roleGrant()));
        expect(reactivation.code).toBe("protocol.invalid-state");
        expect(reactivation.message).toBe("Revoked Grants cannot reactivate");
    });

    test("direct Grants replace only with their exact revocation", { tags: "p0" }, () => {
        const direct = allowGrant(
            "direct-replace",
            principal,
            workspaceScope,
            capability(["observe"], "workspace:mail.aa")
        );
        expect(() => direct.assertCanReplace(direct.revoke())).not.toThrow();

        const tampered = allowGrant(
            "direct-replace",
            principal,
            workspaceScope,
            capability(["observe"], "workspace:mail.ab")
        ).revoke();
        const error = caughtAgentCoreError(() => direct.assertCanReplace(tampered));
        expect(error.code).toBe("protocol.invalid-state");
        expect(error.message).toBe("Direct Grants are immutable except for revocation");
    });

    test("Grant.fromData rejects malformed fields with exact reasons", { tags: "p0" }, () => {
        const data = allowGrant("codec-reasons").toData();

        expect(() => Grant.fromData({ ...data, attenuationOf: 7 })).toThrow(
            new TypeError("Grant attenuation parent must be a string or null")
        );
        expect(() => Grant.fromData({ ...data, id: 7 })).toThrow(
            new TypeError("Grant ID must be a string")
        );
        expect(() => Grant.fromData({ ...data, origin: { kind: 7 } })).toThrow(
            new TypeError("Grant origin kind must be a string")
        );
        expect(() => Grant.fromData({ ...data, origin: { kind: "unknown" } })).toThrow(
            new TypeError("Grant origin kind is invalid")
        );
        expect(() =>
            Grant.fromData({
                ...data,
                origin: {
                    guest: false,
                    kind: "role",
                    membershipId: 7,
                    roleName: "reader",
                    ruleOrdinal: 0
                }
            })
        ).toThrow(new TypeError("Membership ID must be a string"));
        expect(() =>
            Grant.fromData({
                ...data,
                origin: {
                    guest: false,
                    kind: "role",
                    membershipId: "role-membership",
                    roleName: 7,
                    ruleOrdinal: 0
                }
            })
        ).toThrow(new TypeError("Role name must be a string"));
    });

    test("round-trips role Grant origins through the canonical codec", { tags: "p0" }, () => {
        const grant = roleGrant({ attenuationOf: new GrantId("role-roundtrip-parent") });
        const decoded = Grant.decode(Grant.encode(grant));

        expect(decoded.toData()).toEqual(grant.toData());
        expect(decoded.attenuationOf?.value).toBe("role-roundtrip-parent");
        expect(decoded.origin.kind).toBe("role");
        if (decoded.origin.kind === "role") {
            expect(decoded.origin.membershipId.value).toBe("role-membership");
            expect(decoded.origin.roleName).toBe("reader");
            expect(decoded.origin.ruleOrdinal).toBe(0);
            expect(decoded.origin.guest).toBe(false);
        }
    });

    test("role origins admit 1..256 character names and non-negative ordinals", { tags: "p0" }, () => {
        expect(roleGrant({ roleName: "x".repeat(256) }).origin.kind).toBe("role");
        for (const overrides of [
            { roleName: "" },
            { roleName: "x".repeat(257) },
            { ruleOrdinal: -1 }
        ]) {
            expect(() => roleGrant(overrides)).toThrow(
                new TypeError("Role Grant origin is invalid")
            );
        }
    });
});

function roleGrant(
    overrides: {
        readonly scope?: ScopeRef;
        readonly subject?: SubjectRef;
        readonly spec?: CapabilitySpec;
        readonly attenuationOf?: GrantId;
        readonly membershipId?: MembershipId;
        readonly roleName?: string;
        readonly ruleOrdinal?: number;
        readonly guest?: boolean;
    } = {}
): Grant {
    return new Grant(
        new GrantId("role-replace"),
        overrides.scope ?? workspaceScope,
        overrides.subject ?? principal,
        "allow",
        overrides.spec ?? capability(),
        {
            kind: "role",
            membershipId: overrides.membershipId ?? new MembershipId("role-membership"),
            roleName: overrides.roleName ?? "reader",
            ruleOrdinal: overrides.ruleOrdinal ?? 0,
            guest: overrides.guest ?? false
        },
        overrides.attenuationOf
    );
}

function caughtAgentCoreError(run: () => unknown): AgentCoreError {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(AgentCoreError);
    if (!(caught instanceof AgentCoreError)) {
        throw new TypeError("Expected an AgentCoreError");
    }
    return caught;
}
