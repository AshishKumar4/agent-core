import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, Revision, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { AgentCoreError, type AgentCoreErrorCode } from "../../src/errors";
import { BindingName, FacetRef, ProtectionDomain } from "../../src/facets";
import {
    PrincipalId,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId,
    encodeScopeRef,
    encodeSubjectRef
} from "../../src/identity";
import { PrincipalRef } from "../identity/internal-fixture";
import { Binding, decodeDomain, domainKey } from "../../src/authority/binding";
import {
    BindingValidationEvidence,
    BindingValidationRequest
} from "../../src/authority/binding-evidence";
import { MemoryBindingStore } from "../../src/authority/binding-store";
import { PathEpochEvidence, ScopeEpoch } from "../../src/authority/epoch";
import { AuthorityCheckRequest } from "../../src/authority/evidence";
import { GrantId } from "../../src/authority/id";
import { authorityKey } from "../../src/authority/key";
import { scopeKey, subjectKey } from "../../src/authority/reference";

const tenantId = new TenantId("binding-mutation-tenant");
const workspaceScope = ScopeRef.workspace(tenantId, new WorkspaceId("binding-mutation-workspace"));
const otherWorkspaceScope = ScopeRef.workspace(tenantId, new WorkspaceId("binding-mutation-other"));
const tenantScope = ScopeRef.tenant(tenantId);
const principalId = new PrincipalId("binding-mutation-principal");
const subject = SubjectRef.principal(principalId);
const domain = new ProtectionDomain("backend", "mutation", "no-secrets");
const encodedDomain = { kind: "backend", label: "mutation", secretPolicy: "no-secrets" } as const;

function facet(): FacetRef {
    return new FacetRef("workspace:mutation.facet");
}

function grantId(): GrantId {
    return new GrantId("mutation-grant");
}

function makeBinding(name = "mutation-binding"): Binding {
    return Binding.active(
        workspaceScope,
        subject,
        domain,
        new BindingName(name),
        grantId(),
        facet()
    );
}

function bindingAt(name: string, generation: number, revision: number): Binding {
    return new Binding(
        workspaceScope,
        subject,
        domain,
        new BindingName(name),
        grantId(),
        facet(),
        generation,
        "active",
        new Revision(revision)
    );
}

function epochPath(): PathEpochEvidence {
    return new PathEpochEvidence([
        new ScopeEpoch(tenantScope, 1),
        new ScopeEpoch(workspaceScope, 2)
    ]);
}

function validationInit(): ConstructorParameters<typeof BindingValidationRequest>[0] {
    return {
        ownerTenant: tenantId,
        workspaceActor: new ActorRef("workspace", new ActorId("binding-mutation-owner")),
        workspaceFence: 1,
        scope: workspaceScope,
        domain,
        name: new BindingName("mutation-binding"),
        grantId: grantId(),
        facet: facet(),
        nonce: "binding-mutation-validation"
    };
}

function validationRequest(): BindingValidationRequest {
    return new BindingValidationRequest(validationInit());
}

function validationEvidence(
    overrides: { scope?: ScopeRef; checkedAt?: Date } = {}
): BindingValidationEvidence {
    return new BindingValidationEvidence(
        tenantId,
        new ActorRef("tenant", new ActorId("binding-mutation-issuer")),
        validationRequest().digest(),
        overrides.scope ?? workspaceScope,
        subject,
        grantId(),
        epochPath(),
        overrides.checkedAt ?? new Date(10)
    );
}

function expectTypeError(action: () => unknown, message: string): void {
    try {
        action();
        throw new Error("Expected a TypeError");
    } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect(error).toMatchObject({ message });
    }
}

function expectAgentError(action: () => unknown, code: AgentCoreErrorCode, message: string): void {
    try {
        action();
        throw new Error("Expected an AgentCoreError");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code, message });
    }
}

describe("authority key identity", () => {
    test(
        "[C13-AUTH-BINDING-RESOLUTION] pins exact binding, domain, scope, and subject key formats",
        { tags: "p0" },
        () => {
            const binding = makeBinding();
            expect(binding.key).toBe(
                authorityKey("binding", [
                    encodeScopeRef(workspaceScope),
                    encodeSubjectRef(subject),
                    encodedDomain,
                    "mutation-binding"
                ])
            );
            expect(domainKey(domain)).toBe(authorityKey("domain", [encodedDomain]));
            expect(scopeKey(workspaceScope)).toBe(
                authorityKey("scope", [encodeScopeRef(workspaceScope)])
            );
            expect(subjectKey(subject)).toBe(authorityKey("subject", [encodeSubjectRef(subject)]));
        }
    );
});

