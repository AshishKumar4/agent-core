import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../../src/errors";
import { Revision, decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { CapabilitySpec, type Impact } from "../../src/facets";
import {
    BUILT_IN_ROLES,
    EDITOR_ROLE,
    GuestVerificationScheme,
    Membership,
    MembershipId,
    OWNER_ROLE,
    Principal,
    PrincipalId,
    Project,
    ProjectId,
    READER_ROLE,
    Role,
    RoleName,
    RoleRule,
    ScopeRef,
    SubjectRef,
    Team,
    TeamId,
    Tenant,
    TenantId,
    WorkspaceId,
    decodeScopeRef,
    decodeSubjectRef,
    encodeScopeRef,
    encodeSubjectRef,
    findBuiltInRole
} from "../../src/identity";

const tenantId = new TenantId("tenant-a");
const principalId = new PrincipalId("principal-a");
const teamId = new TeamId("team-a");
const projectId = new ProjectId("project-a");
const workspaceId = new WorkspaceId("workspace-a");

describe("identity codecs", () => {
    const records = [
        {
            name: "Principal",
            codec: Principal.codec,
            value: new Principal(principalId, "user", "active")
        },
        {
            name: "Tenant",
            codec: Tenant.codec,
            value: new Tenant(tenantId, "organization", "active", new Revision(3))
        },
        {
            name: "Team",
            codec: Team.codec,
            value: new Team(teamId, tenantId, "Operators", [principalId], new Revision(4))
        },
        {
            name: "Project",
            codec: Project.codec,
            value: new Project(projectId, tenantId, "Runtime", new Revision(5))
        },
        {
            name: "Role",
            codec: Role.codec,
            value: new Role(new RoleName("auditor"), [
                new RoleRule("allow", capability("logs.*", ["observe"]))
            ])
        },
        {
            name: "Membership",
            codec: Membership.codec,
            value: new Membership(
                new MembershipId("membership-a"),
                ScopeRef.workspace(tenantId, projectId, workspaceId),
                SubjectRef.team(teamId),
                new RoleName("editor"),
                "active",
                new Revision(6)
            )
        }
    ] as const;

    test.each(records)(
        "[identity.principal] [identity.tenant] [identity.team] [identity.project] [identity.role] [identity.membership] round-trips frozen $name records",
        ({ codec, value }) => {
            const decoded = codec.decode(codec.encode(value as never));

            expect(Object.isFrozen(decoded)).toBe(true);
            expect(codec.encode(decoded as never)).toEqual(codec.encode(value as never));
        }
    );

    test.each(records)("rejects unknown $name payload fields", ({ codec, value }) => {
        const envelope = requireObject(decodeCanonicalJson(codec.encode(value as never)));
        const payload = requireObject(envelope["payload"]!);

        expectCodecError(
            () =>
                codec.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        payload: { ...payload, unexpected: true }
                    })
                ),
            "codec.invalid"
        );
    });

    test.each(records)("rejects unknown $name codec majors", ({ codec, value }) => {
        const envelope = requireObject(decodeCanonicalJson(codec.encode(value as never)));

        expectCodecError(
            () =>
                codec.decode(
                    encodeCanonicalJson({
                        ...envelope,
                        version: { major: 2, minor: 0 }
                    })
                ),
            "codec.unknown-major"
        );
    });

    test("keeps revisions explicit and immutable", () => {
        const membership = records[5].value;
        const suspended = membership.suspend();
        const revoked = suspended.revoke();

        expect(membership.state).toBe("active");
        expect(suspended.state).toBe("suspended");
        expect(suspended.revision.value).toBe(7);
        expect(revoked.revision.value).toBe(8);
        expect(() => revoked.activate()).toThrow(AgentCoreError);
    });
});

