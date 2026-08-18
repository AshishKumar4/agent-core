import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../../src/actors";
import {
    AuthorityCheckRequest,
    AuthorityCheckEvidence,
    AuthorityPermit,
    AuthorityPermitAdmissionPort,
    AuthorityPermitAuthenticator,
    AuthorityPermitIssuer,
    AuthorityPermitExpectation,
    AuthorityPermitIssuedRecordSource,
    AuthenticatedAuthorityPermit,
    Binding,
    GrantId,
    InvalidationWatermark,
    MemoryInvalidationWatermarkStore,
    MemoryAuthorityPermitStore,
    PathEpochEvidence,
    ScopeEpoch,
    TargetAuthorityPermitRequest,
    watermarkKey,
    type MemoryAuthorityPermitTransaction,
    StoredAuthorityPermitAdmissionPort
} from "../../../src/authority";
import {
    ConsumedAuthorityAdmissionPort,
    AuthorityPermitIssuanceTransport,
    IssuedAuthorityPermitPort,
    TargetAuthorityPermitAuthenticationPort,
    TargetAuthorityPermitDenialPort,
    CanonicalSettlementEvidencePort,
    DurableRunAdmissionPort,
    InvocationComposition,
    ProvenanceFacetSlotBackend,
    ResolvedOperationAuthority,
    ResolutionStamp,
    TenantOperationAuthority,
    createProtectedProfileRuntime,
    type AuthorityPermitExpectationFactory,
    type AuthorityCheckRequestFactory,
    type OperationAuthorityStatePort,
    type OperationResolutionCandidate
} from "../../../src/composition";
import {
    ContentRef,
    Digest,
    JsonSchema,
    Revision,
    SemVer,
    encodeCanonicalJson
} from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import {
    PackageId,
    PackageInstallationProvenancePort,
    PackagePin,
    PolicySet
} from "../../../src/definition";
import {
    RunCommitId as ExecutionRunCommitId,
    RunId as ExecutionRunId
} from "../../../src/execution-references";
import {
    BindingName,
    CapabilitySpec,
    type EventDeclaration,
    type FacetData,
    FacetRef,
    InterceptorDeclaration,
    InterceptorId,
    MemoryWorkspaceSlotStore,
    Operation,
    OperationDescriptor,
    OperationName,
    OperationRef,
    type ProfileControlAdmission,
    ProfileRuntimeEffectsPort,
    ProfileRuntimeHostBinding,
    ProtectionDomain,
    type SurfaceDescriptor,
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
    AttemptCompletion,
    AttemptReceipt,
    type AuthorityAdmissionContext,
    AuthorityAdmissionReference,
    type CanonicalBatchInvocationRequest,
    type CanonicalBatchInvoker,
    cloneInvocationMediationMemoryState,
    createInvocationMediationMemoryState,
    InvocationId as InvocationContextId,
    type InvocationMediationMemoryState,
    InvocationPlacementPin,
    InvocationProtectedOperationPort,
    InvocationPublicationOutbox,
    type InvocationTransactionPort,
    ItemClaim,
    MemoryInvocationMediationPersistence,
    type PreparedInvocation
} from "../../../src/invocations";
import {
    AuditRecordId,
    InvocationId,
    InvocationId as InteractionInvocationId,
    RouteReservationId
} from "../../../src/interaction-references";
import { OperationRequestKey } from "../../../src/operations";
import {
    AuthorityPermitIssuanceReply,
    AuthorityPermitIssuanceRequest,
    CommandEnvelope
} from "../../../src/protocol";
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
import { prepared as preparedInvocation } from "../../invocations/fixture";

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
    test(
        "rejects stale authority and preserves an opaque no-write direct stamp",
        { tags: "p0" },
        async () => {
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
            const stamp = authority.authorizeDirect(resolved.resolution, directDescriptor, [
                { id: 1 }
            ]);
            expect(stamp?.binding).toBe(state.binding);
            expect(state.writes).toBe(0);

            state.path = new PathEpochEvidence([
                ScopeEpoch.initial(tenantScope),
                new ScopeEpoch(scope, 1)
            ]);
            expect(
                authority.authorizeDirect(resolved.resolution, directDescriptor, [{ id: 1 }])
            ).toBeInstanceOf(ResolutionStamp);
            await expect(
                authority.authorizeMediated(resolved.resolution, descriptor, [{ id: 1 }])
            ).rejects.toMatchObject({ code: "authority.denied" });
            expect(
                authority.authorizeDirect(resolved.resolution, directDescriptor, [{ id: 1 }])
            ).toBeUndefined();
        }
    );

    test(
        "fails closed on substituted resolution evidence and exposes both interception domains",
        { tags: "p0" },
        async () => {
            const state = new AuthorityState();
            const unresolved = operationAuthority(state, { resolve: () => undefined });
            await expect(unresolved.resolve(principal, bindingName)).rejects.toMatchObject({
                code: "authority.denied"
            });

            const derived = await operationAuthority(state).resolve(principal, bindingName);
            expect(derived.resolution.resolvedAt).toEqual(new Date(10));
            expect(derived.resolution.originalLeaseExpiresAt).toEqual(new Date(100));
            expect(derived.resolution.resolutionDeadline).toEqual(new Date(60));

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
                resolve: (caller) => {
                    const candidate = state.resolve(caller);
                    if (candidate === undefined) {
                        throw new TypeError("Expected the W9 authority fixture to resolve");
                    }
                    return {
                        ...candidate,
                        lease: undefined,
                        originalLease: undefined,
                        route: new RouteReservationId("w9-replay-route")
                    };
                }
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
            const interceptor = new InterceptorDeclaration(
                new InterceptorId("w9-interceptor"),
                "operation.before",
                "rewrite",
                0
            );
            expect(
                authority.allowsInterception(
                    resolved.resolution,
                    facet,
                    interceptor,
                    facet,
                    interceptable
                )
            ).toBe(true);
            expect(
                authority.allowsInterception(
                    resolved.resolution,
                    facet,
                    interceptor,
                    new FacetRef("workspace:substituted"),
                    interceptable
                )
            ).toBe(false);
            // Protection-domain confinement is §4.4 rule 1 and belongs to the interceptor
            // runner; what this membrane owes it is the two domains, each read from its
            // own source rather than assumed equal.
            expect(authority.cutPointDomain(resolved.resolution)).toEqual(domain);
            expect(authority.contributorDomain(facet)).toEqual(domain);
            const substitutedDomain = new ProtectionDomain("frontend", "substituted", "no-secrets");
            expect(
                operationAuthority(state, {
                    contributorDomain: () => substitutedDomain
                }).contributorDomain(facet)
            ).toEqual(substitutedDomain);
            expect(
                operationAuthority(state, { admitsInterception: () => false }).allowsInterception(
                    resolved.resolution,
                    facet,
                    interceptor,
                    facet,
                    interceptable
                )
            ).toBe(false);
            authority.release(resolved.resolution);
        }
    );

    test(
        "rejects a same-PrincipalId cross-Tenant lease at resolution, direct, and mediated admission",
        { tags: "p0" },
        async () => {
            const state = new AuthorityState();
            const authority = operationAuthority(state);
            const valid = (await authority.resolve(principal, bindingName)).resolution;
            if (valid.lease === undefined || valid.originalLease?.expiresAt === undefined) {
                throw new TypeError("Expected a held W9 Turn resolution");
            }
            const foreignHolder = new PrincipalRef(
                new TenantId("w9-foreign-holder-tenant"),
                principal.principalId
            );
            const foreignLease = TurnLease.restore(
                valid.lease.turn,
                foreignHolder,
                valid.lease.epoch,
                valid.originalLease.expiresAt
            );
            const candidate = state.resolve(principal);
            if (candidate === undefined) {
                throw new TypeError("Expected the W9 authority fixture to resolve");
            }
            const substituted: OperationResolutionCandidate = {
                ...candidate,
                lease: {
                    turn: valid.lease.turn,
                    holder: foreignHolder,
                    epoch: valid.lease.epoch
                },
                originalLease: foreignLease
            };
            const substitutedResolver = operationAuthority(state, {
                resolve: () => substituted
            });
            const directDescriptor = new OperationDescriptor(
                new OperationName("cross-tenant-read"),
                "observe",
                new JsonSchema({}),
                new JsonSchema({})
            );

            await expect(substitutedResolver.resolve(principal, bindingName)).rejects.toMatchObject(
                { code: "authority.denied" }
            );
            const currentLeaseSubstitution = operationAuthority(state, {
                currentLease: () => foreignLease
            });
            const current = (await currentLeaseSubstitution.resolve(principal, bindingName))
                .resolution;
            expect(
                currentLeaseSubstitution.authorizeDirect(current, directDescriptor, [{}])
            ).toBeUndefined();
            await expect(
                currentLeaseSubstitution.authorizeMediated(current, descriptor, [{}])
            ).rejects.toMatchObject({ code: "authority.denied" });
        }
    );

    test(
        "denies an exact locally constructed permit before target admission",
        { tags: "p0" },
        () => {
            const expected = permitExpectation();
            const permit = new AuthorityPermit({
                ...expected,
                nonce: "w9-permit-nonce",
                requestDigest: targetPermitRequest(
                    expected,
                    "w9-permit-nonce",
                    new Date(20)
                ).digest(),
                issuedAt: new Date(10),
                expiresAt: new Date(20)
            });
            const store = new MemoryAuthorityPermitStore(expected.target.actor);
            const adapter = new ConsumedAuthorityAdmissionPort(
                new StoredAuthorityPermitAdmissionPort(store),
                new FixedExpectationFactory(expected),
                () => new Date(15)
            );
            const admission = new AuthorityAdmissionReference(permit.toData(), permit.digest());
            const context = admissionContext(expected);

            expect(
                store.transaction((transaction) => adapter.admits(transaction, admission, context))
            ).toBe(false);
            expect(
                store.transaction((transaction) => store.consumed(transaction, permit.nonce))
            ).toBeUndefined();

            const fabricatedAuthentication = {
                matches: (_permit: AuthorityPermit): boolean => true
            };
            Object.setPrototypeOf(fabricatedAuthentication, AuthenticatedAuthorityPermit.prototype);
            expect(
                store.transaction((transaction) => {
                    return adapter.admits(
                        transaction,
                        admission,
                        context,
                        // @ts-expect-error A prototype-only object must be rejected at runtime.
                        fabricatedAuthentication
                    );
                })
            ).toBe(false);

            const substituted = new AuthorityAdmissionReference(
                permit.toData(),
                new Digest("f".repeat(64))
            );
            expect(
                store.transaction((transaction) =>
                    adapter.admits(transaction, substituted, context)
                )
            ).toBe(false);
        }
    );

    test(
        "admits a target-pulled canonical Tenant permit exactly once",
        { tags: "p0" },
        async () => {
            const expected = permitExpectation();
            const issuerStore = new MemoryAuthorityPermitStore(expected.issuer);
            const request = targetPermitRequest(expected, "w9-authenticated-permit", new Date(20));
            const permit = issuerStore.transaction((transaction) =>
                new AuthorityPermitIssuer(issuerStore).issue(
                    transaction,
                    request,
                    allowedPermitEvidence(request, new Date(10)),
                    new Date(10)
                )
            );
            const authentication = await authenticatePermit(issuerStore, permit, expected);
            const targetStore = new MemoryAuthorityPermitStore(expected.target.actor);
            targetStore.transaction((transaction) =>
                targetStore.request(
                    transaction,
                    targetPermitRequest(expected, permit.nonce, permit.expiresAt)
                )
            );
            const adapter = new ConsumedAuthorityAdmissionPort(
                new StoredAuthorityPermitAdmissionPort(targetStore),
                new FixedExpectationFactory(expected),
                () => new Date(15)
            );
            const admission = new AuthorityAdmissionReference(permit.toData(), permit.digest());
            const context = admissionContext(expected);

            expect(
                targetStore.transaction((transaction) =>
                    adapter.admits(transaction, admission, context, authentication)
                )
            ).toBe(true);
            expect(
                targetStore.transaction((transaction) =>
                    adapter.admits(transaction, admission, context, authentication)
                )
            ).toBe(false);
            expect(
                targetStore.transaction(
                    (transaction) => targetStore.consumed(transaction, permit.nonce)?.value
                )
            ).toBe(permit.digest().value);
        }
    );

    test(
        "denies an expired authenticated permit without consuming its nonce",
        { tags: "p0" },
        async () => {
            const expected = permitExpectation();
            const issuerStore = new MemoryAuthorityPermitStore(expected.issuer);
            const request = targetPermitRequest(expected, "w9-expired-permit", new Date(20));
            const permit = issuerStore.transaction((transaction) =>
                new AuthorityPermitIssuer(issuerStore).issue(
                    transaction,
                    request,
                    allowedPermitEvidence(request, new Date(10)),
                    new Date(10)
                )
            );
            const authentication = await authenticatePermit(issuerStore, permit, expected);
            const store = new MemoryAuthorityPermitStore(expected.target.actor);
            const adapter = new ConsumedAuthorityAdmissionPort(
                new StoredAuthorityPermitAdmissionPort(store),
                new FixedExpectationFactory(expected),
                () => new Date(20)
            );
            const admission = new AuthorityAdmissionReference(permit.toData(), permit.digest());

            expect(
                store.transaction((transaction) =>
                    adapter.admits(
                        transaction,
                        admission,
                        admissionContext(expected),
                        authentication
                    )
                )
            ).toBe(false);
            expect(
                store.transaction((transaction) => store.consumed(transaction, permit.nonce))
            ).toBeUndefined();
        }
    );

    test(
        "returns witness-free durable permit data and remints authentication after runtime reconstruction",
        { tags: "p0" },
        async () => {
            const expected = permitExpectation();
            const store = new MemoryAuthorityPermitStore(expected.issuer);
            const requestStore = new MemoryAuthorityPermitStore(expected.target.actor);
            const issuerPort = new IssuedAuthorityPermitPort(
                requestStore,
                new FixedExpectationFactory(expected),
                targetDenialPort(requestStore),
                new FixedAuthorityRequestFactory(expected),
                new MemoryPermitIssuanceTransport(store),
                () => "w9-issued-port-nonce",
                () => new Date(10),
                10
            );
            const inputs = permitClaimInputs(expected);

            const issuance = await issuerPort.issue(inputs.invocation, inputs.claim);
            if (issuance.kind !== "issued") throw new TypeError("Expected issued permit");
            const admission = issuance.admission;

            expect(Reflect.ownKeys(admission).sort()).toEqual(["digest", "reference"]);
            expect("authentication" in admission).toBe(false);
            const permit = AuthorityPermit.fromData(structuredClone(admission.reference));
            expect(permit.nonce).toBe("w9-issued-port-nonce");
            expect(permit.digest().equals(admission.digest)).toBe(true);
            const transportedPermit = AuthorityPermitIssuanceReply.decode(
                AuthorityPermitIssuanceReply.encode(
                    AuthorityPermitIssuanceReply.issued(
                        allowedPermitEvidence(
                            targetPermitRequest(expected, permit.nonce, permit.expiresAt),
                            permit.issuedAt
                        ),
                        permit
                    )
                )
            ).requirePermit();
            const transportedAdmission = new AuthorityAdmissionReference(
                transportedPermit.toData(),
                transportedPermit.digest()
            );
            const firstSource = new MemoryIssuedRecordSource(store);
            const firstTargetAuthentication = new TargetAuthorityPermitAuthenticationPort(
                new AuthorityPermitAuthenticator(firstSource),
                new FixedExpectationFactory(expected)
            );
            const firstAuthentication = await firstTargetAuthentication.authenticate(
                inputs.invocation,
                inputs.claim,
                transportedAdmission
            );
            const restartedSource = new MemoryIssuedRecordSource(store);
            const restartedTargetAuthentication = new TargetAuthorityPermitAuthenticationPort(
                new AuthorityPermitAuthenticator(restartedSource),
                new FixedExpectationFactory(expected)
            );
            const restartedAuthentication = await restartedTargetAuthentication.authenticate(
                inputs.invocation,
                inputs.claim,
                transportedAdmission
            );
            expect(restartedAuthentication).not.toBe(firstAuthentication);
            expect(firstSource.calls).toBe(1);
            expect(restartedSource.calls).toBe(1);

            const targetAdmission = new ConsumedAuthorityAdmissionPort(
                new StoredAuthorityPermitAdmissionPort(requestStore),
                new FixedExpectationFactory(expected),
                () => new Date(15)
            );
            expect(
                requestStore.transaction((transaction) =>
                    targetAdmission.admits(
                        transaction,
                        transportedAdmission,
                        admissionContext(expected),
                        restartedAuthentication
                    )
                )
            ).toBe(true);
            expect(
                store.transaction((transaction) => store.issued(transaction, permit.nonce)?.nonce)
            ).toBe(permit.nonce);
            expect(
                requestStore.transaction(
                    (transaction) => requestStore.consumed(transaction, permit.nonce)?.value
                )
            ).toBe(permit.digest().value);
        }
    );

    test(
        "accepts an exact response-loss replay and rejects substituted or impossible transport replies",
        { tags: "p0" },
        async () => {
            const expected = permitExpectation();
            const inputs = permitClaimInputs(expected);
            const issuerStore = new MemoryAuthorityPermitStore(expected.issuer);
            const replayStore = new MemoryAuthorityPermitStore(expected.target.actor);
            const responseLoss = new ResponseLossPermitIssuanceTransport(issuerStore);
            const replayPort = new IssuedAuthorityPermitPort(
                replayStore,
                new FixedExpectationFactory(expected),
                targetDenialPort(replayStore),
                new FixedAuthorityRequestFactory(expected),
                responseLoss,
                () => "w9-replayed-transport",
                clock(new Date(10), new Date(11), new Date(12), new Date(15)),
                10
            );

            await expect(replayPort.issue(inputs.invocation, inputs.claim)).rejects.toThrow(
                "permit response was lost"
            );
            const replayed = await replayPort.issue(inputs.invocation, inputs.claim);

            expect(replayed.kind).toBe("issued");
            expect(responseLoss.requests).toHaveLength(2);
            expect(responseLoss.requests[1]).toEqual(responseLoss.requests[0]);
            expect(
                replayStore.transaction((transaction) =>
                    replayStore.requested(transaction, "w9-replayed-transport")?.expiresAt.getTime()
                )
            ).toBe(20);

            const failures = [
                {
                    nonce: "w9-future-transport",
                    receivedAt: new Date(15),
                    reply: (request: AuthorityPermitIssuanceRequest) =>
                        permitReply(request, new Date(16))
                },
                {
                    nonce: "w9-expired-transport",
                    receivedAt: new Date(20),
                    reply: (request: AuthorityPermitIssuanceRequest) =>
                        permitReply(request, new Date(10))
                },
                {
                    nonce: "w9-substituted-request-transport",
                    receivedAt: new Date(15),
                    reply: (request: AuthorityPermitIssuanceRequest) =>
                        permitReply(request, new Date(10), new Digest("d".repeat(64)))
                }
            ] as const;
            for (const failure of failures) {
                const targetStore = new MemoryAuthorityPermitStore(expected.target.actor);
                const port = new IssuedAuthorityPermitPort(
                    targetStore,
                    new FixedExpectationFactory(expected),
                    targetDenialPort(targetStore),
                    new FixedAuthorityRequestFactory(expected),
                    new FixedPermitIssuanceTransport(failure.reply),
                    () => failure.nonce,
                    clock(new Date(10), failure.receivedAt, failure.receivedAt),
                    10
                );

                const issuance = port.issue(inputs.invocation, inputs.claim);
                if (failure.nonce === "w9-expired-transport") {
                    await expect(issuance).resolves.toEqual({ kind: "expired" });
                } else {
                    await expect(issuance).resolves.toMatchObject({ kind: "invalid" });
                }
                expect(
                    targetStore.transaction((transaction) =>
                        targetStore.requested(transaction, failure.nonce)
                    )
                ).toBeDefined();
            }
        }
    );

    test(
        "concurrent duplicate requests accept replies delivered in reverse order",
        { tags: "p0" },
        async () => {
            const expected = permitExpectation();
            const inputs = permitClaimInputs(expected);
            const targetStore = new MemoryAuthorityPermitStore(expected.target.actor);
            const transport = new ReorderedPermitIssuanceTransport();
            const port = new IssuedAuthorityPermitPort(
                targetStore,
                new FixedExpectationFactory(expected),
                targetDenialPort(targetStore),
                new FixedAuthorityRequestFactory(expected),
                transport,
                () => "w9-concurrent-reordered-transport",
                clock(new Date(10), new Date(11), new Date(12), new Date(13), new Date(14)),
                10
            );

            const first = port.issue(inputs.invocation, inputs.claim);
            const second = port.issue(inputs.invocation, inputs.claim);
            expect(transport.requests).toHaveLength(2);
            expect(transport.requests[1]).toEqual(transport.requests[0]);

            transport.resolve(1);
            await expect(second).resolves.toMatchObject({ kind: "issued" });
            transport.resolve(0);
            await expect(first).resolves.toMatchObject({ kind: "issued" });
        }
    );

    test(
        "uses a recovered claim and new nonce after the retained request expires",
        { tags: "p0" },
        async () => {
            const expected = permitExpectation();
            const inputs = permitClaimInputs(expected);
            const recoveredClaim = new ItemClaim(
                new ItemClaimId("w9-recovered-claim"),
                inputs.claim.invocation,
                inputs.claim.itemIndex,
                inputs.claim.attemptOrdinal,
                inputs.claim.owner,
                new Date(30)
            );
            const expectedFor = (claim: ItemClaim<string>) =>
                new AuthorityPermitExpectation({ ...expected, claim: claim.id });
            const expectations: AuthorityPermitExpectationFactory<
                MemoryAuthorityPermitTransaction,
                string,
                string,
                string,
                string
            > = {
                forClaim: (_invocation, claim) => expectedFor(claim),
                forAdmission: () => expected
            };
            const authority: AuthorityCheckRequestFactory<string, string, string, string> = {
                forClaim: (_invocation, claim, nonce) =>
                    targetPermitRequest(expectedFor(claim), nonce, claim.expiresAt).authority
            };
            const targetStore = new MemoryAuthorityPermitStore(expected.target.actor);
            const port = new IssuedAuthorityPermitPort(
                targetStore,
                expectations,
                targetDenialPort(targetStore),
                authority,
                new FixedPermitIssuanceTransport((request) => permitReply(request, new Date(21))),
                (_invocation, claim) => claim.id.value,
                clock(
                    new Date(10),
                    inputs.claim.expiresAt,
                    new Date(21),
                    new Date(22),
                    new Date(23)
                ),
                20
            );

            await expect(port.issue(inputs.invocation, inputs.claim)).resolves.toEqual({
                kind: "expired"
            });
            await expect(port.issue(inputs.invocation, recoveredClaim)).resolves.toMatchObject({
                kind: "issued"
            });
            expect(
                targetStore.transaction(
                    (transaction) =>
                        targetStore.requested(transaction, inputs.claim.id.value)?.nonce
                )
            ).toBe(inputs.claim.id.value);
            expect(
                targetStore.transaction(
                    (transaction) =>
                        targetStore.requested(transaction, recoveredClaim.id.value)?.nonce
                )
            ).toBe(recoveredClaim.id.value);
        }
    );

    test(
        "fails closed for malformed permits while preserving infrastructure failures",
        { tags: "p0" },
        async () => {
            const expected = permitExpectation();
            const store = new MemoryAuthorityPermitStore(expected.target.actor);
            const malformedAdapter = new ConsumedAuthorityAdmissionPort(
                new StoredAuthorityPermitAdmissionPort(store),
                new FixedExpectationFactory(expected),
                () => new Date(15)
            );
            const malformedAdmission = new AuthorityAdmissionReference({}, expected.intentDigest);

            expect(
                store.transaction((transaction) => {
                    return malformedAdapter.admits(
                        transaction,
                        malformedAdmission,
                        admissionContext(expected)
                    );
                })
            ).toBe(false);

            const permit = new AuthorityPermit({
                ...expected,
                nonce: "w9-infrastructure-failure",
                requestDigest: targetPermitRequest(
                    expected,
                    "w9-infrastructure-failure",
                    new Date(20)
                ).digest(),
                issuedAt: new Date(10),
                expiresAt: new Date(20)
            });
            const issuerStore = new MemoryAuthorityPermitStore(expected.issuer);
            issuerStore.transaction((transaction) => issuerStore.issue(transaction, permit));
            const authentication = await authenticatePermit(issuerStore, permit, expected);
            const failingAdapter = new ConsumedAuthorityAdmissionPort(
                new UnavailableAuthorityPermitAdmission(),
                new FixedExpectationFactory(expected),
                () => new Date(15)
            );
            expect(() =>
                store.transaction((transaction) =>
                    failingAdapter.admits(
                        transaction,
                        new AuthorityAdmissionReference(permit.toData(), permit.digest()),
                        admissionContext(expected),
                        authentication
                    )
                )
            ).toThrow("permit store unavailable");
        }
    );

    test(
        "joins authenticated Tenant denial epochs and invalidates the exact target resolution idempotently",
        { tags: "p0" },
        async () => {
            const expected = permitExpectation();
            const request = targetPermitRequest(expected, "w9-denied-permit", new Date(20));
            const currentPath = new PathEpochEvidence([
                ScopeEpoch.initial(tenantScope),
                new ScopeEpoch(scope, 1)
            ]);
            const evidence = deniedPermitEvidence(request, currentPath, new Date(10));
            const watermarks = new MemoryInvalidationWatermarkStore(tenant, expected.target.actor);
            const invalidated: AuthorityPermitExpectation[] = [];
            const targetStore = new MemoryAuthorityPermitStore(expected.target.actor);
            let activeTransaction: MemoryAuthorityPermitTransaction | undefined;
            const denial = new TargetAuthorityPermitDenialPort(
                tenant,
                expected.target.actor,
                targetStore,
                {
                    joinDeniedEpochs: (received, holder, entries) => {
                        expect(received).toBe(activeTransaction);
                        const empty = InvalidationWatermark.empty(
                            tenant,
                            expected.target.actor,
                            holder
                        );
                        const key = watermarkKey(empty);
                        if (watermarks.load(key) === undefined) watermarks.save(empty);
                        watermarks.join(key, entries);
                    },
                    invalidateResolution: (received, expectation) => {
                        expect(received).toBe(activeTransaction);
                        invalidated.push(expectation);
                    }
                }
            );
            const port = new IssuedAuthorityPermitPort(
                targetStore,
                new FixedExpectationFactory(expected),
                denial,
                new FixedAuthorityRequestFactory(expected),
                new FixedPermitIssuanceTransport(() =>
                    AuthorityPermitIssuanceReply.denied(evidence)
                ),
                () => request.nonce,
                () => new Date(10),
                10
            );
            const inputs = permitClaimInputs(expected);
            const result = await port.issue(inputs.invocation, inputs.claim);
            if (result.kind !== "denied") throw new TypeError("Expected denied permit issuance");

            targetStore.transaction((transaction) => {
                activeTransaction = transaction;
                port.deny(transaction, inputs.invocation, inputs.claim, result.denial);
                activeTransaction = undefined;
            });
            const key = watermarkKey(
                InvalidationWatermark.empty(tenant, expected.target.actor, expected.principal)
            );
            const first = watermarks.load(key);
            targetStore.transaction((transaction) => {
                activeTransaction = transaction;
                port.deny(transaction, inputs.invocation, inputs.claim, result.denial);
                activeTransaction = undefined;
            });
            const second = watermarks.load(key);

            expect(first?.epoch(scope)).toBe(1);
            expect(second?.revision.value).toBe(first?.revision.value);
            expect(invalidated).toHaveLength(2);
            expect(invalidated.every((value) => value.equals(expected))).toBe(true);
            expect(
                targetStore.transaction(
                    (transaction) => targetStore.denied(transaction, request.nonce)?.digest().value
                )
            ).toBeDefined();
        }
    );

    test("rejects invalid permit lifetimes before issuing authority", { tags: "p0" }, () => {
        const expected = permitExpectation();
        const issuerStore = new MemoryAuthorityPermitStore(expected.issuer);
        const targetStore = new MemoryAuthorityPermitStore(expected.target.actor);

        expect(
            () =>
                new IssuedAuthorityPermitPort(
                    targetStore,
                    new FixedExpectationFactory(expected),
                    targetDenialPort(targetStore),
                    new FixedAuthorityRequestFactory(expected),
                    new MemoryPermitIssuanceTransport(issuerStore),
                    () => "unused-nonce",
                    () => new Date(10),
                    0
                )
        ).toThrow(/positive safe integer/);
    });

    test(
        "delegates installation provenance and creates a protected profile runtime",
        { tags: "p1" },
        () => {
            const slotStore = new MemoryWorkspaceSlotStore(new WorkspaceId("w9-slot-workspace"));
            const envelopeDigest = new Digest("9".repeat(64));
            const envelope = new CommandEnvelope({
                command: "facets.contribute",
                caller: { kind: "principal", principal },
                idempotencyKey: "w9-slot-contribution",
                payload: ContentRef.fromDigest(envelopeDigest),
                payloadDigest: envelopeDigest
            });
            slotStore.transaction((transaction) => {
                const provenance = new (class extends PackageInstallationProvenancePort<
                    typeof transaction,
                    CommandEnvelope
                > {
                    protected authenticatedInstallation(): undefined {
                        return undefined;
                    }
                })();
                const slots = new ProvenanceFacetSlotBackend(
                    slotStore,
                    provenance,
                    {
                        permitsInstall: () => true,
                        permitsContribution: () => true,
                        permitsWithdrawal: () => true
                    },
                    {
                        revision: (read) => slotStore.loadRevision(read),
                        slot: (read, name) => slotStore.loadSlot(read, name)
                    }
                );

                expect(slots.prepareContribution(transaction, envelope)).toBeUndefined();
            });

            const host = new ProfileRuntimeHostBinding(facet, bindingName);
            const runtimeInvocation = new InvocationId("w9-profile-runtime");
            const operations = new InvocationProtectedOperationPort(
                { invocation: () => runtimeInvocation },
                new SuccessfulBatch<ProtectedOperationRequest>(runtimeInvocation)
            );
            const runtime = createProtectedProfileRuntime(
                host,
                operations,
                new PassthroughProfileEffects()
            );
            expect(runtime.host).toBe(host);
            expect(runtime.active).toBe(false);
            runtime.activate();
            expect(runtime.active).toBe(true);
            runtime.deactivate();
            expect(runtime.active).toBe(false);
        }
    );

    test(
        "captures exact reserved-minus-completed Run frontier across restart and close races",
        { tags: "p1" },
        () => {
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
            const storage = new MemoryRunStorage(tenant, owner);
            const repository = new RunRepository(storage);
            repository.transaction((transaction) =>
                repository.insertAdmission(transaction, registry)
            );
            const restartedStorage = new MemoryRunStorage(tenant, owner, storage.snapshot());
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
        }
    );

    test("settles every Run obligation through canonical identity adapters", { tags: "p1" }, () => {
        const approval = new ApprovalId("w9-settlement-approval");
        const invocation = new InvocationId("w9-settlement-invocation");
        const route = new RouteReservationId("w9-settlement-route");
        const attempt = new EffectAttemptId("w9-settlement-attempt");
        const commit = new ExecutionRunCommitId("w9-settlement-commit");
        const seen = new Set<string>();
        const snapshot = Object.freeze({ registryEpoch: 8 });
        const evidence = new CanonicalSettlementEvidencePort<typeof snapshot>({
            approvalResolved: (_transaction, id: ApprovalId) => {
                seen.add(`approval:${id.value}`);
                return id.equals(approval);
            },
            invocationItemTerminal: (
                _transaction,
                id: InvocationId,
                itemIndex: number,
                itemKey: string
            ) => {
                seen.add(`item:${id.value}:${itemIndex}:${itemKey}`);
                return id.equals(invocation) && itemIndex === 0 && itemKey === "w9-item";
            },
            routeTerminal: (_transaction, id: RouteReservationId) => {
                seen.add(`route:${id.value}`);
                return id.equals(route);
            },
            reconciliationSuperseded: (_transaction, id: EffectAttemptId) => {
                seen.add(`reconciliation:${id.value}`);
                return id.equals(attempt);
            },
            commitExists: (_transaction, id: ExecutionRunCommitId) => {
                seen.add(`commit:${id.value}`);
                return id.equals(commit);
            },
            auditSatisfied: (_transaction, obligation) => {
                switch (obligation.kind) {
                    case "receipt":
                        seen.add(`audit:receipt:${obligation.invocation.value}`);
                        return obligation.invocation.equals(invocation);
                    case "delivery":
                        seen.add(`audit:delivery:${obligation.reservation.value}`);
                        return obligation.reservation.equals(route);
                    case "commit":
                        seen.add(`audit:commit:${obligation.commit.value}`);
                        return obligation.commit.equals(commit);
                }
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
            ]
        });

        expect(obligation.requiredAudits.map((value) => value.kind).sort()).toEqual([
            "commit",
            "delivery",
            "receipt"
        ]);
        expect(isSettled(snapshot, obligation, evidence)).toBe(true);
        expect(seen.size).toBe(8);
    });

    test(
        "replays per-item mediation and retries the durable outbox after crashes",
        { tags: "p0" },
        async () => {
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
                cardinality: { kind: "batch" as const, itemCount: 2 },
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
                    cardinality: preflight.cardinality
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
        }
    );

    test(
        "adapts profile mediation through the canonical batch invocation port",
        { tags: "p1" },
        async () => {
            const invocation = new InvocationId("w9-profile-invocation");
            const batch = new SuccessfulBatch<ProtectedOperationRequest>(invocation);
            const adapter = new InvocationProtectedOperationPort(
                { invocation: () => invocation },
                batch
            );
            const operation = new (class extends Operation {
                public readonly descriptor = descriptor;
                public async execute(
                    _context: OperationContext,
                    input: FacetData
                ): Promise<FacetData> {
                    return input;
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
        }
    );

    test(
        "uses canonical constructors and keeps composition off the package surface",
        { tags: "p2" },
        () => {
            expect(RunId).toBe(ExecutionRunId);
            expect(InvocationContextId).toBe(InteractionInvocationId);
            expect(WorkspaceId).toBe(RoutedWorkspaceId);
            expect("RunAdmissionRegistry" in packageRoot).toBe(false);
            expect("TenantOperationAuthority" in packageRoot).toBe(false);
        }
    );
});

class AuthorityState implements OperationAuthorityStatePort<PrincipalRef> {
    public readonly binding = Binding.active(
        scope,
        SubjectRef.principal(new PrincipalRef(tenant, principal.principalId)),
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
    readonly #lease = TurnLease.restore(new TurnId("w9-turn"), principal, 1, new Date(100));
    readonly #token = {
        turn: this.#lease.turn,
        holder: principal,
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

    public watermark = InvalidationWatermark.empty(tenant, owner, principal);
    public staleObservations = 0;

    public resolve(caller: PrincipalRef): OperationResolutionCandidate | undefined {
        if (!caller.equals(principal)) return undefined;
        return {
            principal,
            binding: this.binding,
            pathEpochs: this.path,
            watermark: this.watermark,
            lease: this.#token,
            originalLease: this.#lease,
            route: undefined,
            package: this.#pin,
            placement: this.#placement,
            owner,
            policies: [new PolicySet({ maxDirectRevocationWindowMs: 50 })],
            turnOwnedSession: true,
            sessionFilesystemTarget: false,
            turnActorAuthorityLocal: true,
            directAuthority: new ResolvedOperationAuthority(facet, [
                new CapabilitySpec({
                    facetPattern: facet.value,
                    impacts: ["observe", "externalSend"]
                })
            ])
        };
    }
    public currentBinding(): Binding | undefined {
        return this.binding;
    }
    public currentPath(): PathEpochEvidence {
        return this.path;
    }
    public currentWatermark(): InvalidationWatermark {
        return this.watermark;
    }
    public observeStale(): void {
        this.watermark = this.watermark.join(this.path.path);
        this.staleObservations += 1;
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
            release: overrides.release ?? state.release.bind(state),
            observeStale: overrides.observeStale ?? state.observeStale.bind(state)
        },
        () => new Date(10)
    );
}

class FixedExpectationFactory implements AuthorityPermitExpectationFactory<
    MemoryAuthorityPermitTransaction,
    string,
    string,
    string,
    string
> {
    public constructor(private readonly expected: AuthorityPermitExpectation) {}
    public forClaim(): AuthorityPermitExpectation {
        return this.expected;
    }
    public forAdmission(): AuthorityPermitExpectation {
        return this.expected;
    }
}

class FixedAuthorityRequestFactory implements AuthorityCheckRequestFactory<
    string,
    string,
    string,
    string
> {
    public constructor(private readonly expected: AuthorityPermitExpectation) {}

    public forClaim(
        _invocation: PreparedInvocation<string, string, string, string>,
        _claim: ItemClaim<string>,
        nonce: string
    ): AuthorityCheckRequest {
        return targetPermitRequest(this.expected, nonce, new Date(20)).authority;
    }
}

class MemoryPermitIssuanceTransport extends AuthorityPermitIssuanceTransport {
    public constructor(private readonly store: MemoryAuthorityPermitStore) {
        super();
    }

    public async issue(bytes: Uint8Array): Promise<Uint8Array> {
        const request = AuthorityPermitIssuanceRequest.decode(bytes);
        const evidence = allowedPermitEvidence(request.targetRequest, new Date(10));
        const permit = this.store.transaction((transaction) =>
            new AuthorityPermitIssuer(this.store).issue(
                transaction,
                request.targetRequest,
                evidence,
                new Date(10)
            )
        );
        return AuthorityPermitIssuanceReply.encode(
            AuthorityPermitIssuanceReply.issued(evidence, permit)
        );
    }
}

class FixedPermitIssuanceTransport extends AuthorityPermitIssuanceTransport {
    public constructor(
        private readonly reply: (
            request: AuthorityPermitIssuanceRequest
        ) => AuthorityPermitIssuanceReply
    ) {
        super();
    }

    public issue(bytes: Uint8Array): Promise<Uint8Array> {
        const reply = this.reply(AuthorityPermitIssuanceRequest.decode(bytes));
        return Promise.resolve(AuthorityPermitIssuanceReply.encode(reply));
    }
}

class ResponseLossPermitIssuanceTransport extends AuthorityPermitIssuanceTransport {
    public readonly requests: Uint8Array[] = [];
    #reply: Uint8Array | undefined;

    public constructor(private readonly store: MemoryAuthorityPermitStore) {
        super();
    }

    public async issue(bytes: Uint8Array): Promise<Uint8Array> {
        this.requests.push(bytes.slice());
        if (this.#reply === undefined) {
            const request = AuthorityPermitIssuanceRequest.decode(bytes);
            const evidence = allowedPermitEvidence(request.targetRequest, new Date(10));
            const permit = this.store.transaction((transaction) =>
                new AuthorityPermitIssuer(this.store).issue(
                    transaction,
                    request.targetRequest,
                    evidence,
                    new Date(10)
                )
            );
            this.#reply = AuthorityPermitIssuanceReply.encode(
                AuthorityPermitIssuanceReply.issued(evidence, permit)
            );
            throw new TypeError("permit response was lost");
        }
        return this.#reply.slice();
    }
}

