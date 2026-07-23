import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { BindingName, FacetRef, ProtectionDomain } from "../../src/facets";
import { PrincipalId, ProjectId, ScopeRef, SubjectRef, TenantId, WorkspaceId } from "../../src/identity";
import { PrincipalRef } from "../identity/internal-fixture";
import { Binding } from "../../src/authority/binding";
import { AuthorityCheckEvidence, AuthorityCheckRequest } from "../../src/authority/evidence";
import { InvalidationWatermark, PathEpochEvidence, ScopeEpoch } from "../../src/authority/epoch";
import { GrantId } from "../../src/authority/id";
import { authorityKey } from "../../src/authority/key";
import {
    MemoryInvalidationWatermarkStore,
    watermarkKey,
    type MemoryInvalidationWatermarkSnapshot
} from "../../src/authority/watermark-store";

const tenantId = new TenantId("epoch-gate-tenant");
const otherTenant = new TenantId("epoch-gate-other");
const tenantScope = ScopeRef.tenant(tenantId);
const projectId = new ProjectId("epoch-gate-project");
const projectScope = ScopeRef.project(tenantId, projectId);
const workspaceScope = ScopeRef.workspace(tenantId, new WorkspaceId("epoch-gate-workspace"));
const projectWorkspaceScope = ScopeRef.workspace(
    tenantId,
    projectId,
    new WorkspaceId("epoch-gate-project-workspace")
);
const owner = new ActorRef("workspace", new ActorId("epoch-gate-owner"));
const issuer = new ActorRef("tenant", new ActorId("epoch-gate-issuer"));
const holder = new PrincipalRef(tenantId, new PrincipalId("epoch-gate-holder"));
const domain = new ProtectionDomain("backend", "epoch-gate", "no-secrets");
const facet = new FacetRef("workspace:epoch.gate");
const grantId = new GrantId("epoch-gate-grant");
const binding = Binding.active(
    workspaceScope,
    SubjectRef.principal(holder.principalId),
    domain,
    new BindingName("epoch-gate-binding"),
    grantId,
    facet
);
const args = { value: "ok" } as const;
const argsDigest = Digest.sha256(encodeCanonicalJson(args));
const basePath = new PathEpochEvidence([
    new ScopeEpoch(tenantScope, 1),
    new ScopeEpoch(workspaceScope, 2)
]);
const baseRequest = new AuthorityCheckRequest(checkInit());