describe("Binding replacement identity", () => {
    test(
        "[C13-AUTH-BINDING-RESOLUTION] rejects replacements that change identity or skip generation or revision",
        { tags: "p0" },
        () => {
            const base = makeBinding();
            expect(() => base.assertCanReplace(base.replace(grantId(), facet()))).not.toThrow();
            const invalidMessage =
                "Binding updates require immutable identity and the next generation and revision";
            expectAgentError(
                () => base.assertCanReplace(bindingAt("mutation-renamed", 1, 1)),
                "binding.invalid",
                invalidMessage
            );
            expectAgentError(
                () => base.assertCanReplace(bindingAt("mutation-binding", 2, 1)),
                "binding.invalid",
                invalidMessage
            );
            expectAgentError(
                () => base.assertCanReplace(bindingAt("mutation-binding", 1, 2)),
                "binding.invalid",
                invalidMessage
            );
        }
    );

    test(
        "[C13-AUTH-BINDING-RESOLUTION] refuses transitions past the final generation",
        { tags: "p0" },
        () => {
            const exhausted = bindingAt("mutation-binding", Number.MAX_SAFE_INTEGER, 0);
            expectAgentError(
                () => exhausted.replace(grantId(), facet()),
                "binding.invalid",
                "Binding generation is exhausted"
            );
        }
    );
});

describe("Binding codec field gates", () => {
    test(
        "[C13-AUTH-BINDING-RESOLUTION] round-trips Binding data and names each malformed field exactly",
        { tags: "p0" },
        () => {
            const binding = makeBinding();
            const data = binding.toData();
            const decoded = Binding.fromData(data);
            expect(decoded.key).toBe(binding.key);
            expect(decoded.name.value).toBe("mutation-binding");
            expect(decoded.grantId.value).toBe("mutation-grant");
            expect(decoded.facet.value).toBe("workspace:mutation.facet");
            expectTypeError(
                () => Binding.fromData({ ...data, name: 3 }),
                "Binding name must be a string"
            );
            expectTypeError(
                () => Binding.fromData({ ...data, grantId: 3 }),
                "Grant ID must be a string"
            );
            expectTypeError(
                () => Binding.fromData({ ...data, facet: 3 }),
                "Facet reference must be a string"
            );
        }
    );

    test(
        "[C13-AUTH-BINDING-RESOLUTION] strictly decodes protection domains",
        { tags: "p0" },
        () => {
            for (const value of [undefined, null, [], "backend", 3] as const) {
                expectTypeError(() => decodeDomain(value), "Protection domain must be an object");
            }
            expectTypeError(
                () => decodeDomain({ kind: "backend", label: 3, secretPolicy: "no-secrets" }),
                "Protection domain label must be a string"
            );
            const frontend = decodeDomain({
                kind: "frontend",
                label: "edge",
                secretPolicy: "no-secrets"
            });
            expect(frontend.kind).toBe("frontend");
            expect(frontend.label).toBe("edge");
            expect(frontend.secretPolicy).toBe("no-secrets");
            const backend = decodeDomain({
                kind: "backend",
                label: "vault",
                secretPolicy: "may-hold-secrets"
            });
            expect(backend.kind).toBe("backend");
            expect(backend.secretPolicy).toBe("may-hold-secrets");
        }
    );
});