class ReorderedPermitIssuanceTransport extends AuthorityPermitIssuanceTransport {
    public readonly requests: Uint8Array[] = [];
    readonly #replies: Array<(reply: Uint8Array) => void> = [];
    #reply: Uint8Array | undefined;

    public issue(bytes: Uint8Array): Promise<Uint8Array> {
        this.requests.push(bytes.slice());
        if (this.#reply === undefined) {
            const request = AuthorityPermitIssuanceRequest.decode(bytes);
            this.#reply = AuthorityPermitIssuanceReply.encode(permitReply(request, new Date(10)));
        }
        return new Promise((resolve) => this.#replies.push(resolve));
    }

    public resolve(index: number): void {
        const resolve = this.#replies[index];
        if (resolve === undefined || this.#reply === undefined) {
            throw new TypeError("Permit reply is not pending");
        }
        resolve(this.#reply.slice());
    }
}

function permitReply(
    request: AuthorityPermitIssuanceRequest,
    issuedAt: Date,
    requestDigest: Digest = request.targetRequest.digest()
): AuthorityPermitIssuanceReply {
    return AuthorityPermitIssuanceReply.issued(
        allowedPermitEvidence(request.targetRequest, issuedAt),
        new AuthorityPermit({
            ...request.targetRequest.expectation,
            nonce: request.targetRequest.nonce,
            requestDigest,
            issuedAt,
            expiresAt: request.targetRequest.expiresAt
        })
    );
}

function targetDenialPort(
    store: MemoryAuthorityPermitStore
): TargetAuthorityPermitDenialPort<MemoryAuthorityPermitTransaction> {
    const watermarks = new MemoryInvalidationWatermarkStore(tenant, store.owner);
    return new TargetAuthorityPermitDenialPort(tenant, store.owner, store, {
        joinDeniedEpochs: (_transaction, holder, entries) => {
            const empty = InvalidationWatermark.empty(tenant, store.owner, holder);
            const key = watermarkKey(empty);
            if (watermarks.load(key) === undefined) watermarks.save(empty);
            watermarks.join(key, entries);
        },
        invalidateResolution: () => undefined
    });
}

function allowedPermitEvidence(
    request: TargetAuthorityPermitRequest,
    checkedAt: Date
): AuthorityCheckEvidence {
    return new AuthorityCheckEvidence(
        request.expectation.tenant,
        request.expectation.issuer,
        request.authority.digest(),
        request.authority.binding.key,
        request.authority.binding.generation,
        "allow",
        "allowed",
        [new GrantId("w9-permit-allow")],
        [],
        request.authority.expectedPath,
        checkedAt
    );
}

function deniedPermitEvidence(
    request: TargetAuthorityPermitRequest,
    path: PathEpochEvidence,
    checkedAt: Date
): AuthorityCheckEvidence {
    return new AuthorityCheckEvidence(
        request.expectation.tenant,
        request.expectation.issuer,
        request.authority.digest(),
        request.authority.binding.key,
        request.authority.binding.generation,
        "deny",
        "stalePath",
        [],
        [],
        path,
        checkedAt
    );
}

function clock(...times: readonly Date[]): () => Date {
    const pending = [...times];
    return () => {
        const value = pending.shift();
        if (value === undefined) throw new TypeError("Test clock was exhausted");
        return value;
    };
}

class MemoryIssuedRecordSource extends AuthorityPermitIssuedRecordSource {
    public calls = 0;

    public constructor(private readonly store: MemoryAuthorityPermitStore) {
        super();
    }

    public async issued(issuer: ActorRef, nonce: string, digest: Digest) {
        this.calls += 1;
        const permit = this.store.transaction((transaction) =>
            this.store.issued(transaction, nonce)
        );
        return permit?.issuer.equals(issuer) === true && permit.digest().equals(digest)
            ? AuthorityPermit.encode(permit)
            : undefined;
    }
}

function authenticatePermit(
    store: MemoryAuthorityPermitStore,
    permit: AuthorityPermit,
    expected: AuthorityPermitExpectation
) {
    return new AuthorityPermitAuthenticator(new MemoryIssuedRecordSource(store)).authenticate(
        permit,
        expected
    );
}

function permitExpectation(): AuthorityPermitExpectation {
    const digest = new Digest("b".repeat(64));
    const invocation = new InvocationId("w9-permit-invocation");
    const turn = new TurnId("w9-permit-turn");
    const token = { turn, holder: principal, epoch: 2 };
    return new AuthorityPermitExpectation({
        tenant,
        issuer,
        source: owner,
        target: { actor: new ActorRef("run", new ActorId("w9-target")), fence: 3, domain },
        principal,
        binding: { name: bindingName, generation: new Revision(0) },
        facet,
        operation: new OperationRef("workspace:send"),
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
        argumentsDigest: permitArgumentsDigest,
        intentDigest: permitIntentDigest,
        pathEpochs: new PathEpochEvidence([
            ScopeEpoch.initial(tenantScope),
            ScopeEpoch.initial(scope)
        ]),
        authority: { kind: "initiator", principal, binding: bindingName },
        lease: token
    });
}

const permitArguments = Object.freeze({ value: "permit" });
const permitArgumentsDigest = Digest.sha256(encodeCanonicalJson(permitArguments));
const permitIntentDigest = new Digest("c".repeat(64));

function targetPermitRequest(
    expected: AuthorityPermitExpectation,
    nonce: string,
    expiresAt: Date
): TargetAuthorityPermitRequest {
    const binding = new Binding(
        expected.pathEpochs.target.scope,
        SubjectRef.principal(expected.principal),
        expected.target.domain,
        expected.binding.name,
        new GrantId("w9-permit-request-grant"),
        expected.facet,
        expected.binding.generation.value,
        "active",
        new Revision(expected.binding.generation.value)
    );
    const authority = new AuthorityCheckRequest({
        ownerTenant: expected.tenant,
        owner: expected.target.actor,
        ownerFence: expected.target.fence,
        principal: expected.principal,
        binding,
        intent: {
            facet: expected.facet,
            operation: expected.operation.operation.value,
            impact: expected.impact,
            arguments: permitArguments,
            argumentsDigest: permitArgumentsDigest
        },
        expectedPath: expected.pathEpochs,
        invocationDigest: expected.intentDigest,
        itemIndex: expected.itemIndex,
        attemptOrdinal: expected.attemptOrdinal,
        nonce
    });
    return new TargetAuthorityPermitRequest(expected, authority, nonce, expiresAt);
}

function admissionContext(
    expected: AuthorityPermitExpectation
): AuthorityAdmissionContext<string, string, string, string> {
    return {
        invocation: expected.invocation,
        itemIndex: expected.itemIndex,
        ordinal: expected.attemptOrdinal,
        lease: "w9-lease",
        authority: "w9-authority",
        domain: "w9-domain",
        pathEpochs: "w9-path-epochs",
        intentDigest: expected.intentDigest,
        itemKey: expected.itemKey
    };
}

function permitClaimInputs(expected: AuthorityPermitExpectation) {
    const invocation = preparedInvocation(
        expected.invocation.value,
        { value: "permit" },
        { lease: "w9-lease" }
    );
    return {
        invocation,
        claim: new ItemClaim(
            expected.claim,
            expected.invocation,
            expected.itemIndex,
            expected.attemptOrdinal,
            {
                kind: "executor",
                token: "w9-lease",
                worker: new ClaimWorkerId("w9-worker")
            },
            new Date(20)
        )
    };
}

class UnavailableAuthorityPermitAdmission extends AuthorityPermitAdmissionPort<MemoryAuthorityPermitTransaction> {
    public consume(): void {
        throw new TypeError("permit store unavailable");
    }
}

class PassthroughProfileEffects extends ProfileRuntimeEffectsPort<AttemptReceipt> {
    public async emit(
        _host: ProfileRuntimeHostBinding,
        _declaration: EventDeclaration,
        _payload: FacetData,
        _cause: AttemptReceipt
    ): Promise<void> {}

    public async control(
        _host: ProfileRuntimeHostBinding,
        _control: ProfileControlAdmission,
        input: FacetData,
        execute: (input: FacetData) => Promise<FacetData>
    ): Promise<FacetData> {
        return execute(input);
    }

    public async render(
        _host: ProfileRuntimeHostBinding,
        _descriptor: SurfaceDescriptor,
        _context: OperationContext,
        input: FacetData
    ): Promise<FacetData> {
        return input;
    }
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
                    AttemptCompletion.succeeded,
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