describe("Scope epoch and path evidence mutation gates", () => {
    test("distinguishes epochs by Scope and reports exhaustion for the exact Scope", { tags: "p0" }, () => {
        expect(
            new ScopeEpoch(tenantScope, 1).equals(new ScopeEpoch(ScopeRef.tenant(otherTenant), 1))
        ).toBe(false);
        expect(new ScopeEpoch(tenantScope, 1).equals(new ScopeEpoch(tenantScope, 1))).toBe(true);
        expect(new ScopeEpoch(tenantScope, 1).next().epoch).toBe(2);
        const expectedScopeKey = authorityKey("scope", [
            { kind: "tenant", tenant: tenantId.value }
        ]);
        expectAgentError(
            () => new ScopeEpoch(tenantScope, Number.MAX_SAFE_INTEGER).next(),
            "protocol.invalid-state",
            `Authority epoch is exhausted for ${expectedScopeKey}`
        );
    });

    test("compares path evidence by length and diffs Scope changes at equal epochs", { tags: "p0" }, () => {
        const single = new PathEpochEvidence([new ScopeEpoch(tenantScope, 1)]);
        expect(single.equals(basePath)).toBe(false);
        expect(
            basePath.equals(
                new PathEpochEvidence([
                    new ScopeEpoch(tenantScope, 1),
                    new ScopeEpoch(workspaceScope, 2)
                ])
            )
        ).toBe(true);

        const swapped = new PathEpochEvidence([
            new ScopeEpoch(tenantScope, 1),
            new ScopeEpoch(ScopeRef.workspace(tenantId, new WorkspaceId("epoch-gate-swapped")), 2)
        ]);
        const stale = basePath.staleScopes(swapped);
        expect(stale).toHaveLength(1);
        expect(stale[0]?.workspaceId?.value).toBe("epoch-gate-swapped");
    });

    test("accepts every canonical Scope chain and rejects malformed paths with exact reasons", { tags: "p0" }, () => {
        expect(new PathEpochEvidence([new ScopeEpoch(tenantScope, 1)]).target.epoch).toBe(1);
        expect(
            new PathEpochEvidence([
                new ScopeEpoch(tenantScope, 1),
                new ScopeEpoch(projectScope, 1)
            ]).path.map((entry) => entry.scope.kind)
        ).toEqual(["tenant", "project"]);
        expect(
            new PathEpochEvidence([
                new ScopeEpoch(tenantScope, 1),
                new ScopeEpoch(projectScope, 1),
                new ScopeEpoch(projectWorkspaceScope, 1)
            ]).path
        ).toHaveLength(3);

        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(tenantScope, 1),
                    new ScopeEpoch(projectScope, 1),
                    new ScopeEpoch(projectWorkspaceScope, 1),
                    new ScopeEpoch(
                        ScopeRef.workspace(tenantId, projectId, new WorkspaceId("epoch-gate-extra")),
                        1
                    )
                ])
        ).toThrow("Authority path must contain one to three Scopes");
        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(projectScope, 1),
                    new ScopeEpoch(workspaceScope, 1)
                ])
        ).toThrow("Authority path must be an exact Tenant-to-target Scope chain");
        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(tenantScope, 1),
                    new ScopeEpoch(
                        ScopeRef.workspace(otherTenant, new WorkspaceId("epoch-gate-foreign")),
                        1
                    )
                ])
        ).toThrow("Authority path Scopes must share one Tenant");
        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(tenantScope, 1),
                    new ScopeEpoch(ScopeRef.project(tenantId, new ProjectId("epoch-gate-mismatch")), 1),
                    new ScopeEpoch(projectWorkspaceScope, 1)
                ])
        ).toThrow("Authority path must include the Workspace's exact Project");
        expect(
            () =>
                new PathEpochEvidence([
                    new ScopeEpoch(tenantScope, 1),
                    new ScopeEpoch(projectWorkspaceScope, 1)
                ])
        ).toThrow("Authority path must include the Workspace's exact Project");
    });

    test("decodes path evidence strictly with exact subjects", { tags: "p0" }, () => {
        expect(() => PathEpochEvidence.fromData({ path: [] })).toThrow(
            "Path epoch evidence must not be empty"
        );
        expect(() => PathEpochEvidence.fromData({ path: 3 })).toThrow(
            "Path epoch evidence must be an array"
        );
        expect(PathEpochEvidence.fromData(basePath.toData()).equals(basePath)).toBe(true);
    });
});

describe("invalidation watermark mutation gates", () => {
    test("joins watermarks monotonically without revising unchanged entries", { tags: "p0" }, () => {
        const empty = InvalidationWatermark.empty(tenantId, owner, holder);
        const first = empty.join([new ScopeEpoch(tenantScope, 1)]);
        expect(first.revision.value).toBe(1);
        expect(first.epoch(tenantScope)).toBe(1);
        const unchanged = first.join([new ScopeEpoch(tenantScope, 1)]);
        expect(unchanged.revision.value).toBe(1);
        expect(unchanged.epoch(tenantScope)).toBe(1);
        const advanced = first.join([new ScopeEpoch(tenantScope, 2)]);
        expect(advanced.revision.value).toBe(2);
        expect(advanced.epoch(tenantScope)).toBe(2);
        const lowered = advanced.join([new ScopeEpoch(tenantScope, 1)]);
        expect(lowered.revision.value).toBe(2);
        expect(lowered.epoch(tenantScope)).toBe(2);
    });

    test("canonically orders delivered entries regardless of construction order", { tags: "p0" }, () => {
        const entries = [new ScopeEpoch(tenantScope, 1), new ScopeEpoch(workspaceScope, 2)];
        const forward = new InvalidationWatermark(
            tenantId,
            owner,
            holder,
            entries,
            Revision.initial()
        );
        const reversed = new InvalidationWatermark(
            tenantId,
            owner,
            holder,
            [...entries].reverse(),
            Revision.initial()
        );
        expect(forward.toData()).toEqual(reversed.toData());
        expect(forward.delivered.map((entry) => entry.epoch)).toEqual(
            reversed.delivered.map((entry) => entry.epoch)
        );
    });

    test("decodes watermarks strictly with exact owner kinds and subjects", { tags: "p0" }, () => {
        const record = new InvalidationWatermark(
            tenantId,
            owner,
            holder,
            [new ScopeEpoch(tenantScope, 1)],
            Revision.initial()
        );
        const data = record.toData();
        expect(() => InvalidationWatermark.fromData({ ...data, delivered: 3 })).toThrow(
            "Watermark entries must be an array"
        );
        expect(() => InvalidationWatermark.fromData({ ...data, ownerTenant: 3 })).toThrow(
            "Watermark owner Tenant must be a string"
        );
        for (const kind of ["tenant", "workspace", "run", "environment", "slate"] as const) {
            expect(
                InvalidationWatermark.fromData({
                    ...data,
                    owner: { id: "epoch-gate-owner", kind }
                }).owner.kind
            ).toBe(kind);
        }
        for (const kind of ["", "bogus"]) {
            expect(() =>
                InvalidationWatermark.fromData({ ...data, owner: { id: "epoch-gate-owner", kind } })
            ).toThrow("Watermark owner Actor kind is invalid");
        }
    });
});