describe("scope and subject references", () => {
    test("admits only the fixed Tenant to optional Project to Workspace paths", () => {
        const tenant = ScopeRef.tenant(tenantId);
        const project = ScopeRef.project(tenantId, projectId);
        const directWorkspace = ScopeRef.workspace(tenantId, workspaceId);
        const projectWorkspace = ScopeRef.workspace(tenantId, projectId, workspaceId);

        expect(tenant.path.map((scope) => scope.kind)).toEqual(["tenant"]);
        expect(project.path.map((scope) => scope.kind)).toEqual(["tenant", "project"]);
        expect(directWorkspace.path.map((scope) => scope.kind)).toEqual(["tenant", "workspace"]);
        expect(projectWorkspace.path.map((scope) => scope.kind)).toEqual([
            "tenant",
            "project",
            "workspace"
        ]);
        expect(decodeScopeRef(encodeScopeRef(projectWorkspace)).equals(projectWorkspace)).toBe(
            true
        );
        expect(encodeScopeRef(directWorkspace)).toEqual({
            kind: "workspace",
            project: null,
            tenant: tenantId.value,
            workspace: workspaceId.value
        });
        expect(() =>
            decodeScopeRef({
                kind: "workspace",
                project: null,
                tenant: tenantId.value,
                workspace: workspaceId.value,
                parent: "arbitrary"
            })
        ).toThrow(/unknown fields/);
    });

    test("round-trips Principal, Team, and verified foreign subjects", () => {
        const subjects = [
            SubjectRef.principal(principalId),
            SubjectRef.team(teamId),
            SubjectRef.foreign(tenantId, principalId, GuestVerificationScheme.callback)
        ];

        expect(subjects.map((subject) => decodeSubjectRef(encodeSubjectRef(subject)).kind)).toEqual(
            ["principal", "team", "foreign"]
        );
        expect(encodeSubjectRef(subjects[2]!)).toEqual({
            homeTenant: tenantId.value,
            kind: "foreign",
            principal: principalId.value,
            verifiedVia: "callback"
        });
        expect(() =>
            decodeSubjectRef({
                homeTenant: tenantId.value,
                kind: "foreign",
                principal: principalId.value,
                verifiedVia: "session"
            })
        ).toThrow(/verification scheme/);
    });

    test("fixes exactly the three guest verification schemes", () => {
        expect([
            GuestVerificationScheme.token.value,
            GuestVerificationScheme.callback.value,
            GuestVerificationScheme.handshake.value
        ]).toEqual(["token", "callback", "handshake"]);
    });
});

describe("roles", () => {
    test("defines owner, editor, and reader as declarative allow rules", () => {
        expect(BUILT_IN_ROLES.map((role) => role.name.value)).toEqual([
            "owner",
            "editor",
            "reader"
        ]);
        expect(impacts(OWNER_ROLE)).toEqual([
            "observe",
            "mutate",
            "externalSend",
            "execute",
            "delegate",
            "administer"
        ]);
        expect(impacts(EDITOR_ROLE)).toEqual([
            "observe",
            "mutate",
            "externalSend",
            "execute",
            "delegate"
        ]);
        expect(impacts(READER_ROLE)).toEqual(["observe"]);
        expect(BUILT_IN_ROLES.every((role) => role.rules[0]?.effect === "allow")).toBe(true);
        expect("authorizes" in OWNER_ROLE).toBe(false);
        expect("permits" in OWNER_ROLE).toBe(false);
    });

    test("preserves declaration order through the Role codec", () => {
        const role = new Role(new RoleName("ordered"), [
            new RoleRule("deny", capability("secrets.*", ["observe"])),
            new RoleRule("allow", capability("*", ["observe"]))
        ]);
        const decoded = Role.decode(Role.encode(role));

        expect(decoded.rules.map((rule) => rule.effect)).toEqual(["deny", "allow"]);
        expect(decoded.rules.map((rule) => rule.capability.facetPattern)).toEqual([
            "secrets.*",
            "*"
        ]);
    });

    test("does not retain legacy admin or member aliases", () => {
        expect(findBuiltInRole("admin")).toBeUndefined();
        expect(findBuiltInRole("member")).toBeUndefined();
        expect(findBuiltInRole(new RoleName("owner"))).toBe(OWNER_ROLE);

        const membership = new Membership(
            new MembershipId("membership-no-alias"),
            ScopeRef.tenant(tenantId),
            SubjectRef.principal(principalId),
            new RoleName("reader"),
            "active",
            Revision.initial()
        );
        expect("tenantId" in membership).toBe(false);
        expect("principalId" in membership).toBe(false);
        expect("status" in membership).toBe(false);
        expect("isOwner" in membership).toBe(false);
    });
});

function impacts(role: Role): readonly JsonValue[] {
    const value = role.rules[0]?.capability.impacts;
    if (!Array.isArray(value)) {
        throw new TypeError("Expected built-in Role impacts");
    }
    return value;
}

function capability(facetPattern: string, roleImpacts: readonly Impact[]): CapabilitySpec {
    return new CapabilitySpec({
        facetPattern,
        impacts: roleImpacts as [Impact, ...Impact[]]
    });
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected object");
    }
    return value as { readonly [key: string]: JsonValue };
}

function expectCodecError(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new Error("Expected codec error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}
