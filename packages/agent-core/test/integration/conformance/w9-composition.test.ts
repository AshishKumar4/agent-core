import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import {
    AuthorityPermit,
    AuthorityPermitIssuer,
    AuthorityPermitExpectation,
    Binding,
    GrantId,
    InvalidationWatermark,
    MemoryAuthorityPermitStore,
    PathEpochEvidence,
    ScopeEpoch,
    StoredAuthorityPermitAdmissionPort
} from "../../../src/authority";
import {
    ConsumedAuthorityAdmissionPort,
    IssuedAuthorityPermitPort,
    CanonicalSettlementEvidencePort,
    DurableRunAdmissionPort,
    InvocationComposition,
    ProvenanceFacetSlotBackend,
    TenantOperationAuthority,
    createProtectedProfileRuntime,
    type AuthorityPermitExpectationFactory,
    type OperationAuthorityStatePort,
    type OperationResolutionState
} from "../../../src/composition";
import { Digest, JsonSchema, Revision, SemVer } from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import { PackageId, PackageInstallationProvenancePort, PackagePin } from "../../../src/definition";
import {
    RunCommitId as ExecutionRunCommitId,
    RunId as ExecutionRunId
} from "../../../src/execution-references";
import {
    BindingName,
    FacetRef,
    Operation,
    OperationDescriptor,
    OperationName,
    OperationRef,
    ProfileRuntimeHostBinding,
    ProtectionDomain,
    type OperationContext,
    type ProtectedOperationRequest
} from "../../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../../src/identity";
import {
    ClaimWorkerId,
    ApprovalId,
    EffectAttemptId,
    ItemClaimId,
    ReceiptId
} from "../../../src/invocation-references";
import {
    AttemptReceipt,
    AuthorityAdmissionReference,
    type CanonicalBatchInvoker,
    InvocationId as InvocationContextId,
    InvocationProtectedOperationPort,
    InvocationPlacementPin,
    InvocationPublicationOutbox,
    MemoryInvocationMediationPersistence,
    cloneInvocationMediationMemoryState,
    createInvocationMediationMemoryState,
    type AuthorityAdmissionContext,
    type CanonicalBatchInvocationRequest,
    type InvocationMediationMemoryState,
    type InvocationTransactionPort
} from "../../../src/invocations";
import {
    AuditRecordId,
    InvocationId,
    InvocationId as InteractionInvocationId,
    RouteReservationId
} from "../../../src/interaction-references";
import { OperationRequestKey } from "../../../src/operations";
import {
    MemoryRunStorage,
    RunAdmissionRegistry,
    RunId,
    RunRepository,
    SettlementObligation,
    TurnId,
    TurnLease,
    isSettled
} from "../../../src/agents";
import * as packageRoot from "../../../src/index";
import { WorkspaceId as RoutedWorkspaceId } from "../../../src/workspaces";