describe("Binding validation request and evidence gates", () => {
    test(
        "[C13-AUTH-PATH-EVIDENCE] accepts exact boundary values and rejects noncanonical inputs",
        { tags: "p0" },
        () => {
            expect(
                new BindingValidationRequest({ ...validationInit(), workspaceFence: 0 })
                    .workspaceFence
            ).toBe(0);
            expectTypeError(
                () => new BindingValidationRequest({ ...validationInit(), nonce: " padded " }),
                "Binding validation nonce must be canonical and nonblank"
            );
            expect(validationEvidence({ checkedAt: new Date(0) }).checkedAt.getTime()).toBe(0);
            expectTypeError(
                () => validationEvidence({ checkedAt: new Date(Number.NaN) }),
                "Binding validation time is invalid"
            );
            expectTypeError(
                () => validationEvidence({ scope: otherWorkspaceScope }),
                "Binding validation path must end at its Workspace Scope"
            );
        }
    );

    test(
        "[C13-AUTH-PATH-EVIDENCE] decodes workspace fences as non-negative safe integers only",
        { tags: "p0" },
        () => {
            const payload = validationRequest().toData();
            expect(
                BindingValidationRequest.fromData({ ...payload, workspaceFence: 0 }).workspaceFence
            ).toBe(0);
            for (const fence of ["1", true, 1.5, -1, 2 ** 53] as const) {
                expectTypeError(
                    () => BindingValidationRequest.fromData({ ...payload, workspaceFence: fence }),
                    "workspaceFence must be a non-negative safe integer"
                );
            }
        }
    );

    test(
        "[C13-AUTH-PATH-EVIDENCE] binds evidence to the exact request it validated",
        { tags: "p0" },
        () => {
            const record = validationEvidence();
            expect(record.binds(validationRequest())).toBe(true);
            expect(
                record.binds(
                    new BindingValidationRequest({
                        ...validationInit(),
                        nonce: "binding-mutation-differs"
                    })
                )
            ).toBe(false);
        }
    );

    test(
        "[C13-AUTH-PATH-EVIDENCE] validates evidence time and Scope-to-path alignment",
        { tags: "p0" },
        () => {
            expectTypeError(
                () => validationEvidence({ checkedAt: new Date(Number.NaN) }),
                "Binding validation time is invalid"
            );
            expectTypeError(
                () => validationEvidence({ checkedAt: new Date(-5) }),
                "Binding validation time is invalid"
            );
            expectTypeError(
                () =>
                    new BindingValidationEvidence(
                        tenantId,
                        new ActorRef("tenant", new ActorId("binding-mutation-issuer")),
                        validationRequest().digest(),
                        tenantScope,
                        subject,
                        grantId(),
                        new PathEpochEvidence([new ScopeEpoch(tenantScope, 1)]),
                        new Date(10)
                    ),
                "Binding validation path must end at its Workspace Scope"
            );
            expectTypeError(
                () =>
                    new BindingValidationEvidence(
                        tenantId,
                        new ActorRef("tenant", new ActorId("binding-mutation-issuer")),
                        validationRequest().digest(),
                        workspaceScope,
                        subject,
                        grantId(),
                        new PathEpochEvidence([
                            new ScopeEpoch(tenantScope, 1),
                            new ScopeEpoch(otherWorkspaceScope, 2)
                        ]),
                        new Date(10)
                    ),
                "Binding validation path must end at its Workspace Scope"
            );
        }
    );

    test(
        "[C13-AUTH-PATH-EVIDENCE] decodes every Actor kind and requires a Tenant issuer",
        { tags: "p0" },
        () => {
            const payload = validationEvidence().toData();
            expect(BindingValidationEvidence.fromData(payload).issuer.kind).toBe("tenant");
            for (const kind of ["workspace", "run", "environment", "slate"] as const) {
                expectTypeError(
                    () =>
                        BindingValidationEvidence.fromData({
                            ...payload,
                            issuer: { id: "binding-mutation-imposter", kind }
                        }),
                    "Binding validation evidence must be issued by a Tenant Actor"
                );
            }
            expectTypeError(
                () =>
                    BindingValidationEvidence.fromData({
                        ...payload,
                        issuer: { id: "binding-mutation-imposter", kind: "unknown" }
                    }),
                "Binding validation Actor kind is invalid"
            );
        }
    );
});