describe("authority check request and evidence mutation gates", () => {
    test("rejects noncanonical nonces and operations with exact reasons", { tags: "p0" }, () => {
        const base = checkInit();
        expect(() => new AuthorityCheckRequest({ ...base, nonce: "" })).toThrow(
            "Authority check nonce must be canonical and nonblank"
        );
        expect(() => new AuthorityCheckRequest({ ...base, nonce: " padded " })).toThrow(
            "Authority check nonce must be canonical and nonblank"
        );
        expect(
            () =>
                new AuthorityCheckRequest({
                    ...base,
                    intent: { ...base.intent, operation: "" }
                })
        ).toThrow("Authority operation must be canonical and nonblank");
    });

    test("round-trips delegate-impact intents through the codec", { tags: "p0" }, () => {
        const base = checkInit();
        const request = new AuthorityCheckRequest({
            ...base,
            intent: { ...base.intent, impact: "delegate" },
            nonce: "epoch-gate-delegate"
        });
        const decoded = AuthorityCheckRequest.fromData(request.toData());
        expect(decoded.intent.impact).toBe("delegate");
        expect(decoded.digest().equals(request.digest())).toBe(true);
    });

    test("enforces decision-reason coherence and canonical Grant evidence exactly", { tags: "p0" }, () => {
        expect(() =>
            evidence({ decision: "allow", reason: "noMatchingAllow", matchedAllow: [grantId] })
        ).toThrow("Only allowed authority evidence may carry the allowed reason");
        expect(() =>
            evidence({ decision: "deny", reason: "revokedGrant", matchedAllow: [grantId] })
        ).toThrow("Non-matching authority denials cannot carry matched Grants");
        expect(() =>
            evidence({
                decision: "deny",
                reason: "missingGrant",
                matchedAllow: [],
                matchedDeny: [new GrantId("gate-stray-deny")]
            })
        ).toThrow("Non-matching authority denials cannot carry matched Grants");
        expect(() => evidence({ checkedAt: new Date(-1) })).toThrow(
            "Authority check time is invalid"
        );
        expect(evidence({ checkedAt: new Date(0) }).checkedAt.getTime()).toBe(0);
        const ordered = evidence({
            matchedAllow: [new GrantId("gate-bb"), new GrantId("gate-aa")]
        });
        expect(ordered.matchedAllow.map((id) => id.value)).toEqual(["gate-aa", "gate-bb"]);
        const denied = evidence({
            decision: "deny",
            reason: "matchingDeny",
            matchedAllow: [],
            matchedDeny: [new GrantId("gate-deny-b"), new GrantId("gate-deny-a")]
        });
        expect(denied.toData()["matchedDeny"]).toEqual(["gate-deny-a", "gate-deny-b"]);
    });

    test("binds evidence to the exact request digest, Binding key, and generation", { tags: "p0" }, () => {
        expect(evidence().binds(baseRequest)).toBe(true);
        expect(evidence({ requestDigest: Digest.sha256(Uint8Array.of(9)) }).binds(baseRequest)).toBe(
            false
        );
        expect(evidence({ bindingKey: "epoch-gate-other-key" }).binds(baseRequest)).toBe(false);
        expect(evidence({ bindingGeneration: binding.generation + 1 }).binds(baseRequest)).toBe(
            false
        );
    });

    test("decodes evidence strictly across reasons, decisions, and issuers", { tags: "p0" }, () => {
        const data = evidence({
            decision: "deny",
            reason: "noMatchingAllow",
            matchedAllow: []
        }).toData();
        expect(() =>
            AuthorityCheckEvidence.fromData({
                ...data,
                issuer: { id: "epoch-gate-issuer", kind: "bogus" }
            })
        ).toThrow("Authority Actor kind is invalid");
        expect(() => AuthorityCheckEvidence.fromData({ ...data, decision: "bogus" })).toThrow(
            "Authority decision is invalid"
        );
        expect(() => AuthorityCheckEvidence.fromData({ ...data, reason: "bogus" })).toThrow(
            "Authority decision reason is invalid"
        );
        expect(() => AuthorityCheckEvidence.fromData({ ...data, matchedAllow: 3 })).toThrow(
            "Matched allow Grants must be an array"
        );
        expect(() => AuthorityCheckEvidence.fromData({ ...data, matchedDeny: 3 })).toThrow(
            "Matched deny Grants must be an array"
        );
        expect(() => AuthorityCheckEvidence.fromData({ ...data, matchedAllow: [3] })).toThrow(
            "Matched allow Grants entry 0 must be a string"
        );
        const reasons = [
            "allowed",
            "missingPrincipal",
            "inactivePrincipal",
            "invalidBinding",
            "missingGrant",
            "revokedGrant",
            "invalidDelegation",
            "guestElevation",
            "guestVerificationExpired",
            "noMatchingAllow",
            "matchingDeny",
            "stalePath"
        ] as const;
        for (const reason of reasons) {
            const decoded = AuthorityCheckEvidence.fromData({
                ...data,
                decision: reason === "allowed" ? "allow" : "deny",
                reason,
                matchedAllow: reason === "allowed" ? ["epoch-gate-grant"] : [],
                matchedDeny: reason === "matchingDeny" ? ["epoch-gate-deny"] : []
            });
            expect(decoded.reason).toBe(reason);
        }
    });
});