const tenant = new TenantId("w9-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("w9-principal"));
const owner = new ActorRef("workspace", new ActorId("w9-owner"));
const issuer = new ActorRef("tenant", new ActorId("w9-issuer"));
const tenantScope = ScopeRef.tenant(tenant);
const scope = ScopeRef.workspace(tenant, new WorkspaceId("w9-workspace"));
const facet = new FacetRef("workspace:target");
const bindingName = new BindingName("target");
const domain = new ProtectionDomain("backend", "w9-domain", "may-hold-secrets");
const descriptor = new OperationDescriptor(
    new OperationName("send"),
    "externalSend",
    new JsonSchema({}),
    new JsonSchema({})
);

describe("W9 internal typed composition", () => {
    test("rejects stale authority and preserves an opaque no-write direct stamp", async () => {
        const state = new AuthorityState();
        const authority = new TenantOperationAuthority(state, () => new Date(10));
        const resolved = await authority.resolve(principal, bindingName);

        const directDescriptor = new OperationDescriptor(
            new OperationName("read"),
            "observe",
            new JsonSchema({}),
            new JsonSchema({})
        );
        expect(authority.tier(resolved.resolution, directDescriptor, false)).toBe("direct");
        const stamp = authority.authorizeDirect(resolved.resolution, directDescriptor, [{ id: 1 }]);
        expect(stamp?.binding).toBe(state.binding);
        expect(state.writes).toBe(0);

        state.path = new PathEpochEvidence([
            ScopeEpoch.initial(tenantScope),
            new ScopeEpoch(scope, 1)
        ]);
        expect(
            authority.authorizeDirect(resolved.resolution, directDescriptor, [{ id: 1 }])
        ).toBeUndefined();
        await expect(
            authority.authorizeMediated(resolved.resolution, descriptor, [{ id: 1 }])
        ).rejects.toMatchObject({ code: "authority.denied" });
    });

    test("fails closed on substituted resolution evidence and only admits same-domain interception", async () => {
        const state = new AuthorityState();
        const unresolved = operationAuthority(state, { resolve: () => undefined });
        await expect(unresolved.resolve(principal, bindingName)).rejects.toMatchObject({
            code: "authority.denied"
        });

        const malformedDeadline = operationAuthority(state, {
            resolve: (caller) => ({
                ...state.resolve(caller)!,
                deadline: new Date(-1)
            })
        });
        await expect(malformedDeadline.resolve(principal, bindingName)).rejects.toThrow(
            /substituted resolution evidence/
        );
        const extendedDeadline = operationAuthority(state, {
            resolve: (caller) => ({
                ...state.resolve(caller)!,
                deadline: new Date(101)
            })
        });
        await expect(extendedDeadline.resolve(principal, bindingName)).rejects.toThrow(
            /exceeds the original Turn lease/
        );

        const authority = operationAuthority(state);
        const resolved = await authority.resolve(principal, bindingName);
        expect(authority.tier(resolved.resolution, descriptor, false)).toBe("mediated");
        const directDescriptor = new OperationDescriptor(
            new OperationName("read-intercepted"),
            "observe",
            new JsonSchema({}),
            new JsonSchema({})
        );
        expect(authority.tier(resolved.resolution, directDescriptor, true)).toBe("mediated");
        const intent = await authority.authorizeMediated(resolved.resolution, descriptor, [{}]);
        expect(intent).toMatchObject({ binding: state.binding, domain });
        expect(authority.replayBinding(intent, descriptor).execution.kind).toBe("lease");

        const routedAuthority = operationAuthority(state, {
            resolve: (caller) => ({
                ...state.resolve(caller)!,
                lease: undefined,
                originalLease: undefined,
                route: new RouteReservationId("w9-replay-route")
            })
        });
        const routed = await routedAuthority.resolve(principal, bindingName);
        const routedIntent = await routedAuthority.authorizeMediated(
            routed.resolution,
            descriptor,
            [{}]
        );
        expect(routedAuthority.replayBinding(routedIntent, descriptor).execution.kind).toBe(
            "route"
        );

        const interceptable = new OperationDescriptor(
            new OperationName("interceptable"),
            "observe",
            new JsonSchema({}),
            new JsonSchema({}),
            undefined,
            true
        );
        expect(
            authority.allowsInterception(
                resolved.resolution,
                facet,
                {} as never,
                facet,
                interceptable
            )
        ).toBe(true);
        expect(
            authority.allowsInterception(
                resolved.resolution,
                facet,
                {} as never,
                new FacetRef("workspace:substituted"),
                interceptable
            )
        ).toBe(false);
        expect(
            operationAuthority(state, { contributorDomain: () => undefined }).allowsInterception(
                resolved.resolution,
                facet,
                {} as never,
                facet,
                interceptable
            )
        ).toBe(false);
        for (const substitutedDomain of [
            new ProtectionDomain("frontend", domain.label, "no-secrets"),
            new ProtectionDomain(domain.kind, "other-label", domain.secretPolicy),
            new ProtectionDomain(domain.kind, domain.label, "no-secrets")
        ]) {
            expect(
                operationAuthority(state, {
                    contributorDomain: () => substitutedDomain
                }).allowsInterception(resolved.resolution, facet, {} as never, facet, interceptable)
            ).toBe(false);
        }
        expect(
            operationAuthority(state, { admitsInterception: () => false }).allowsInterception(
                resolved.resolution,
                facet,
                {} as never,
                facet,
                interceptable
            )
        ).toBe(false);
        authority.release(resolved.resolution);
    });

    test("consumes an exact issued permit once and denies substitution before admission", () => {
        const expected = permitExpectation();
        const permit = new AuthorityPermit({
            ...expected,
            nonce: "w9-permit-nonce",
            issuedAt: new Date(10),
            expiresAt: new Date(20)
        });
        const store = new MemoryAuthorityPermitStore(expected.target.actor);
        let denials = 0;
        const adapter = new ConsumedAuthorityAdmissionPort(
            new StoredAuthorityPermitAdmissionPort(store),
            new FixedExpectationFactory(expected),
            { deny: () => (denials += 1) },
            () => new Date(15)
        );
        const admission = new AuthorityAdmissionReference(permit.toData(), permit.digest());
        const context = admissionContext(expected);

        expect(
            store.transaction((transaction) => adapter.admits(transaction, admission, context))
        ).toBe(true);
        expect(
            store.transaction((transaction) => adapter.admits(transaction, admission, context))
        ).toBe(false);
        expect(denials).toBe(1);

        const substituted = new AuthorityAdmissionReference(
            permit.toData(),
            new Digest("f".repeat(64))
        );
        expect(
            store.transaction((transaction) => adapter.admits(transaction, substituted, context))
        ).toBe(false);
        expect(denials).toBe(2);
    });

    test("denies an expired issued permit without consuming its nonce", () => {
        const expected = permitExpectation();
        const permit = new AuthorityPermit({
            ...expected,
            nonce: "w9-expired-permit",
            issuedAt: new Date(10),
            expiresAt: new Date(20)
        });
        const store = new MemoryAuthorityPermitStore(expected.target.actor);
        let denials = 0;
        const adapter = new ConsumedAuthorityAdmissionPort(
            new StoredAuthorityPermitAdmissionPort(store),
            new FixedExpectationFactory(expected),
            { deny: () => (denials += 1) },
            () => new Date(20)
        );
        const admission = new AuthorityAdmissionReference(permit.toData(), permit.digest());

        expect(
            store.transaction((transaction) =>
                adapter.admits(transaction, admission, admissionContext(expected))
            )
        ).toBe(false);
        expect(denials).toBe(1);
        expect(
            store.transaction((transaction) => store.consumed(transaction, permit.nonce))
        ).toBeUndefined();
    });

    test("issues W2 permits through the asynchronous typed composition port", async () => {
        const expected = permitExpectation();
        const store = new MemoryAuthorityPermitStore(expected.issuer);
        const issuerPort = new IssuedAuthorityPermitPort(
            store,
            new AuthorityPermitIssuer(store, { admits: () => true }),
            new FixedExpectationFactory(expected),
            () => "w9-issued-port-nonce",
            () => new Date(10),
            10
        );

        const admission = await issuerPort.issue({} as never, {} as never);

        const permit = AuthorityPermit.fromData(admission.reference);
        expect(permit.nonce).toBe("w9-issued-port-nonce");
        expect(permit.digest().equals(admission.digest)).toBe(true);
        expect(
            store.transaction((transaction) => store.issued(transaction, permit.nonce)?.nonce)
        ).toBe(permit.nonce);
    });

    test("fails closed for malformed permits while preserving infrastructure failures", () => {
        const expected = permitExpectation();
        const store = new MemoryAuthorityPermitStore(expected.target.actor);
        let denials = 0;
        const malformedAdapter = new ConsumedAuthorityAdmissionPort(
            new StoredAuthorityPermitAdmissionPort(store),
            new FixedExpectationFactory(expected),
            { deny: () => (denials += 1) },
            () => new Date(15)
        );

        expect(
            store.transaction((transaction) =>
                malformedAdapter.admits(
                    transaction,
                    new AuthorityAdmissionReference({} as never, expected.intentDigest),
                    admissionContext(expected)
                )
            )
        ).toBe(false);
        expect(denials).toBe(1);

        const permit = new AuthorityPermit({
            ...expected,
            nonce: "w9-infrastructure-failure",
            issuedAt: new Date(10),
            expiresAt: new Date(20)
        });
        const failingAdapter = new ConsumedAuthorityAdmissionPort(
            {
                consume: () => {
                    throw new TypeError("permit store unavailable");
                }
            } as never,
            new FixedExpectationFactory(expected),
            { deny: () => (denials += 1) },
            () => new Date(15)
        );
        expect(() =>
            store.transaction((transaction) =>
                failingAdapter.admits(
                    transaction,
                    new AuthorityAdmissionReference(permit.toData(), permit.digest()),
                    admissionContext(expected)
                )
            )
        ).toThrow("permit store unavailable");
        expect(denials).toBe(1);
    });

    test("rejects invalid permit lifetimes before issuing authority", () => {
        const expected = permitExpectation();
        const store = new MemoryAuthorityPermitStore(expected.issuer);

        expect(
            () =>
                new IssuedAuthorityPermitPort(
                    store,
                    new AuthorityPermitIssuer(store, { admits: () => true }),
                    new FixedExpectationFactory(expected),
                    () => "unused-nonce",
                    () => new Date(10),
                    0
                )
        ).toThrow(/positive safe integer/);
    });

    test("delegates installation provenance and creates a protected profile runtime", () => {
        const provenance = new (class extends PackageInstallationProvenancePort<object, object> {
            protected authenticatedInstallation(): undefined {
                return undefined;
            }
        })();
        const slots = new ProvenanceFacetSlotBackend(
            {} as never,
            provenance,
            {} as never,
            {} as never
        );

        expect(slots.prepareContribution({}, {} as never)).toBeUndefined();

        const host = new ProfileRuntimeHostBinding(facet, bindingName);
        const runtime = createProtectedProfileRuntime(host, {} as never, {} as never);
        expect(runtime.host).toBe(host);
        expect(runtime.active).toBe(false);
        runtime.activate();
        expect(runtime.active).toBe(true);
        runtime.deactivate();
        expect(runtime.active).toBe(false);
    });

    test("captures exact reserved-minus-completed Run frontier across restart and close races", () => {
        const run = new RunId("w9-run");
        const initial = RunAdmissionRegistry.initial(run);
        const complete = initial.reserve({
            kind: "invocationItem",
            invocation: new InvocationId("w9-complete"),
            itemIndex: 0,
            itemKey: "complete-key"
        });
        const pending = complete.registry.reserve({
            kind: "invocationItem",
            invocation: new InvocationId("w9-pending"),
            itemIndex: 1,
            itemKey: "pending-key"
        });
        expect(pending.registry.reserve(pending.reservation.obligation).reservation).toEqual(
            pending.reservation
        );
        const registry = pending.registry.complete(complete.reservation);
        const storage = new MemoryRunStorage();
        const repository = new RunRepository(storage);
        repository.transaction((transaction) => repository.insertAdmission(transaction, registry));
        const restartedStorage = new MemoryRunStorage(storage.snapshot());
        const restartedRepository = new RunRepository(restartedStorage);
        const adapter = new DurableRunAdmissionPort(restartedRepository);
        expect(
            restartedRepository.transaction((transaction) =>
                restartedRepository.loadAdmission(transaction, run)?.frontier()
            )
        ).toEqual([pending.reservation.obligation]);
        expect(
            restartedRepository.transaction((transaction) =>
                adapter.accepts(transaction, pending.reservation)
            )
        ).toBe(true);
        expect(
            restartedRepository.transaction((transaction) =>
                adapter.accepts(transaction, {
                    ...pending.reservation,
                    obligation: {
                        kind: "invocationItem",
                        invocation: new InvocationId("w9-pending"),
                        itemIndex: 1,
                        itemKey: "substituted-key"
                    }
                })
            )
        ).toBe(false);
        expect(
            restartedRepository.transaction((transaction) =>
                adapter.accepts(transaction, {
                    ...pending.reservation,
                    registryEpoch: pending.reservation.registryEpoch + 1
                })
            )
        ).toBe(false);
        const closed = registry.close();
        expect(closed.frontier()).toEqual([pending.reservation.obligation]);
        expect(closed.accepts(pending.reservation)).toBe(false);
        expect(() =>
            closed.reserve({
                kind: "systemCommit",
                commit: new ExecutionRunCommitId("late-commit")
            })
        ).toThrow(/closed/);
        expect(closed.close()).toBe(closed);
    });

    test("settles every Run obligation through canonical identity adapters", () => {
        const approval = new ApprovalId("w9-settlement-approval");
        const invocation = new InvocationId("w9-settlement-invocation");
        const route = new RouteReservationId("w9-settlement-route");
        const attempt = new EffectAttemptId("w9-settlement-attempt");
        const commit = new ExecutionRunCommitId("w9-settlement-commit");
        const audit = new AuditRecordId("w9-settlement-audit");
        const seen = new Set<string>();
        const evidence = new CanonicalSettlementEvidencePort({
            approvalResolved: (_transaction: object, id: ApprovalId) => {
                seen.add(`approval:${id.value}`);
                return id.equals(approval);
            },
            invocationItemTerminal: (
                _transaction: object,
                id: InvocationId,
                itemIndex: number,
                itemKey: string
            ) => {
                seen.add(`item:${id.value}:${itemIndex}:${itemKey}`);
                return id.equals(invocation) && itemIndex === 0 && itemKey === "w9-item";
            },
            routeTerminal: (_transaction: object, id: RouteReservationId) => {
                seen.add(`route:${id.value}`);
                return id.equals(route);
            },
            reconciliationSuperseded: (_transaction: object, id: EffectAttemptId) => {
                seen.add(`reconciliation:${id.value}`);
                return id.equals(attempt);
            },
            commitExists: (_transaction: object, id: ExecutionRunCommitId) => {
                seen.add(`commit:${id.value}`);
                return id.equals(commit);
            },
            auditSatisfied: (_transaction: object, obligation) => {
                seen.add(`audit:${obligation.audit.value}`);
                return obligation.audit.equals(audit);
            }
        });
        const obligation = new SettlementObligation({
            registryEpoch: 8,
            obligations: [
                { kind: "approval", approval },
                {
                    kind: "invocationItem",
                    invocation,
                    itemIndex: 0,
                    itemKey: "w9-item"
                },
                { kind: "route", reservation: route },
                { kind: "reconciliation", attempt },
                { kind: "systemCommit", commit }
            ],
            requiredAudits: [{ audit, evidence: { kind: "commit", id: commit } }]
        });

        expect(isSettled({}, obligation, evidence)).toBe(true);
        expect(seen.size).toBe(6);
    });

    test("replays per-item mediation and retries the durable outbox after crashes", async () => {
        const transactions = new MemoryTransactions();
        const persistence = new MemoryInvocationMediationPersistence();
        const invocation = new InvocationId("w9-replay");
        const batch = new SuccessfulBatch(invocation);
        const deliveredEvents = new Set<string>();
        const deliveredCommits = new Set<string>();
        let eventCrash = true;
        let commitCrash = true;
        const composition = new InvocationComposition({
            scope: "w9-scope",
            transactions,
            persistence,
            identities: { invocation: () => invocation },
            direct: { context: (_key, itemIndex) => operationContext(invocation, itemIndex) },
            mediated: batch,
            events: {
                publish: async (_outboxId, observation) => {
                    deliveredEvents.add(observation.receipt.value);
                    if (eventCrash) {
                        eventCrash = false;
                        throw new TypeError("event crash");
                    }
                }
            },
            commits: {
                append: async (_outboxId, observation) => {
                    deliveredCommits.add(observation.receipt.value);
                    if (commitCrash) {
                        commitCrash = false;
                        throw new TypeError("commit crash");
                    }
                }
            },
            now: () => new Date(30)
        });
        const preflight = {
            requestKey: new OperationRequestKey("w9-request"),
            facet,
            descriptor,
            shape: { kind: "batch" as const, itemCount: 2 },
            inputs: [{ raw: 1 }, { raw: 2 }],
            authorization: "permit",
            replayBinding: w9ReplayBinding()
        };
        let before = 0;
        const prepared = await composition.operations.prepareMediated(preflight, () => {
            before += 1;
            return { inputs: [{ value: 1 }, { value: 2 }], interceptions: [[], []] };
        });
        expect(prepared.kind).toBe("new");
        const result = await composition.operations.invoke({
            ...preflight,
            inputs: prepared.kind === "new" ? prepared.preparation.inputs : [],
            interceptions: prepared.kind === "new" ? prepared.preparation.interceptions : [],
            authorization: "permit",
            execute: async (itemIndex) => ({ itemIndex })
        });
        await composition.operations.presentMediated(
            result.evidence,
            result.outputs,
            (_itemIndex, output) => ({ value: output, traces: [] }),
            {
                requestKey: preflight.requestKey,
                facet,
                descriptor,
                shape: preflight.shape
            }
        );
        const replay = await composition.operations.prepareMediated(preflight, () => {
            before += 1;
            throw new TypeError("must not rerun");
        });
        expect(replay.kind).toBe("replay");
        expect(before).toBe(1);
        expect(batch.calls).toBe(1);
        await expect(
            composition.operations.prepareMediated(
                { ...preflight, inputs: [{ changed: true }, { raw: 2 }] },
                () => ({ inputs: [], interceptions: [] })
            )
        ).rejects.toMatchObject({ code: "invocation.invalid" });

        const publication = InvocationPublicationOutbox.pending({
            invocation,
            receipt: new ReceiptId("w9-outbox-receipt"),
            audit: expectedAuditId()
        });
        transactions.transact((transaction) =>
            persistence.appendPublication(transaction, publication)
        );
        await expect(composition.outbox.flush()).rejects.toThrow("event crash");
        await expect(composition.outbox.flush()).rejects.toThrow("commit crash");
        await composition.outbox.flush();
        await composition.outbox.flush();
        expect([...deliveredEvents]).toEqual(["w9-outbox-receipt"]);
        expect([...deliveredCommits]).toEqual(["w9-outbox-receipt"]);
    });

    test("adapts profile mediation through the canonical batch invocation port", async () => {
        const invocation = new InvocationId("w9-profile-invocation");
        const batch = new SuccessfulBatch<ProtectedOperationRequest>(invocation);
        const adapter = new InvocationProtectedOperationPort(
            { invocation: () => invocation },
            batch
        );
        const operation = new (class extends Operation {
            public readonly descriptor = descriptor;
            public async execute(_context: OperationContext, input: unknown) {
                return input as { readonly value: number };
            }
        })();

        const result = await adapter.invoke({
            facet,
            binding: bindingName,
            operation,
            input: { value: 7 },
            resultMode: "output"
        });
        expect(result).toMatchObject({ kind: "output", output: { value: 7 } });
        if (result.kind !== "output") throw new TypeError("Expected profile output");
        expect(result.receipt).toBeInstanceOf(AttemptReceipt);
        expect(batch.calls).toBe(1);
    });

    test("uses canonical constructors and keeps composition off the package surface", () => {
        expect(RunId).toBe(ExecutionRunId);
        expect(InvocationContextId).toBe(InteractionInvocationId);
        expect(WorkspaceId).toBe(RoutedWorkspaceId);
        expect("RunAdmissionRegistry" in packageRoot).toBe(false);
        expect("TenantOperationAuthority" in packageRoot).toBe(false);
    });
});

class AuthorityState implements OperationAuthorityStatePort<PrincipalRef> {
    public readonly binding = Binding.active(
        scope,
        SubjectRef.principal(principal.principalId),
        domain,
        bindingName,
        new GrantId("w9-grant"),
        facet
    );
    public path = new PathEpochEvidence([
        ScopeEpoch.initial(tenantScope),
        ScopeEpoch.initial(scope)
    ]);
    public writes = 0;
    readonly #lease = TurnLease.restore(
        new TurnId("w9-turn"),
        principal.principalId,
        1,
        new Date(100)
    );
    readonly #token = {
        turn: this.#lease.turn,
        holder: principal.principalId,
        epoch: this.#lease.epoch
    };
    readonly #digest = new Digest("a".repeat(64));
    readonly #pin = new PackagePin(
        new PackageId("w9-package"),
        new SemVer("1.0.0"),
        this.#digest,
        this.#digest
    );
    readonly #placement = new InvocationPlacementPin({
        manifest: ["bundled"],
        policy: ["bundled"],
        substrate: ["bundled"],
        trust: ["bundled"],
        selected: "bundled"
    });

    public resolve(caller: PrincipalRef): OperationResolutionState | undefined {
        if (!caller.equals(principal)) return undefined;
        return {
            principal,
            binding: this.binding,
            pathEpochs: this.path,
            watermark: InvalidationWatermark.empty(tenant, owner, principal),
            lease: this.#token,
            originalLease: this.#lease,
            package: this.#pin,
            placement: this.#placement,
            resolvedAt: new Date(0),
            deadline: new Date(50),
            owner
        };
    }
    public currentBinding(): Binding | undefined {
        return this.binding;
    }
    public currentPath(): PathEpochEvidence {
        return this.path;
    }
    public currentWatermark(): InvalidationWatermark {
        return InvalidationWatermark.empty(tenant, owner, principal);
    }
    public currentLease() {
        return this.#lease;
    }
    public admits(): boolean {
        return true;
    }
    public contributorDomain() {
        return domain;
    }
    public admitsInterception(): boolean {
        return true;
    }
    public release(): void {}
}