describe("memory Binding store gates", () => {
    test(
        "[C13-AUTH-BINDING-RESOLUTION] lists and snapshots Bindings in key order with detached bytes",
        { tags: "p0" },
        () => {
            const store = new MemoryBindingStore(workspaceScope);
            const late = makeBinding("zz-binding");
            const early = makeBinding("aa-binding");
            store.save(late);
            store.save(early);
            expect(store.list().map((binding) => binding.name.value)).toEqual([
                "aa-binding",
                "zz-binding"
            ]);
            const snapshot = store.snapshot();
            expect(snapshot.records.map((record) => record.key)).toEqual([early.key, late.key]);
            const restored = new MemoryBindingStore(workspaceScope, snapshot);
            expect(restored.list().map((binding) => binding.name.value)).toEqual([
                "aa-binding",
                "zz-binding"
            ]);
            snapshot.records.at(0)?.bytes.fill(0);
            snapshot.records.at(1)?.bytes.fill(0);
            expect(restored.load(early.key)?.grantId.value).toBe("mutation-grant");
            expect(restored.load(late.key)?.grantId.value).toBe("mutation-grant");
        }
    );

    test(
        "[C13-AUTH-BINDING-RESOLUTION] persists replacements and rejects conflicting saves exactly",
        { tags: "p0" },
        () => {
            const store = new MemoryBindingStore(workspaceScope);
            const base = makeBinding();
            store.save(base);
            store.save(base);
            store.save(base.replace(grantId(), facet()));
            expect(store.load(base.key)?.generation).toBe(1);
            expect(store.load(base.key)?.revision.value).toBe(1);
            expectAgentError(
                () =>
                    store.save(
                        Binding.active(
                            otherWorkspaceScope,
                            subject,
                            domain,
                            new BindingName("foreign-binding"),
                            grantId(),
                            facet()
                        )
                    ),
                "binding.invalid",
                "Binding belongs to another Workspace store"
            );
            expectAgentError(
                () => store.save(bindingAt("fresh-generation", 1, 0)),
                "protocol.revision-conflict",
                "New Bindings require generation and revision zero"
            );
            expectAgentError(
                () => store.save(bindingAt("fresh-revision", 0, 1)),
                "protocol.revision-conflict",
                "New Bindings require generation and revision zero"
            );
        }
    );

    test(
        "[C13-AUTH-BINDING-RESOLUTION] rejects malformed snapshots and records with exact codec errors",
        { tags: "p0" },
        () => {
            const seeded = new MemoryBindingStore(workspaceScope);
            seeded.save(makeBinding());
            const record = seeded.snapshot().records.at(0);
            if (record === undefined) throw new Error("Expected one snapshot record");
            const snapshotMessage = "Memory Binding snapshot is malformed";
            const recordMessage = "Memory Binding snapshot record is malformed";
            expectAgentError(
                () => new MemoryBindingStore(workspaceScope, null as never),
                "codec.invalid",
                snapshotMessage
            );
            const callableSnapshot = Object.assign(() => undefined, {
                records: [record],
                version: 1
            });
            expectAgentError(
                () => new MemoryBindingStore(workspaceScope, callableSnapshot as never),
                "codec.invalid",
                snapshotMessage
            );
            expectAgentError(
                () =>
                    new MemoryBindingStore(workspaceScope, {
                        version: 1,
                        records: [record],
                        audit: []
                    } as never),
                "codec.invalid",
                snapshotMessage
            );
            expectAgentError(
                () =>
                    new MemoryBindingStore(workspaceScope, {
                        version: 1,
                        records: [undefined as never]
                    }),
                "codec.invalid",
                recordMessage
            );
            expectAgentError(
                () =>
                    new MemoryBindingStore(workspaceScope, {
                        version: 1,
                        records: [
                            { key: record.key, bytes: record.bytes.slice(), audit: true } as never
                        ]
                    }),
                "codec.invalid",
                recordMessage
            );
            expectAgentError(
                () =>
                    new MemoryBindingStore(workspaceScope, {
                        version: 1,
                        records: [{ key: 3 as never, bytes: record.bytes.slice() }]
                    }),
                "codec.invalid",
                recordMessage
            );
            expectAgentError(
                () =>
                    new MemoryBindingStore(workspaceScope, {
                        version: 1,
                        records: [{ key: "", bytes: record.bytes.slice() }]
                    }),
                "codec.invalid",
                recordMessage
            );
        }
    );
});

describe("Grant identifier gates", () => {
    test(
        "[C13-AUTH-DENY-PATH] enforces exact identifier length boundaries and names",
        { tags: "p0" },
        () => {
            expectTypeError(
                () => GrantId.forRole("", 0),
                "Membership ID must contain between 1 and 256 characters"
            );
            expectTypeError(
                () => GrantId.forRole("x".repeat(257), 0),
                "Membership ID must contain between 1 and 256 characters"
            );
            expect(GrantId.forRole("x".repeat(256), 0).value.startsWith("role:")).toBe(true);
            expectTypeError(
                () => new GrantId(""),
                "Grant ID must contain between 1 and 256 characters"
            );
        }
    );
});

describe("canonical argument freezing", () => {
    test(
        "[C13-AUTH-PATH-EVIDENCE] deep-freezes canonical check arguments including nested objects",
        { tags: "p0" },
        () => {
            const argumentsValue: JsonValue = {
                count: 3,
                outer: { hole: null, text: "value" }
            };
            const request = new AuthorityCheckRequest({
                ownerTenant: tenantId,
                owner: new ActorRef("workspace", new ActorId("binding-mutation-owner")),
                ownerFence: 1,
                principal: new PrincipalRef(tenantId, principalId),
                binding: makeBinding(),
                intent: {
                    facet: facet(),
                    operation: "read",
                    impact: "observe",
                    arguments: argumentsValue,
                    argumentsDigest: Digest.sha256(encodeCanonicalJson(argumentsValue))
                },
                expectedPath: epochPath(),
                invocationDigest: Digest.sha256(Uint8Array.of(3)),
                itemIndex: 0,
                attemptOrdinal: 0,
                nonce: "binding-mutation-check"
            });
            const canonical = request.intent.arguments;
            expect(canonical).toEqual(argumentsValue);
            expect(Object.isFrozen(canonical)).toBe(true);
            if (canonical === null || typeof canonical !== "object" || Array.isArray(canonical)) {
                throw new Error("Expected canonical object arguments");
            }
            expect(Object.isFrozen(canonical["outer"])).toBe(true);
        }
    );
});
