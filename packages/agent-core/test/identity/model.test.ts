import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../../src/errors";
import {
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject,
    type JsonValue,
    type RecordVersion
} from "../../src/core";
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
    PrincipalRef,
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

type IdentityRecord = Principal | Tenant | Team | Project | Role | Membership;

interface IdentityCodecCase {
    readonly name: string;
    readonly version: RecordVersion;
    encode(): Uint8Array;
    decode(bytes: Uint8Array): IdentityRecord;
    reencode(bytes: Uint8Array): Uint8Array;
}

function codecCase<Value extends IdentityRecord>(
    name: string,
    codec: {
        readonly version: RecordVersion;
        encode(value: Value): Uint8Array;
        decode(bytes: Uint8Array): Value;
    },
    value: Value
): IdentityCodecCase {
    return {
        name,
        version: codec.version,
        encode: () => codec.encode(value),
        decode: (bytes) => codec.decode(bytes),
        reencode: (bytes) => codec.encode(codec.decode(bytes))
    };
}

describe("identity codecs", () => {
    const membershipRecord = new Membership(
        new MembershipId("membership-a"),
        ScopeRef.workspace(tenantId, projectId, workspaceId),
        SubjectRef.team(teamId),
        new RoleName("editor"),
        "active",
        new Revision(6)
    );
    const records: readonly IdentityCodecCase[] = [
        codecCase("Principal", Principal.codec, new Principal(principalId, "user", "active")),
        codecCase(
            "Tenant",
            Tenant.codec,
            new Tenant(tenantId, "organization", "active", new Revision(3))
        ),
        codecCase(
            "Team",
            Team.codec,
            new Team(teamId, tenantId, "Operators", [principalId], new Revision(4))
        ),
        codecCase(
            "Project",
            Project.codec,
            new Project(projectId, tenantId, "Runtime", new Revision(5))
        ),
        codecCase(
            "Role",
            Role.codec,
            new Role(new RoleName("auditor"), [
                new RoleRule("allow", capability("logs.*", ["observe"]))
            ])
        ),
        codecCase("Membership", Membership.codec, membershipRecord)
    ];

    test.each(records)(
        "[identity.principal] [identity.tenant] [identity.team] [identity.project] [identity.role] [identity.membership] round-trips frozen $name records",
        { tags: "p1" },
        ({ decode, encode, reencode }) => {
            const encoded = encode();
            const decoded = decode(encoded);

            expect(Object.isFrozen(decoded)).toBe(true);
            expect(reencode(encoded)).toEqual(encoded);
        }
    );

    test.each(records)(
        "rejects unknown $name payload fields",
        { tags: "p1" },
        ({ decode, encode }) => {
            const envelope = requireObject(decodeCanonicalJson(encode()));
            const payload = requireObject(envelope["payload"]);

            expectCodecError(
                () =>
                    decode(
                        encodeCanonicalJson({
                            ...envelope,
                            payload: { ...payload, unexpected: true }
                        })
                    ),
                "codec.invalid"
            );
        }
    );

    test.each(records)(
        "rejects unknown $name codec majors",
        { tags: "p2" },
        ({ decode, encode, version }) => {
            const envelope = requireObject(decodeCanonicalJson(encode()));

            expectCodecError(
                () =>
                    decode(
                        encodeCanonicalJson({
                            ...envelope,
                            version: { major: version.major + 1, minor: 0 }
                        })
                    ),
                "codec.unknown-major"
            );
        }
    );

    test("keeps revisions explicit and immutable", { tags: "p0" }, () => {
        const suspended = membershipRecord.suspend();
        const revoked = suspended.revoke();

        expect(membershipRecord.state).toBe("active");
        expect(suspended.state).toBe("suspended");
        expect(suspended.revision.value).toBe(7);
        expect(revoked.revision.value).toBe(8);
        expect(() => revoked.activate()).toThrow(AgentCoreError);
    });
});

describe("scope and subject references", () => {
    test(
        "admits only the fixed Tenant to optional Project to Workspace paths",
        { tags: "p0" },
        () => {
            const tenant = ScopeRef.tenant(tenantId);
            const project = ScopeRef.project(tenantId, projectId);
            const directWorkspace = ScopeRef.workspace(tenantId, workspaceId);
            const projectWorkspace = ScopeRef.workspace(tenantId, projectId, workspaceId);

            expect(tenant.path.map((scope) => scope.kind)).toEqual(["tenant"]);
            expect(project.path.map((scope) => scope.kind)).toEqual(["tenant", "project"]);
            expect(directWorkspace.path.map((scope) => scope.kind)).toEqual([
                "tenant",
                "workspace"
            ]);
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
        }
    );

    test("round-trips Principal, Team, and verified foreign subjects", { tags: "p1" }, () => {
        const subjects = [
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
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

    test("fixes exactly the three guest verification schemes", { tags: "p1" }, () => {
        expect([
            GuestVerificationScheme.token.value,
            GuestVerificationScheme.callback.value,
            GuestVerificationScheme.handshake.value
        ]).toEqual(["token", "callback", "handshake"]);
    });
});

describe("roles", () => {
    test("defines owner, editor, and reader as declarative allow rules", { tags: "p1" }, () => {
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

    test("preserves declaration order through the Role codec", { tags: "p1" }, () => {
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

    test("does not retain legacy admin or member aliases", { tags: "p2" }, () => {
        expect(findBuiltInRole("admin")).toBeUndefined();
        expect(findBuiltInRole("member")).toBeUndefined();
        expect(findBuiltInRole(new RoleName("owner"))).toBe(OWNER_ROLE);

        const membership = new Membership(
            new MembershipId("membership-no-alias"),
            ScopeRef.tenant(tenantId),
            SubjectRef.principal(new PrincipalRef(tenantId, principalId)),
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
    const first = roleImpacts[0];
    if (first === undefined) throw new TypeError("Expected at least one Role impact");
    return new CapabilitySpec({
        facetPattern,
        impacts: [first, ...roleImpacts.slice(1)]
    });
}

function requireObject(value: JsonValue | undefined): JsonObject {
    if (!isJsonObject(value)) {
        throw new TypeError("Expected object");
    }
    return value;
}

function expectCodecError(action: () => void, code: AgentCoreError["code"]): void {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        if (!(error instanceof AgentCoreError)) throw error;
        expect(error).toMatchObject({ code });
        return;
    }
    throw new TypeError("Expected codec error");
}