function operationAuthority(
    state: AuthorityState,
    overrides: Partial<OperationAuthorityStatePort<PrincipalRef>> = {}
): TenantOperationAuthority<PrincipalRef> {
    return new TenantOperationAuthority(
        {
            resolve: overrides.resolve ?? state.resolve.bind(state),
            currentBinding: overrides.currentBinding ?? state.currentBinding.bind(state),
            currentPath: overrides.currentPath ?? state.currentPath.bind(state),
            currentWatermark: overrides.currentWatermark ?? state.currentWatermark.bind(state),
            currentLease: overrides.currentLease ?? state.currentLease.bind(state),
            admits: overrides.admits ?? state.admits.bind(state),
            contributorDomain: overrides.contributorDomain ?? state.contributorDomain.bind(state),
            admitsInterception:
                overrides.admitsInterception ?? state.admitsInterception.bind(state),
            release: overrides.release ?? state.release.bind(state)
        },
        () => new Date(10)
    );
}

class FixedExpectationFactory implements AuthorityPermitExpectationFactory<
    object,
    object,
    object,
    object,
    object
> {
    public constructor(private readonly expected: AuthorityPermitExpectation) {}
    public forClaim(): AuthorityPermitExpectation {
        return this.expected;
    }
    public forAdmission(): AuthorityPermitExpectation {
        return this.expected;
    }
}