describe("memory invalidation watermark store mutation gates", () => {
    test("enforces owner identity, initialization, and revision continuity with exact codes", { tags: "p0" }, () => {
        const store = new MemoryInvalidationWatermarkStore(tenantId, owner);
        const foreign = InvalidationWatermark.empty(
            tenantId,
            new ActorRef("workspace", new ActorId("epoch-gate-foreign-owner")),
            holder
        );
        expectAgentError(
            () => store.save(foreign),
            "protocol.invalid-state",
            "Watermark belongs to another Actor store"
        );
        const seeded = new InvalidationWatermark(
            tenantId,
            owner,
            holder,
            [new ScopeEpoch(tenantScope, 1)],
            new Revision(1)
        );
        expectAgentError(
            () => store.save(seeded),
            "protocol.revision-conflict",
            "New watermarks require revision zero"
        );
        expectAgentError(
            () => store.join(watermarkKey(seeded), [new ScopeEpoch(tenantScope, 1)]),
            "protocol.invalid-state",
            "Watermark must be initialized before join"
        );
        const empty = InvalidationWatermark.empty(tenantId, owner, holder);
        store.save(empty);
        const skipped = empty
            .join([new ScopeEpoch(tenantScope, 1)])
            .join([new ScopeEpoch(tenantScope, 2)]);
        expect(skipped.revision.value).toBe(2);
        expectAgentError(
            () => store.save(skipped),
            "protocol.revision-conflict",
            "Watermark updates require monotonic entries and the next revision"
        );
    });

    test("persists each changed watermark and reloads the exact revision", { tags: "p0" }, () => {
        const store = new MemoryInvalidationWatermarkStore(tenantId, owner);
        const empty = InvalidationWatermark.empty(tenantId, owner, holder);
        const key = watermarkKey(empty);
        store.save(empty);
        const first = empty.join([new ScopeEpoch(tenantScope, 1)]);
        store.save(first);
        const second = first.join([new ScopeEpoch(tenantScope, 2)]);
        store.save(second);
        expect(store.load(key)?.revision.value).toBe(2);
        expect(store.load(key)?.epoch(tenantScope)).toBe(2);
        store.save(second);
        expect(store.load(key)?.revision.value).toBe(2);
    });

    test("snapshots records in canonical key order with isolated bytes", { tags: "p0" }, () => {
        const store = new MemoryInvalidationWatermarkStore(tenantId, owner);
        const first = InvalidationWatermark.empty(
            tenantId,
            owner,
            new PrincipalRef(tenantId, new PrincipalId("epoch-gate-holder-a"))
        );
        const second = InvalidationWatermark.empty(
            tenantId,
            owner,
            new PrincipalRef(tenantId, new PrincipalId("epoch-gate-holder-b"))
        );
        expect(watermarkKey(first).localeCompare(watermarkKey(second))).toBeLessThan(0);
        store.save(second);
        store.save(first);
        expect(store.snapshot().records.map((record) => record.key)).toEqual([
            watermarkKey(first),
            watermarkKey(second)
        ]);

        const saved = InvalidationWatermark.empty(tenantId, owner, holder).join([
            new ScopeEpoch(tenantScope, 1)
        ]);
        const bytes = InvalidationWatermark.encode(saved);
        const key = watermarkKey(saved);
        const restored = new MemoryInvalidationWatermarkStore(tenantId, owner, {
            version: 1,
            records: [{ key, bytes }]
        });
        bytes.fill(0);
        expect(restored.load(key)?.revision.value).toBe(1);
        expect(restored.load(key)?.epoch(tenantScope)).toBe(1);
    });

    test("rejects malformed snapshots and records with the exact codec error", { tags: "p0" }, () => {
        const saved = InvalidationWatermark.empty(tenantId, owner, holder);
        const bytes = InvalidationWatermark.encode(saved);
        const key = watermarkKey(saved);
        const extraSnapshot: MemoryInvalidationWatermarkSnapshot & { readonly extra: boolean } = {
            version: 1,
            records: [],
            extra: true
        };
        expectAgentError(
            () => new MemoryInvalidationWatermarkStore(tenantId, owner, extraSnapshot),
            "codec.invalid",
            "Memory watermark snapshot is malformed"
        );
        expectAgentError(
            () =>
                new MemoryInvalidationWatermarkStore(tenantId, owner, {
                    version: 1,
                    records: [{ key: "", bytes }]
                }),
            "codec.invalid",
            "Memory watermark snapshot record is malformed"
        );
        const overloadedRecord = { key, bytes, extra: true };
        const extraRecordSnapshot: MemoryInvalidationWatermarkSnapshot = {
            version: 1,
            records: [overloadedRecord]
        };
        expectAgentError(
            () => new MemoryInvalidationWatermarkStore(tenantId, owner, extraRecordSnapshot),
            "codec.invalid",
            "Memory watermark snapshot record is malformed"
        );
    });
});