function permitExpectation(): AuthorityPermitExpectation {
    const digest = new Digest("b".repeat(64));
    const invocation = new InvocationId("w9-permit-invocation");
    const turn = new TurnId("w9-permit-turn");
    const token = { turn, holder: principal.principalId, epoch: 2 };
    return new AuthorityPermitExpectation({
        tenant,
        issuer,
        source: owner,
        target: { actor: new ActorRef("run", new ActorId("w9-target")), fence: 3, domain },
        principal,
        binding: { name: bindingName, generation: new Revision(0) },
        facet,
        operation: new OperationRef("target:send"),
        package: new PackagePin(new PackageId("w9-package"), new SemVer("1.0.0"), digest, digest),
        impact: "externalSend",
        invocation,
        reservation: {
            run: new RunId("w9-permit-run"),
            registryEpoch: 4,
            obligation: { kind: "invocationItem", invocation, itemIndex: 0, itemKey: "w9-item" }
        },
        itemIndex: 0,
        attemptOrdinal: 0,
        claim: new ItemClaimId("w9-claim"),
        claimOwner: { kind: "executor", token, worker: new ClaimWorkerId("w9-worker") },
        itemKey: "w9-item",
        argumentsDigest: digest,
        intentDigest: digest,
        pathEpochs: new PathEpochEvidence([
            ScopeEpoch.initial(tenantScope),
            ScopeEpoch.initial(scope)
        ]),
        authority: { kind: "initiator", principal, binding: bindingName },
        lease: token
    });
}

function admissionContext(
    expected: AuthorityPermitExpectation
): AuthorityAdmissionContext<object, object, object, object> {
    return {
        invocation: expected.invocation,
        itemIndex: expected.itemIndex,
        ordinal: expected.attemptOrdinal,
        lease: expected.lease,
        authority: expected.authority,
        domain: expected.target.domain,
        pathEpochs: expected.pathEpochs,
        intentDigest: expected.intentDigest,
        itemKey: expected.itemKey
    };
}

class MemoryTransactions implements InvocationTransactionPort<InvocationMediationMemoryState> {
    #state = createInvocationMediationMemoryState();
    public transact<Result>(
        operation: (transaction: InvocationMediationMemoryState) => Result
    ): Result {
        const next = cloneInvocationMediationMemoryState(this.#state);
        const result = operation(next);
        this.#state = cloneInvocationMediationMemoryState(next);
        return result;
    }
}

class SuccessfulBatch<Authorization = string> implements CanonicalBatchInvoker<Authorization> {
    public calls = 0;
    public constructor(private readonly invocation: InvocationId) {}
    public async invoke(request: CanonicalBatchInvocationRequest<Authorization>) {
        this.calls += 1;
        const outputs = await Promise.all(
            request.request.inputs.map((_input, itemIndex) =>
                request.request.execute(itemIndex, operationContext(this.invocation, itemIndex))
            )
        );
        return {
            invocation: this.invocation,
            items: outputs.map((output, itemIndex) => ({
                kind: "succeeded" as const,
                itemIndex,
                output,
                receipt: new AttemptReceipt(
                    new ReceiptId(`w9-receipt-${itemIndex}`),
                    new EffectAttemptId(`w9-attempt-${itemIndex}`),
                    "succeeded",
                    undefined,
                    new Date(20),
                    undefined
                )
            }))
        };
    }
}

function operationContext(invocation: InvocationId, itemIndex: number): OperationContext {
    return {
        invocation,
        itemIndex,
        idempotencyKey: `w9-item-${itemIndex}`,
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    };
}

function expectedAuditId(): AuditRecordId {
    return new AuditRecordId("w9-outbox-audit");
}

function w9ReplayBinding() {
    return {
        principal,
        authorityIdentity: new Digest("c".repeat(64)),
        packageOperationPin: new Digest("d".repeat(64)),
        execution: { kind: "lease" as const, digest: new Digest("e".repeat(64)) }
    };
}