function checkInit(): ConstructorParameters<typeof AuthorityCheckRequest>[0] {
    return {
        ownerTenant: tenantId,
        owner,
        ownerFence: 1,
        principal: holder,
        binding,
        intent: {
            facet,
            operation: "read",
            impact: "observe",
            arguments: args,
            argumentsDigest: argsDigest
        },
        expectedPath: basePath,
        invocationDigest: Digest.sha256(Uint8Array.of(3)),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: "epoch-gate-check"
    };
}

function evidence(
    overrides: {
        requestDigest?: Digest;
        bindingKey?: string;
        bindingGeneration?: number;
        decision?: "allow" | "deny";
        reason?: AuthorityCheckEvidence["reason"];
        matchedAllow?: readonly GrantId[];
        matchedDeny?: readonly GrantId[];
        checkedAt?: Date;
    } = {}
): AuthorityCheckEvidence {
    return new AuthorityCheckEvidence(
        tenantId,
        issuer,
        overrides.requestDigest ?? baseRequest.digest(),
        overrides.bindingKey ?? binding.key,
        overrides.bindingGeneration ?? binding.generation,
        overrides.decision ?? "allow",
        overrides.reason ?? "allowed",
        overrides.matchedAllow ?? [grantId],
        overrides.matchedDeny ?? [],
        basePath,
        overrides.checkedAt ?? new Date(10)
    );
}

function expectAgentError(action: () => unknown, code: AgentCoreErrorCode, message: string): void {
    try {
        action();
        throw new Error("Expected AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code, message });
    }
}
