import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, MemoryActorStore, type ActorLocalStore } from "../../src/actors";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    AuthorityPermit,
    AuthorityPermitExpectation,
    AuthorityMutationService,
    Binding,
    BindingValidationEvidence,
    BindingValidationRequest,
    Grant,
    GrantId,
    InvalidationWatermark,
    TargetLeaseEvidence,
    TargetLeaseEvidenceKey,
    MemoryAuthorityPermitStore,
    MemoryTenantAuthorityPermitStore,
    MemoryTenantControlStore,
    PathEpochEvidence,
    ScopeEpoch,
    TargetAuthorityPermitRequest,
    type AuthorityPermitExpectationInit,
    type AuthorityMutationStore,
    type MemoryAuthorityPermitSnapshot,
    type MemoryTenantControlSnapshot,
    type TenantAuthorityPermitStore
} from "../../src/authority";
import {
    TENANT_AUTHORITY_COMMANDS,
    TenantAuthorityCommandStatePort,
    TenantAuthorityRuntimeCommandBackend,
    createClosedTenantAuthorityComposition,
    type ClosedTenantAuthorityComposition,
    type ClosedTenantAuthorityCompositionInit,
    type TenantAuthorityCommandBackend
} from "../../src/composition";
import {
    ContentRef,
    Digest,
    Revision,
    SemVer,
    encodeCanonicalJson,
    jsonDataParser,
    type JsonValue
} from "../../src/core";
import { PackageId, PackagePin } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import {
    BindingName,
    CapabilitySpec,
    FacetRef,
    OperationRef,
    ProtectionDomain
} from "../../src/facets";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    Workspace,
    WorkspaceId
} from "../../src/identity";
import { ClaimWorkerId, ItemClaimId } from "../../src/invocation-references";
import { AuditRecordId, CorrelationId, InvocationId, WriteRecordId } from "../../src/invocations";
import { InvocationId as AuthorityInvocationId } from "../../src/interaction-references";
import {
    AuthorityCheckReply,
    AuthorityPermitIssuanceReply,
    AuthorityPermitIssuanceRequest,
    BindingValidationReply,
    CommandEnvelope,
    CommandEnvelopeCodec,
    MemoryProtocolPersistence,
    MemoryProtocolRecords,
    type CommandCaller,
    type CommandDispatchResult,
    type CommandEnvelopeInit,
    type CommandIdentity,
    type ProtocolPersistence
} from "../../src/protocol";
import {
    ReadableSqlite,
    SqliteActorStore,
    SqliteAuthorityPermitStore,
    SqliteTenantAuthorityPermitStore,
    SqliteProtocolPersistence,
    TransactionalSqlite,
    createSqliteTenantControlStore,
    type SqliteValue
} from "../../src/substrates";
import { RunId, TurnId } from "../../src/agents";
import { TestSqlite } from "../helpers/sqlite";
import { CounterAuthenticator, CounterContentStore } from "../protocol/counter-fixture";
import { reaching, type Assembled } from "./fixture";

const recordData = jsonDataParser((message) => new TypeError(message));

const now = new Date("2026-07-12T14:00:00.000Z");
const tenant = new TenantId("authority-command-tenant");
const tenantActor = new ActorRef("tenant", new ActorId("authority-command-tenant"));
const sourceActor = new ActorRef("workspace", new ActorId("authority-command-source"));
const targetActor = new ActorRef("run", new ActorId("authority-command-target"));
const principal = new PrincipalRef(tenant, new PrincipalId("authority-command-principal"));
const authorityTurn = new TurnId("authority-command-turn");
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("authority-command-workspace"));
const facet = new FacetRef("workspace:mail");
const bindingName = new BindingName("mail");
const grant = new GrantId("authority-command-grant");
const domain = new ProtectionDomain("backend", "authority-command", "may-hold-secrets");
const binding = Binding.active(
    workspaceScope,
    SubjectRef.principal(new PrincipalRef(tenant, principal.principalId)),
    domain,
    bindingName,
    grant,
    facet
);

interface AuthorityCommandRead {
    readonly fence: number;
    readonly principal: PrincipalRef;
    readonly path: PathEpochEvidence;
}

interface AuthorityCommandSnapshot {
    readonly writes: number;
    readonly audits: number;
    readonly permits: number;
    readonly checks: number;
}

interface AuthorityCommandHarness {
    readonly caller: CommandCaller;
    bindingRequest(): BindingValidationRequest;
    checkRequest(path?: PathEpochEvidence, selectedPrincipal?: PrincipalRef): AuthorityCheckRequest;
    permitRequest(path?: PathEpochEvidence): AuthorityPermitIssuanceRequest;
    envelope(
        command: string,
        key: string,
        payload: Uint8Array,
        caller?: CommandCaller,
        lease?: NonNullable<CommandEnvelope["lease"]>
    ): Uint8Array;
    dispatch(
        raw: Uint8Array,
        payload: Uint8Array,
        transport?: CommandCaller
    ): Promise<ReturnTypeResult>;
    setEpoch(epoch: number): void;
    failEvidenceAppend(fail: boolean): void;
    snapshot(): AuthorityCommandSnapshot;
}

type ReturnTypeResult = CommandDispatchResult;

type HarnessFactory = () => AuthorityCommandHarness;

function authorityCommandContract(name: string, create: HarnessFactory): void {
    describe(`closed Tenant authority commands (${name})`, () => {
        test(
            "binds validation and check evidence to the authenticated source and decision time",
            { tags: "p0" },
            async () => {
                const harness = create();
                const validation = harness.bindingRequest();
                const validationPayload = BindingValidationRequest.encode(validation);
                const validated = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.validateBinding,
                        `${name}-binding`,
                        validationPayload
                    ),
                    validationPayload
                );
                const validationReply = BindingValidationReply.decode(validated.reply);

                expect(validated.outcome).toBe("committed");
                expect(validationReply.evidence.binds(validation)).toBe(true);
                expect(validationReply.evidence.checkedAt).toEqual(now);
                expect(
                    BindingValidationEvidence.decode(validated.observation!).binds(validation)
                ).toBe(true);

                const request = harness.checkRequest();
                const payload = AuthorityCheckRequest.encode(request);
                const checked = await harness.dispatch(
                    harness.envelope(TENANT_AUTHORITY_COMMANDS.check, `${name}-check`, payload),
                    payload
                );
                const reply = AuthorityCheckReply.decode(checked.reply);

                expect(checked.outcome).toBe("committed");
                expect(reply.evidence.binds(request)).toBe(true);
                expect(reply.evidence.checkedAt).toEqual(now);
                expect(AuthorityCheckEvidence.decode(checked.observation!).allowed).toBe(true);
                expect(checked.write.caller).toEqual(harness.caller);
            }
        );

        test(
            "rejects source Actor and qualified Principal spoofing before authority evaluation",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.checkRequest();
                const payload = AuthorityCheckRequest.encode(request);
                const spoofedActor = new ActorRef(
                    "workspace",
                    new ActorId(`${name}-spoofed-source`)
                );
                const spoofedCaller: CommandCaller = { kind: "actor", actor: spoofedActor };
                const actorResult = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.check,
                        `${name}-actor-spoof`,
                        payload,
                        spoofedCaller
                    ),
                    payload,
                    spoofedCaller
                );

                const principalRequest = harness.checkRequest(
                    undefined,
                    new PrincipalRef(tenant, new PrincipalId(`${name}-spoofed-principal`))
                );
                const principalPayload = AuthorityCheckRequest.encode(principalRequest);
                const principalResult = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.check,
                        `${name}-principal-spoof`,
                        principalPayload
                    ),
                    principalPayload
                );

                expect([actorResult.outcome, principalResult.outcome]).toEqual([
                    "rejectedAuthority",
                    "rejectedAuthority"
                ]);
                expect(harness.snapshot()).toMatchObject({ checks: 0, writes: 2, audits: 2 });
            }
        );

        test(
            "replays duplicate check evidence without re-evaluating authority",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.checkRequest();
                const payload = AuthorityCheckRequest.encode(request);
                const raw = harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    `${name}-duplicate`,
                    payload
                );

                const first = await harness.dispatch(raw, payload);
                harness.setEpoch(9);
                const duplicate = await harness.dispatch(raw, payload);

                expect(first.outcome).toBe("committed");
                expect(duplicate.outcome).toBe("duplicate");
                expect(duplicate.reply).toEqual(first.reply);
                expect(duplicate.write.duplicateOf?.equals(first.write.id)).toBe(true);
                expect(harness.snapshot().checks).toBe(1);
            }
        );

        test(
            "keeps direct check lease validation but forbids permit envelope leases",
            { tags: "p0" },
            async () => {
                const harness = create();
                const commandLease = { turn: authorityTurn, holder: principal, epoch: 2 };
                const authorityLease = {
                    turn: authorityTurn,
                    holder: principal,
                    epoch: 2
                };
                const check = harness.checkRequest();
                const checkPayload = AuthorityCheckRequest.encode(check);

                const checked = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.check,
                        `${name}-leased-check`,
                        checkPayload,
                        undefined,
                        commandLease
                    ),
                    checkPayload
                );
                const stale = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.check,
                        `${name}-stale-check-lease`,
                        checkPayload,
                        undefined,
                        { ...commandLease, epoch: 3 }
                    ),
                    checkPayload
                );

                const permit = permitRequest(currentPath(1), authorityLease);
                const permitPayload = AuthorityPermitIssuanceRequest.encode(permit);
                const issued = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.issuePermit,
                        `${name}-leased-permit`,
                        permitPayload,
                        undefined,
                        commandLease
                    ),
                    permitPayload
                );

                expect(checked.outcome).toBe("committed");
                expect(stale.outcome).toBe("rejectedLease");
                expect(issued.outcome).toBe("rejectedAuthority");
                expect(harness.snapshot()).toMatchObject({ checks: 1, permits: 0, writes: 3 });
            }
        );

        test(
            "commits a typed stale-path denial instead of issuing stale authority",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.checkRequest();
                harness.setEpoch(2);
                const payload = AuthorityCheckRequest.encode(request);
                const result = await harness.dispatch(
                    harness.envelope(TENANT_AUTHORITY_COMMANDS.check, `${name}-stale`, payload),
                    payload
                );
                const evidence = AuthorityCheckReply.decode(result.reply).evidence;

                expect(result.outcome).toBe("committed");
                expect(evidence).toMatchObject({ decision: "deny", reason: "stalePath" });
                expect(evidence.pathEpochs.target.epoch).toBe(2);
                expect(harness.snapshot()).toMatchObject({ checks: 1, writes: 1, audits: 2 });
            }
        );

        test(
            "[protocol.authority-permit-issuance-request] [protocol.authority-permit-issuance-reply] issues a source-bound permit only for the current path",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.permitRequest();
                const payload = AuthorityPermitIssuanceRequest.encode(request);
                const result = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.issuePermit,
                        `${name}-permit`,
                        payload
                    ),
                    payload
                );
                const permit = AuthorityPermitIssuanceReply.decode(result.reply).requirePermit();

                expect(result.outcome).toBe("committed");
                expect(permit.expectation.equals(request.targetRequest.expectation)).toBe(true);
                expect(permit.issuedAt).toEqual(now);
                expect(
                    AuthorityPermitIssuanceReply.decode(result.observation!)
                        .requirePermit()
                        .digest()
                        .equals(permit.digest())
                ).toBe(true);
                expect(harness.snapshot()).toMatchObject({ permits: 1, writes: 1, audits: 2 });

                const staleHarness = create();
                const staleRequest = staleHarness.permitRequest();
                staleHarness.setEpoch(3);
                const stalePayload = AuthorityPermitIssuanceRequest.encode(staleRequest);
                const denied = await staleHarness.dispatch(
                    staleHarness.envelope(
                        TENANT_AUTHORITY_COMMANDS.issuePermit,
                        `${name}-stale-permit`,
                        stalePayload
                    ),
                    stalePayload
                );
                expect(denied.outcome).toBe("rejectedAuthority");
                expect(AuthorityPermitIssuanceReply.decode(denied.reply)).toMatchObject({
                    kind: "denied",
                    evidence: { decision: "deny", reason: "stalePath" }
                });
                expect(staleHarness.snapshot()).toMatchObject({
                    permits: 0,
                    writes: 1,
                    audits: 1
                });
            }
        );

        test(
            "rolls permit issuance back when linked WriteRecord evidence rejects",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.permitRequest();
                const payload = AuthorityPermitIssuanceRequest.encode(request);
                const raw = harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.issuePermit,
                    `${name}-atomic`,
                    payload
                );
                harness.failEvidenceAppend(true);

                await expect(harness.dispatch(raw, payload)).rejects.toThrow(/evidence append/);
                expect(harness.snapshot()).toEqual({ writes: 0, audits: 0, permits: 0, checks: 0 });

                harness.failEvidenceAppend(false);
                expect((await harness.dispatch(raw, payload)).outcome).toBe("committed");
                expect(harness.snapshot()).toMatchObject({ writes: 1, permits: 1 });
            }
        );

        test(
            "replays the original authority denial and cannot later issue under the same identity",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.permitRequest();
                harness.setEpoch(3);
                const payload = AuthorityPermitIssuanceRequest.encode(request);
                const raw = harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.issuePermit,
                    `${name}-denial-response-loss`,
                    payload
                );

                const denied = await harness.dispatch(raw, payload);
                expect(harness.snapshot()).toMatchObject({ permits: 0, writes: 1, audits: 1 });
                harness.setEpoch(1);
                const duplicate = await harness.dispatch(raw, payload);

                expect(denied.outcome).toBe("rejectedAuthority");
                expect(AuthorityPermitIssuanceReply.decode(denied.reply).kind).toBe("denied");
                expect(duplicate.outcome).toBe("duplicate");
                expect(duplicate.reply).toEqual(denied.reply);
                expect(duplicate.write.duplicateOf?.equals(denied.write.id)).toBe(true);
                expect(harness.snapshot()).toMatchObject({ permits: 0, writes: 2, audits: 3 });
            }
        );

        test("records malformed ingress without evaluating authority", { tags: "p1" }, async () => {
            const harness = create();
            await expect(
                harness.dispatch(new Uint8Array([0xff]), new Uint8Array())
            ).resolves.toMatchObject({
                outcome: "rejectedMalformed"
            });
            expect(harness.snapshot()).toEqual({ writes: 1, audits: 1, permits: 0, checks: 0 });
        });
    });
}

authorityCommandContract("memory", createMemoryHarness);
authorityCommandContract("SQLite", createSqliteHarness);

interface ProductionPermitHarness {
    currentPath(): PathEpochEvidence;
    persistTarget(request: AuthorityPermitIssuanceRequest): AuthorityPermitIssuanceRequest;
    dispatch(
        request: AuthorityPermitIssuanceRequest,
        caller?: CommandCaller
    ): Promise<CommandDispatchResult>;
    revokeAndRestartTenant(): void;
    restartTenant(): void;
    failEvidenceAppend(fail: boolean): void;
    issued(nonce: string): AuthorityPermit | undefined;
    writes(): number;
}

type ProductionPermitHarnessFactory = () => ProductionPermitHarness;

function productionPermitContract(name: string, create: ProductionPermitHarnessFactory): void {
    describe(`production Tenant authority permit runtime (${name})`, () => {
        test(
            "issues only from an authenticated target-owned request after both Actors restart",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.persistTarget(
                    permitRequest(
                        harness.currentPath(),
                        undefined,
                        {},
                        { channel: "internal" },
                        `${name}-production-allowed`
                    )
                );
                harness.restartTenant();

                const result = await harness.dispatch(request);
                const permit = AuthorityPermitIssuanceReply.decode(result.reply).requirePermit();

                expect(result.outcome).toBe("committed");
                expect(permit.expectation.equals(request.targetRequest.expectation)).toBe(true);
                expect(harness.issued(request.targetRequest.nonce)?.digest().value).toBe(
                    permit.digest().value
                );
            }
        );

        test(
            "[tenant-authority-transaction-port] rechecks current Tenant authority after revocation and restart before issuing",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.persistTarget(
                    permitRequest(
                        harness.currentPath(),
                        undefined,
                        {},
                        { channel: "internal" },
                        `${name}-production-revoked`
                    )
                );
                harness.revokeAndRestartTenant();

                const denied = await harness.dispatch(request);
                expect(denied.outcome).toBe("rejectedAuthority");
                expect(AuthorityPermitIssuanceReply.decode(denied.reply).kind).toBe("denied");
                expect(harness.issued(request.targetRequest.nonce)).toBeUndefined();
                expect(harness.writes()).toBe(1);
            }
        );

        test(
            "evaluates the target request's full canonical arguments rather than its digest alone",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.persistTarget(
                    permitRequest(
                        harness.currentPath(),
                        undefined,
                        {},
                        { channel: "external" },
                        `${name}-production-arguments`
                    )
                );

                const denied = await harness.dispatch(request);
                expect(denied.outcome).toBe("rejectedAuthority");
                expect(AuthorityPermitIssuanceReply.decode(denied.reply).kind).toBe("denied");
                expect(harness.issued(request.targetRequest.nonce)).toBeUndefined();
            }
        );

        test(
            "authenticates the target ActorRef without a Tenant-side target-fence mirror",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.persistTarget(
                    permitRequest(
                        harness.currentPath(),
                        undefined,
                        {},
                        { channel: "internal" },
                        `${name}-production-caller`
                    )
                );

                const result = await harness.dispatch(request, {
                    kind: "actor",
                    actor: sourceActor
                });

                expect(result.outcome).toBe("rejectedAuthority");
                expect(harness.issued(request.targetRequest.nonce)).toBeUndefined();
            }
        );

        test(
            "rolls permit issuance back when durable command evidence cannot commit",
            { tags: "p0" },
            async () => {
                const harness = create();
                const request = harness.persistTarget(
                    permitRequest(
                        harness.currentPath(),
                        undefined,
                        {},
                        { channel: "internal" },
                        `${name}-production-rollback`
                    )
                );

                harness.failEvidenceAppend(true);
                await expect(harness.dispatch(request)).rejects.toBeInstanceOf(TypeError);
                expect(harness.issued(request.targetRequest.nonce)).toBeUndefined();
                expect(harness.writes()).toBe(0);

                harness.failEvidenceAppend(false);
                await expect(harness.dispatch(request)).resolves.toMatchObject({
                    outcome: "committed"
                });
                expect(harness.issued(request.targetRequest.nonce)).toBeDefined();
            }
        );
    });
}

productionPermitContract("memory", createProductionMemoryHarness);
productionPermitContract("SQLite", createProductionSqliteHarness);

test(
    "closed Tenant authority composition rejects a non-Tenant owning Actor",
    { tags: "p0" },
    () => {
        // SAFETY: ClosedTenantAuthorityCompositionInit requires a store, persistence, backend
        // and the rest, so an init carrying only an Actor is unreachable through the type. The
        // Actor check has to run before any of them is read, which is what this pins.
        expect(() =>
            createClosedTenantAuthorityComposition({
                actor: sourceActor
            } as never)
        ).toThrow(/requires a Tenant Actor/);
    }
);

const otherTenant = new TenantId("authority-command-other-tenant");
const otherTenantActor = new ActorRef("tenant", new ActorId("authority-command-other-tenant"));
const otherPrincipal = new PrincipalRef(
    tenant,
    new PrincipalId("authority-command-other-principal")
);
const otherTenantPrincipal = new PrincipalRef(
    otherTenant,
    new PrincipalId("authority-command-principal")
);
const otherTenantPath = new PathEpochEvidence([
    ScopeEpoch.initial(ScopeRef.tenant(otherTenant)),
    new ScopeEpoch(
        ScopeRef.workspace(otherTenant, new WorkspaceId("authority-command-workspace")),
        1
    )
]);
const otherWorkspaceActor = new ActorRef(
    "workspace",
    new ActorId("authority-command-other-workspace")
);
const spoofedCaller: CommandCaller = {
    kind: "actor",
    actor: new ActorRef("workspace", new ActorId("authority-command-spoofed"))
};
/**
 * Dispatches a command that must be refused and hands back the refusal it threw. A gate may
 * refuse with either an AgentCoreError or a TypeError, so the caller reads the class it wants.
 */
async function dispatchFailure(
    harness: AuthorityCommandHarness,
    raw: Uint8Array,
    payload: Uint8Array
): Promise<Error> {
    try {
        await harness.dispatch(raw, payload);
    } catch (error) {
        if (error instanceof Error) return error;
        throw new TypeError(`Expected an Error, caught ${String(error)}`, { cause: error });
    }
    throw new TypeError("Expected the dispatch to be refused");
}

describe("closed Tenant authority command gates", () => {
    test(
        "binding validation admits only the owning Tenant, its Workspace Actor, and the exact fence",
        { tags: "p0" },
        async () => {
            const harness = createMemoryHarness();
            const refusals: readonly (readonly [
                string,
                BindingValidationRequest,
                CommandCaller | undefined
            ])[] = [
                ["another owning Tenant", bindingRequest({ ownerTenant: otherTenant }), undefined],
                ["a spoofed Workspace Actor", bindingRequest(), spoofedCaller],
                ["a stale Workspace fence", bindingRequest({ workspaceFence: 8 }), undefined]
            ];

            let ordinal = 0;
            for (const [reason, request, caller] of refusals) {
                ordinal += 1;
                const payload = BindingValidationRequest.encode(request);
                const result = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.validateBinding,
                        `binding-gate-${ordinal}`,
                        payload,
                        caller
                    ),
                    payload,
                    caller
                );
                expect(result.outcome, reason).toBe("rejectedAuthority");
            }

            const admitted = bindingRequest();
            const admittedPayload = BindingValidationRequest.encode(admitted);
            const accepted = await harness.dispatch(
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.validateBinding,
                    "binding-gate-admitted",
                    admittedPayload
                ),
                admittedPayload
            );
            expect(accepted.outcome).toBe("committed");
        }
    );

    test(
        "authority check admits only the owning Tenant, exact owner fence, and resolved Principal",
        { tags: "p0" },
        async () => {
            const refusals: readonly (readonly [
                string,
                AuthorityCheckRequest,
                Partial<AuthorityBackend>
            ])[] = [
                [
                    "another owning Tenant",
                    checkRequest(currentPath(1), principal, { ownerTenant: otherTenant }),
                    {}
                ],
                [
                    "a stale owner fence",
                    checkRequest(currentPath(1), principal, { ownerFence: 8 }),
                    {}
                ],
                [
                    "an unresolved Principal",
                    checkRequest(currentPath(1), principal),
                    { checkPrincipal: () => undefined }
                ],
                [
                    "a substituted Principal",
                    checkRequest(currentPath(1), principal),
                    { checkPrincipal: () => otherPrincipal }
                ]
            ];

            let ordinal = 0;
            for (const [reason, request, backend] of refusals) {
                ordinal += 1;
                const harness = createMemoryHarness(backend);
                const payload = AuthorityCheckRequest.encode(request);
                const result = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.check,
                        `check-gate-${ordinal}`,
                        payload
                    ),
                    payload
                );
                expect(result.outcome, reason).toBe("rejectedAuthority");
                expect(harness.snapshot().checks, reason).toBe(0);
            }
        }
    );

    test(
        "permit issuance admits only the owning Tenant and authenticated target Actor",
        { tags: "p0" },
        async () => {
            const refusals: readonly (readonly [
                string,
                AuthorityPermitIssuanceRequest,
                Partial<AuthorityBackend>,
                CommandCaller | undefined
            ])[] = [
                [
                    "an expectation for another Tenant",
                    permitRequest(otherTenantPath, undefined, {
                        tenant: otherTenant,
                        principal: otherTenantPrincipal,
                        authority: {
                            kind: "initiator",
                            principal: otherTenantPrincipal,
                            binding: bindingName
                        }
                    }),
                    {},
                    { kind: "actor", actor: targetActor }
                ],
                [
                    "an expectation naming another issuing Tenant Actor",
                    permitRequest(currentPath(1), undefined, { issuer: otherTenantActor }),
                    {},
                    { kind: "actor", actor: targetActor }
                ],
                ["a spoofed target Actor", permitRequest(currentPath(1)), {}, spoofedCaller]
            ];

            let ordinal = 0;
            for (const [reason, request, backend, caller] of refusals) {
                ordinal += 1;
                const harness = createMemoryHarness(backend);
                const payload = AuthorityPermitIssuanceRequest.encode(request);
                const result = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.issuePermit,
                        `permit-gate-${ordinal}`,
                        payload,
                        caller
                    ),
                    payload,
                    caller
                );
                expect(result.outcome, reason).toBe("rejectedAuthority");
                expect(harness.snapshot().permits, reason).toBe(0);
            }

            const harness = createMemoryHarness();
            const admitted = permitRequest(currentPath(1));
            const admittedPayload = AuthorityPermitIssuanceRequest.encode(admitted);
            const accepted = await harness.dispatch(
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.issuePermit,
                    "permit-gate-admitted",
                    admittedPayload
                ),
                admittedPayload
            );
            expect(accepted.outcome).toBe("committed");
        }
    );

    test(
        "permit issuance forbids an envelope lease and requires projected source evidence",
        { tags: "p0" },
        async () => {
            const expectationLease = { turn: authorityTurn, holder: principal, epoch: 2 };
            const refusals: readonly (readonly [
                string,
                NonNullable<CommandEnvelope["lease"]> | undefined,
                AuthorityPermitExpectation["lease"]
            ])[] = [
                [
                    "an envelope lease without an expectation lease",
                    { turn: authorityTurn, holder: principal, epoch: 2 },
                    undefined
                ],
                ["an expectation lease without an envelope lease", undefined, expectationLease],
                [
                    "a lease for another Turn",
                    {
                        turn: new TurnId("authority-command-other-turn"),
                        holder: principal,
                        epoch: 2
                    },
                    expectationLease
                ],
                [
                    "a lease held by another Principal",
                    { turn: authorityTurn, holder: otherPrincipal, epoch: 2 },
                    expectationLease
                ],
                [
                    "a fenced lease epoch",
                    { turn: authorityTurn, holder: principal, epoch: 3 },
                    expectationLease
                ]
            ];

            let ordinal = 0;
            for (const [reason, envelopeLease, lease] of refusals) {
                ordinal += 1;
                const harness = createMemoryHarness();
                const request = permitRequest(currentPath(1), lease);
                const payload = AuthorityPermitIssuanceRequest.encode(request);
                const result = await harness.dispatch(
                    harness.envelope(
                        TENANT_AUTHORITY_COMMANDS.issuePermit,
                        `permit-lease-${ordinal}`,
                        payload,
                        undefined,
                        envelopeLease
                    ),
                    payload
                );
                expect(result.outcome, reason).toBe(
                    envelopeLease !== undefined && lease === undefined
                        ? "rejectedLease"
                        : "rejectedAuthority"
                );
                expect(harness.snapshot().permits, reason).toBe(0);
            }
            const harness = createMemoryHarness();
            const request = permitRequest(currentPath(1), expectationLease);
            const payload = AuthorityPermitIssuanceRequest.encode(request);
            const result = await harness.dispatch(
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.issuePermit,
                    "permit-lease-without-projection",
                    payload
                ),
                payload
            );
            expect(result.outcome).toBe("rejectedAuthority");
        }
    );

    test("non-Actor callers are refused before authority evaluation", { tags: "p0" }, async () => {
        const harness = createMemoryHarness();
        const caller: CommandCaller = { kind: "principal", principal };
        const payload = AuthorityCheckRequest.encode(checkRequest(currentPath(1), principal));
        const result = await harness.dispatch(
            harness.envelope(TENANT_AUTHORITY_COMMANDS.check, "principal-caller", payload, caller),
            payload,
            caller
        );

        expect(result.outcome).toBe("rejectedAuthentication");
        expect(harness.snapshot().checks).toBe(0);
    });

    test("substituted Binding validation evidence fails closed", { tags: "p0" }, async () => {
        const request = bindingRequest();
        const substitutions: readonly (readonly [string, BindingValidationEvidence])[] = [
            [
                "evidence bound to another request",
                new BindingValidationEvidence(
                    tenant,
                    tenantActor,
                    digest("substituted-binding-request"),
                    workspaceScope,
                    binding.subject,
                    grant,
                    currentPath(1),
                    now
                )
            ],
            [
                "evidence issued by another Tenant Actor",
                new BindingValidationEvidence(
                    tenant,
                    otherTenantActor,
                    request.digest(),
                    workspaceScope,
                    binding.subject,
                    grant,
                    currentPath(1),
                    now
                )
            ],
            [
                "evidence stamped at another instant",
                new BindingValidationEvidence(
                    tenant,
                    tenantActor,
                    request.digest(),
                    workspaceScope,
                    binding.subject,
                    grant,
                    currentPath(1),
                    new Date(now.getTime() + 1)
                )
            ]
        ];

        let ordinal = 0;
        for (const [reason, evidence] of substitutions) {
            ordinal += 1;
            const harness = createMemoryHarness({ validateBinding: () => evidence });
            const payload = BindingValidationRequest.encode(request);
            const error = await dispatchFailure(
                harness,
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.validateBinding,
                    `binding-evidence-${ordinal}`,
                    payload
                ),
                payload
            );
            expect(error, reason).toBeInstanceOf(TypeError);
            expect(error, reason).toMatchObject({
                message: "Binding validation returned substituted evidence"
            });
            expect(harness.snapshot(), reason).toMatchObject({ writes: 0, audits: 0 });
        }
    });

    test("substituted authority check evidence fails closed", { tags: "p0" }, async () => {
        const request = checkRequest(currentPath(1), principal);
        const substitutions: readonly (readonly [string, AuthorityCheckEvidence])[] = [
            [
                "evidence bound to another request",
                checkEvidenceWith({ requestDigest: digest("substituted-check-request") })
            ],
            [
                "evidence issued by another Tenant Actor",
                checkEvidenceWith({ requestDigest: request.digest(), issuer: otherTenantActor })
            ],
            [
                "evidence stamped at another instant",
                checkEvidenceWith({
                    requestDigest: request.digest(),
                    checkedAt: new Date(now.getTime() + 1)
                })
            ],
            [
                "evidence issued under another Tenant",
                checkEvidenceWith({
                    requestDigest: request.digest(),
                    issuerTenant: otherTenant,
                    pathEpochs: otherTenantPath
                })
            ]
        ];

        let ordinal = 0;
        for (const [reason, evidence] of substitutions) {
            ordinal += 1;
            const harness = createMemoryHarness({ check: () => evidence });
            const payload = AuthorityCheckRequest.encode(request);
            const error = await dispatchFailure(
                harness,
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    `check-evidence-${ordinal}`,
                    payload
                ),
                payload
            );
            expect(error, reason).toBeInstanceOf(TypeError);
            expect(error, reason).toMatchObject({
                message: "Authority check returned substituted evidence"
            });
            expect(harness.snapshot(), reason).toMatchObject({ writes: 0, audits: 0 });
        }
    });

    test("a substituted issued permit fails closed", { tags: "p0" }, async () => {
        const substitutions: readonly (readonly [string, AuthorityBackend["issuePermit"]])[] = [
            [
                "a substituted expectation",
                (_state, request, at) =>
                    issuedReply(
                        request,
                        new AuthorityPermit({
                            ...request.targetRequest.expectation,
                            attemptOrdinal: 1,
                            nonce: request.targetRequest.nonce,
                            requestDigest: request.targetRequest.digest(),
                            issuedAt: at,
                            expiresAt: request.targetRequest.expiresAt
                        }),
                        at
                    )
            ],
            [
                "a substituted issuer",
                (_state, request, at) =>
                    issuedReply(
                        request,
                        new AuthorityPermit({
                            ...request.targetRequest.expectation,
                            issuer: otherTenantActor,
                            nonce: request.targetRequest.nonce,
                            requestDigest: request.targetRequest.digest(),
                            issuedAt: at,
                            expiresAt: request.targetRequest.expiresAt
                        }),
                        at
                    )
            ],
            [
                "a substituted nonce",
                (_state, request, at) =>
                    issuedReply(
                        request,
                        new AuthorityPermit({
                            ...request.targetRequest.expectation,
                            nonce: `${request.targetRequest.nonce}-substituted`,
                            requestDigest: request.targetRequest.digest(),
                            issuedAt: at,
                            expiresAt: request.targetRequest.expiresAt
                        }),
                        at
                    )
            ],
            [
                "a future issuance instant",
                (_state, request, at) =>
                    issuedReply(
                        request,
                        new AuthorityPermit({
                            ...request.targetRequest.expectation,
                            nonce: request.targetRequest.nonce,
                            requestDigest: request.targetRequest.digest(),
                            issuedAt: new Date(at.getTime() + 1),
                            expiresAt: request.targetRequest.expiresAt
                        }),
                        at
                    )
            ],
            [
                "a substituted expiry",
                (_state, request, at) =>
                    issuedReply(
                        request,
                        new AuthorityPermit({
                            ...request.targetRequest.expectation,
                            nonce: request.targetRequest.nonce,
                            requestDigest: request.targetRequest.digest(),
                            issuedAt: at,
                            expiresAt: new Date(request.targetRequest.expiresAt.getTime() + 1)
                        }),
                        at
                    )
            ],
            [
                "a substituted target request digest",
                (_state, request, at) =>
                    issuedReply(
                        request,
                        new AuthorityPermit({
                            ...request.targetRequest.expectation,
                            nonce: request.targetRequest.nonce,
                            requestDigest: digest("substituted-target-request"),
                            issuedAt: at,
                            expiresAt: request.targetRequest.expiresAt
                        }),
                        at
                    )
            ]
        ];

        let ordinal = 0;
        for (const [reason, issuePermit] of substitutions) {
            ordinal += 1;
            const harness = createMemoryHarness({ issuePermit });
            const payload = AuthorityPermitIssuanceRequest.encode(permitRequest(currentPath(1)));
            const error = await dispatchFailure(
                harness,
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.issuePermit,
                    `permit-evidence-${ordinal}`,
                    payload
                ),
                payload
            );
            expect(error, reason).toBeInstanceOf(TypeError);
            expect(error, reason).toMatchObject({
                message: "Authority permit issuer returned substituted evidence"
            });
            expect(harness.snapshot(), reason).toMatchObject({ writes: 0, audits: 0 });
        }
    });

    test(
        "a permit decision whose evidence answers another request fails closed",
        { tags: "p0" },
        async () => {
            // The issuer's own guard reports an unbound decision as a typed protocol fault;
            // this pins the composition's independent check of the same property, which is
            // what stands between a substituted backend and a committed permit decision.
            const harness = createMemoryHarness({
                issuePermit: (_state, request, at) =>
                    AuthorityPermitIssuanceReply.issued(
                        checkEvidenceWith({
                            requestDigest: digest("substituted-permit-decision"),
                            checkedAt: at
                        }),
                        permitFor(request, at)
                    )
            });
            const payload = AuthorityPermitIssuanceRequest.encode(permitRequest(currentPath(1)));
            const error = await dispatchFailure(
                harness,
                harness.envelope(
                    TENANT_AUTHORITY_COMMANDS.issuePermit,
                    "permit-unbound-decision",
                    payload
                ),
                payload
            );

            expect(error).toBeInstanceOf(TypeError);
            expect(error).toMatchObject({
                message: "Authority permit issuer returned substituted evidence"
            });
            expect(harness.snapshot()).toEqual({ writes: 0, audits: 0, permits: 0, checks: 0 });
        }
    );

    test(
        "an exact prior issuance can be replayed after response loss",
        { tags: "p0" },
        async () => {
            const request = permitRequest(currentPath(1));
            const harness = createMemoryHarness();
            const payload = AuthorityPermitIssuanceRequest.encode(request);
            const raw = harness.envelope(
                TENANT_AUTHORITY_COMMANDS.issuePermit,
                "permit-response-loss",
                payload
            );
            const issued = await harness.dispatch(raw, payload);
            harness.setEpoch(3);
            const replay = await harness.dispatch(raw, payload);

            expect(replay.outcome).toBe("duplicate");
            expect(replay.reply).toEqual(issued.reply);
            expect(
                AuthorityPermitIssuanceReply.decode(replay.reply).requirePermit().issuedAt
            ).toEqual(now);
        }
    );

    test(
        "the composition ingress leases command payloads on the supplied clock",
        { tags: "p1" },
        async () => {
            const future = new Date("2199-01-01T00:00:00.000Z");
            const harness = createMemoryHarness({}, future);
            const request = checkRequest(currentPath(1), principal);
            const payload = AuthorityCheckRequest.encode(request);
            const result = await harness.dispatch(
                harness.envelope(TENANT_AUTHORITY_COMMANDS.check, "future-clock", payload),
                payload
            );

            expect(result.outcome).toBe("committed");
            expect(AuthorityCheckReply.decode(result.reply).evidence.checkedAt).toEqual(future);
        }
    );

    test(
        "the composition ingress leases command payloads on the wall clock by default",
        { tags: "p1" },
        async () => {
            const before = Date.now();
            const harness = createMemoryHarness({}, "wall");
            const request = harness.checkRequest();
            const payload = AuthorityCheckRequest.encode(request);
            const result = await harness.dispatch(
                harness.envelope(TENANT_AUTHORITY_COMMANDS.check, "default-clock", payload),
                payload
            );
            const checkedAt = AuthorityCheckReply.decode(result.reply).evidence.checkedAt.getTime();

            expect(result.outcome).toBe("committed");
            expect(checkedAt).toBeGreaterThanOrEqual(before);
            expect(checkedAt).toBeLessThanOrEqual(Date.now());
        }
    );

    test(
        "refuses an envelope naming a revision or a lease no authority command carries",
        { tags: "p2" },
        async () => {
            // Both authority commands forbid an expected revision and Binding validation
            // forbids a lease, so the ingress refuses the envelope outright and no command
            // is ever asked for a current revision or a current lease.
            const harness = createMemoryHarness();
            const validation = BindingValidationRequest.encode(bindingRequest());
            const revisioned = await harness.dispatch(
                envelope(
                    TENANT_AUTHORITY_COMMANDS.validateBinding,
                    "binding-revision",
                    validation,
                    harness.caller,
                    undefined,
                    Revision.initial()
                ),
                validation
            );
            const leased = await harness.dispatch(
                envelope(
                    TENANT_AUTHORITY_COMMANDS.validateBinding,
                    "binding-lease",
                    validation,
                    harness.caller,
                    { turn: authorityTurn, holder: principal, epoch: 2 }
                ),
                validation
            );
            const checkPayload = AuthorityCheckRequest.encode(harness.checkRequest());
            const checkRevision = await harness.dispatch(
                envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    "check-revision",
                    checkPayload,
                    harness.caller,
                    undefined,
                    Revision.initial()
                ),
                checkPayload
            );

            expect([revisioned.outcome, leased.outcome, checkRevision.outcome]).toEqual([
                "rejectedMalformed",
                "rejectedLease",
                "rejectedMalformed"
            ]);
            expect(harness.snapshot()).toMatchObject({ checks: 0, permits: 0 });
        }
    );
});

/**
 * The production runtime backend under the same ingress the mock backends run under: the
 * fence, Principal and lease each command compares are the state port's answers, and the
 * evidence it returns is live Tenant authority's rather than a double's.
 */
describe("the Tenant authority runtime command backend", () => {
    test(
        "answers Binding validation and authority checks from live Tenant authority",
        { tags: "p0" },
        async () => {
            const harness = createProductionCommandHarness();
            const validation = bindingRequest();
            const validated = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.validateBinding,
                "runtime-binding",
                BindingValidationRequest.encode(validation)
            );
            const evidence = BindingValidationReply.decode(validated.reply).evidence;

            expect(validated.outcome).toBe("committed");
            expect(evidence.binds(validation)).toBe(true);
            expect(evidence.grantId.equals(grant)).toBe(true);
            expect(evidence.issuer.equals(tenantActor)).toBe(true);
            expect(evidence.pathEpochs.equals(harness.path())).toBe(true);

            const request = checkRequest(harness.path(), principal);
            const checked = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.check,
                "runtime-check",
                AuthorityCheckRequest.encode(request)
            );
            const decision = AuthorityCheckReply.decode(checked.reply).evidence;

            expect(checked.outcome).toBe("committed");
            expect(decision.binds(request)).toBe(true);
            expect(decision.allowed).toBe(true);
            expect(decision.reason).toBe("allowed");
            expect(decision.matchedAllow.map((id) => id.value)).toContain(grant.value);
        }
    );

    test(
        "compares the exact fence and Principal the state port answers",
        { tags: "p0" },
        async () => {
            const harness = createProductionCommandHarness();
            const stale = bindingRequest({ workspaceFence: 8, nonce: "runtime-stale-fence" });
            const fenced = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.validateBinding,
                "runtime-stale-fence",
                BindingValidationRequest.encode(stale)
            );
            // The state port answers a fence for the Workspace Actor alone, so a request
            // naming any other Actor has no fence to equal rather than a mismatched one.
            const unfenced = bindingRequest({
                workspaceActor: otherWorkspaceActor,
                nonce: "runtime-unfenced-actor"
            });
            const unknown = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.validateBinding,
                "runtime-unfenced-actor",
                BindingValidationRequest.encode(unfenced),
                { kind: "actor", actor: otherWorkspaceActor }
            );
            const substituted = AuthorityCheckRequest.encode(
                checkRequest(harness.path(), otherPrincipal)
            );
            const spoofed = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.check,
                "runtime-substituted-principal",
                substituted
            );

            expect([fenced.outcome, unknown.outcome, spoofed.outcome]).toEqual([
                "rejectedAuthority",
                "rejectedAuthority",
                "rejectedAuthority"
            ]);
            expect(harness.issued("authority-command-permit")).toBeUndefined();
        }
    );

    test(
        "continues to validate check leases while permit issuance has no Tenant lease lookup",
        { tags: "p0" },
        async () => {
            const harness = createProductionCommandHarness(new LeasedProductionCommandState());
            const lease = { turn: authorityTurn, holder: principal, epoch: 2 };
            const checkPayload = AuthorityCheckRequest.encode(
                checkRequest(harness.path(), principal)
            );
            const leased = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.check,
                "runtime-leased-check",
                checkPayload,
                undefined,
                lease
            );
            const fenced = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.check,
                "runtime-fenced-check",
                checkPayload,
                undefined,
                { ...lease, epoch: 3 }
            );
            const permit = permitRequest(harness.path(), lease);
            const rejected = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.issuePermit,
                "runtime-lease-forbidden",
                AuthorityPermitIssuanceRequest.encode(permit),
                { kind: "actor", actor: targetActor },
                lease
            );

            expect(leased.outcome).toBe("committed");
            expect(fenced.outcome).toBe("rejectedLease");
            expect(rejected.outcome).toBe("rejectedAuthority");
            expect(harness.issued(permit.targetRequest.nonce)).toBeUndefined();
        }
    );

    test(
        "projects source evidence idempotently before issuing the exact permit",
        { tags: "p0" },
        async () => {
            const harness = createProductionCommandHarness();
            const lease = { turn: authorityTurn, holder: principal, epoch: 2 };
            const projectedRequest = projectedPermitRequest(harness.path(), lease);
            const evidenceBytes = TargetLeaseEvidence.encode(projectedRequest.evidence);
            const forged = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.projectLeaseEvidence,
                projectedRequest.evidence.key.idempotencyKey,
                evidenceBytes,
                { kind: "actor", actor: targetActor }
            );
            const projected = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.projectLeaseEvidence,
                projectedRequest.evidence.key.idempotencyKey,
                evidenceBytes
            );
            const duplicate = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.projectLeaseEvidence,
                projectedRequest.evidence.key.idempotencyKey,
                evidenceBytes
            );
            const issued = await harness.dispatch(
                TENANT_AUTHORITY_COMMANDS.issuePermit,
                "projected-permit-issue",
                AuthorityPermitIssuanceRequest.encode(projectedRequest.request),
                { kind: "actor", actor: targetActor }
            );

            expect(forged.outcome).toBe("rejectedAuthority");
            expect(forged.write.audit).toBeDefined();
            expect(projected.outcome).toBe("committed");
            expect(duplicate.outcome).toBe("duplicate");
            expect(issued.outcome).toBe("committed");
            const permit = AuthorityPermitIssuanceReply.decode(issued.reply).requirePermit();
            expect(permit.requestDigest.equals(projectedRequest.request.targetRequest.digest())).toBe(
                true
            );
            expect(harness.issued(permit.nonce)?.digest().equals(permit.digest())).toBe(true);
        }
    );

    test("requires its own Tenant permit owner as the issuing Actor", { tags: "p0" }, () => {
        expect(
            () =>
                new TenantAuthorityRuntimeCommandBackend(
                    productionCommandState,
                    createProductionMemoryStore(createProductionActorStore()),
                    otherTenantActor
                )
        ).toThrow(/requires its Tenant permit owner/);
        // A real Tenant permit store refuses a non-Tenant owner in its own constructor, so
        // only a stand-in can present the owner the second clause of this guard exists for.
        expect(
            () =>
                new TenantAuthorityRuntimeCommandBackend(
                    productionCommandState,
                    reaching<TenantAuthorityPermitStore<ProductionMemoryState>>({
                        owner: sourceActor
                    }),
                    sourceActor
                )
        ).toThrow(/requires its Tenant permit owner/);
    });

    test(
        "refuses a composition whose dispatcher commits to another transaction store",
        { tags: "p0" },
        () => {
            const store = createProductionMemoryStore(createProductionActorStore());
            const other = createProductionMemoryStore(createProductionActorStore());
            expect(() =>
                createComposition(
                    store,
                    new MemoryProtocolPersistence<ProductionMemoryState>((state) => state.records),
                    new TenantAuthorityRuntimeCommandBackend(
                        productionCommandState,
                        other,
                        tenantActor
                    ),
                    nextProductionMemoryId
                )
            ).toThrow(/require one transaction store/);
        }
    );
});

/** Dispatches any Tenant authority command against the production runtime backend. */
interface ProductionCommandHarness {
    path(): PathEpochEvidence;
    dispatch(
        command: string,
        key: string,
        payload: Uint8Array,
        caller?: CommandCaller,
        lease?: NonNullable<CommandEnvelope["lease"]>
    ): Promise<CommandDispatchResult>;
    issued(nonce: string): AuthorityPermit | undefined;
}

/** A state port answering the current lease the leased command paths compare against. */
class LeasedProductionCommandState extends TenantAuthorityCommandStatePort<AuthorityCommandRead> {
    public actorFence(read: AuthorityCommandRead, actor: ActorRef): number | undefined {
        return actor.equals(sourceActor) ? read.fence : undefined;
    }

    public checkPrincipal(read: AuthorityCommandRead): PrincipalRef {
        return read.principal;
    }

    public currentCheckLease(
        _read: AuthorityCommandRead,
        _request: AuthorityCheckRequest,
        at: Date
    ) {
        return {
            turn: authorityTurn,
            holder: principal,
            epoch: 2,
            expiresAt: new Date(at.getTime() + 5_000)
        };
    }

    public currentPermitLease(
        _read: AuthorityCommandRead,
        request: AuthorityPermitIssuanceRequest,
        at: Date
    ) {
        const lease = request.targetRequest.expectation.lease;
        if (lease === undefined) return undefined;
        return {
            turn: lease.turn,
            holder: principal,
            epoch: lease.epoch,
            expiresAt: new Date(at.getTime() + 5_000)
        };
    }
}

function createProductionCommandHarness(
    state: TenantAuthorityCommandStatePort<AuthorityCommandRead> = productionCommandState
): ProductionCommandHarness {
    const actorStore = createProductionActorStore();
    const store = createProductionMemoryStore(actorStore);
    const composition = createComposition(
        store,
        new MemoryProtocolPersistence<ProductionMemoryState>((record) => record.records),
        new TenantAuthorityRuntimeCommandBackend(state, store, tenantActor),
        nextProductionMemoryId
    );
    return {
        path: () => productionPath(readProductionMemoryControl(actorStore)),
        dispatch: (command, key, payload, caller, lease) => {
            const dispatchCaller = caller ?? { kind: "actor", actor: sourceActor };
            return composition.dispatch(
                envelope(command, key, payload, dispatchCaller, lease),
                dispatchCaller,
                payload
            );
        },
        issued: (nonce) => store.transaction((transaction) => store.issued(transaction, nonce))
    };
}

function createProductionActorStore(): MemoryActorStore<ProductionMemoryState> {
    return new MemoryActorStore<ProductionMemoryState>(
        {
            authority: createProductionMemoryControl().snapshot(),
            permits: new MemoryAuthorityPermitStore(tenantActor).snapshot(),
            records: new MemoryProtocolRecords(),
            nextId: 0
        },
        cloneProductionMemoryState
    );
}

function nextProductionMemoryId(state: ProductionMemoryState): number {
    state.nextId += 1;
    return state.nextId;
}

function checkEvidenceWith(init: {
    readonly requestDigest: Digest;
    readonly issuer?: ActorRef;
    readonly checkedAt?: Date;
    readonly issuerTenant?: TenantId;
    readonly pathEpochs?: PathEpochEvidence;
}): AuthorityCheckEvidence {
    return new AuthorityCheckEvidence(
        init.issuerTenant ?? tenant,
        init.issuer ?? tenantActor,
        init.requestDigest,
        binding.key,
        binding.generation,
        "allow",
        "allowed",
        [grant],
        [],
        init.pathEpochs ?? currentPath(1),
        init.checkedAt ?? now
    );
}

interface MemoryAuthorityState {
    records: MemoryProtocolRecords;
    nextId: number;
    fence: number;
    principal: PrincipalId;
    epoch: number;
    permits: Record<string, Uint8Array>;
    checks: number;
}

type AuthorityBackend = TenantAuthorityCommandBackend<MemoryAuthorityState, AuthorityCommandRead>;

function createMemoryHarness(
    overrides: Partial<AuthorityBackend> = {},
    clock: Date | "wall" = now
): AuthorityCommandHarness {
    const store = new MemoryActorStore<MemoryAuthorityState>(
        {
            records: new MemoryProtocolRecords(),
            nextId: 0,
            fence: 7,
            principal: principal.principalId,
            epoch: 1,
            permits: {},
            checks: 0
        },
        cloneMemoryState
    );
    let failWrite = false;
    const persistence = new FailingProtocolPersistence(
        new MemoryProtocolPersistence<MemoryAuthorityState>((state) => state.records),
        () => failWrite
    );
    const backend = memoryBackend(overrides);
    const composition = createComposition(
        store,
        persistence,
        backend,
        (transaction) => nextMemoryId(transaction),
        clock
    );

    return createHarness(
        composition,
        () => readMemory(store),
        (epoch) => store.transaction((state) => (state.epoch = epoch)),
        (fail) => (failWrite = fail),
        () => {
            const state = store.snapshot().state;
            const protocol = state.records.snapshot();
            return {
                writes: protocol.writes.length,
                audits: protocol.audits.length,
                permits: Object.keys(state.permits).length,
                checks: state.checks
            };
        }
    );
}

function memoryBackend(overrides: Partial<AuthorityBackend> = {}): AuthorityBackend {
    const {
        projectLeaseEvidence = (_state: MemoryAuthorityState, evidence: TargetLeaseEvidence) =>
            evidence,
        ...remaining
    } = overrides;
    return {
        ...readBackend,
        validateBinding: (_state, request, at) => validationEvidence(request, at),
        check: (state, request, at) => {
            state.checks += 1;
            return checkEvidence(request, currentPath(state.epoch), at);
        },
        issuePermit: (state, request, at) => {
            const evidence = checkEvidence(
                request.targetRequest.authority,
                currentPath(state.epoch),
                at
            );
            if (!evidence.allowed) return AuthorityPermitIssuanceReply.denied(evidence);
            if (state.permits[request.targetRequest.nonce] !== undefined) throw duplicatePermit();
            const permit = permitFor(request, at);
            state.permits[request.targetRequest.nonce] = AuthorityPermit.encode(permit);
            return AuthorityPermitIssuanceReply.issued(evidence, permit);
        },
        ...remaining,
        projectLeaseEvidence
    };
}

const CREATE_SQLITE_STATE = `CREATE TABLE authority_command_test_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    fence INTEGER NOT NULL,
    principal TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    checks INTEGER NOT NULL
) STRICT`;

function createSqliteHarness(): AuthorityCommandHarness {
    const database = new TestSqlite();
    database.transaction(() => {
        database.run(CREATE_SQLITE_STATE, []);
        database.run("INSERT INTO authority_command_test_state VALUES (1, 7, ?, 1, 0)", [
            principal.principalId.value
        ]);
        database.run(
            "CREATE TABLE authority_command_test_ids (singleton INTEGER PRIMARY KEY, next_id INTEGER NOT NULL) STRICT",
            []
        );
        database.run("INSERT INTO authority_command_test_ids VALUES (1, 0)", []);
    });
    const permitStore = new SqliteAuthorityPermitStore(database, tenantActor);
    let failWrite = false;
    const persistence = new FailingProtocolPersistence(
        new SqliteProtocolPersistence(database),
        () => failWrite
    );
    const backend = sqliteBackend(permitStore);
    const composition = createComposition(
        new SqliteActorStore(database),
        persistence,
        backend,
        nextSqliteId
    );

    return createHarness(
        composition,
        () => readSqlite(database),
        (epoch) =>
            database.transaction(() =>
                database.run(
                    "UPDATE authority_command_test_state SET epoch = ? WHERE singleton = 1",
                    [epoch]
                )
            ),
        (fail) => (failWrite = fail),
        () => ({
            writes: count(database, "protocol_write_records"),
            audits: count(database, "protocol_audit_records"),
            permits: count(database, "authority_permit_nonces"),
            checks: integer(database, "SELECT checks AS value FROM authority_command_test_state")
        })
    );
}

interface ProductionMemoryState {
    authority: MemoryTenantControlSnapshot;
    permits: MemoryAuthorityPermitSnapshot;
    records: MemoryProtocolRecords;
    nextId: number;
}

class ProductionCommandState extends TenantAuthorityCommandStatePort<AuthorityCommandRead> {
    public actorFence(read: AuthorityCommandRead, actor: ActorRef): number | undefined {
        return actor.equals(sourceActor) ? read.fence : undefined;
    }

    public checkPrincipal(
        read: AuthorityCommandRead,
        _request: AuthorityCheckRequest
    ): PrincipalRef {
        return read.principal;
    }

    public currentCheckLease(): undefined {
        return undefined;
    }

    public currentPermitLease(): undefined {
        return undefined;
    }
}

const productionCommandState = new ProductionCommandState();

const productionAnchor = {
    actorId: tenantActor.id,
    tenantId: tenant,
    principalId: principal.principalId,
    tenantKind: "personal" as const,
    trustAnchor: Uint8Array.of(1, 2, 3)
};

function createProductionMemoryControl(): MemoryTenantControlStore {
    const control = MemoryTenantControlStore.create(productionAnchor);
    control.bootstrapTenant(productionAnchor, Revision.initial());
    installProductionAuthority(control);
    return control;
}

function installProductionAuthority(control: AuthorityMutationStore): void {
    const service = new AuthorityMutationService(control);
    service.createWorkspace(
        new Workspace(
            new WorkspaceId("authority-command-workspace"),
            tenant,
            undefined,
            Revision.initial()
        )
    );
    service.createGrant(
        new Grant(
            grant,
            workspaceScope,
            SubjectRef.principal(principal),
            "allow",
            new CapabilitySpec({
                facetPattern: facet.value,
                operations: ["send"],
                impacts: ["externalSend"],
                argumentConstraints: { channel: "internal" }
            }),
            { kind: "direct" }
        )
    );
    service.createBinding(binding);
}

function productionPath(control: AuthorityMutationStore): PathEpochEvidence {
    return new PathEpochEvidence([
        control.epoch(ScopeRef.tenant(tenant)),
        control.epoch(workspaceScope)
    ]);
}

function readProductionMemoryControl(
    actors: MemoryActorStore<ProductionMemoryState>
): MemoryTenantControlStore {
    return MemoryTenantControlStore.restore(actors.snapshot().state.authority);
}

function cloneProductionMemoryState(state: ProductionMemoryState): ProductionMemoryState {
    return {
        authority: MemoryTenantControlStore.restore(state.authority).snapshot(),
        permits: new MemoryAuthorityPermitStore(tenantActor, state.permits).snapshot(),
        records: state.records.clone(),
        nextId: state.nextId
    };
}

function initializeProductionSqliteState(database: TransactionalSqlite): void {
    database.transaction(() => {
        database.run(CREATE_SQLITE_STATE, []);
        database.run("INSERT INTO authority_command_test_state VALUES (1, 7, ?, 1, 0)", [
            principal.principalId.value
        ]);
        database.run(
            "CREATE TABLE authority_command_test_ids (singleton INTEGER PRIMARY KEY, next_id INTEGER NOT NULL) STRICT",
            []
        );
        database.run("INSERT INTO authority_command_test_ids VALUES (1, 0)", []);
    });
}

function dispatchProductionPermit<Transaction, ReadTransaction>(
    composition: ClosedTenantAuthorityComposition<
        Transaction,
        AuthorityCommandRead,
        ReadTransaction,
        CommandCaller
    >,
    request: AuthorityPermitIssuanceRequest,
    caller: CommandCaller
): Promise<CommandDispatchResult> {
    const payload = AuthorityPermitIssuanceRequest.encode(request);
    const raw = envelope(
        TENANT_AUTHORITY_COMMANDS.issuePermit,
        request.targetRequest.nonce,
        payload,
        caller
    );
    return composition.dispatch(raw, caller, payload);
}

function createProductionMemoryHarness(): ProductionPermitHarness {
    const control = createProductionMemoryControl();
    let failWrite = false;
    let actorStore = new MemoryActorStore<ProductionMemoryState>(
        {
            authority: control.snapshot(),
            permits: new MemoryAuthorityPermitStore(tenantActor).snapshot(),
            records: new MemoryProtocolRecords(),
            nextId: 0
        },
        cloneProductionMemoryState
    );
    let tenantStore = createProductionMemoryStore(actorStore);
    let composition = createProductionMemoryComposition(tenantStore, () => failWrite);
    let targetStore = new MemoryAuthorityPermitStore(targetActor);

    const rebuild = (): void => {
        actorStore = MemoryActorStore.restore(actorStore.snapshot(), cloneProductionMemoryState);
        tenantStore = createProductionMemoryStore(actorStore);
        composition = createProductionMemoryComposition(tenantStore, () => failWrite);
    };

    return {
        currentPath: () => productionPath(readProductionMemoryControl(actorStore)),
        persistTarget: (request) => {
            targetStore.transaction((transaction) =>
                targetStore.request(transaction, request.targetRequest)
            );
            targetStore = new MemoryAuthorityPermitStore(targetActor, targetStore.snapshot());
            const persisted = targetStore.transaction((transaction) =>
                targetStore.requested(transaction, request.targetRequest.nonce)
            );
            if (persisted === undefined)
                throw new TypeError("Target request did not survive restart");
            return new AuthorityPermitIssuanceRequest(persisted);
        },
        dispatch: (request, caller = { kind: "actor", actor: targetActor }) =>
            dispatchProductionPermit(composition, request, caller),
        revokeAndRestartTenant: () => {
            tenantStore.transaction((state) => {
                const current = MemoryTenantControlStore.restore(state.authority);
                new AuthorityMutationService(current).revokeGrant(grant);
                state.authority = current.snapshot();
            });
            rebuild();
        },
        restartTenant: rebuild,
        failEvidenceAppend: (fail) => (failWrite = fail),
        issued: (nonce) =>
            tenantStore.transaction((transaction) => tenantStore.issued(transaction, nonce)),
        writes: () => actorStore.snapshot().state.records.snapshot().writes.length
    };
}

function createProductionSqliteHarness(): ProductionPermitHarness {
    const database = new TestSqlite();
    let failWrite = false;
    let control = createSqliteTenantControlStore(database, productionAnchor);
    database.transaction(() =>
        control.bootstrapTenant(database, productionAnchor, Revision.initial())
    );
    installProductionAuthority(control);
    initializeProductionSqliteState(database);
    let tenantStore = new SqliteTenantAuthorityPermitStore(database, tenantActor);
    let composition = createProductionSqliteComposition(tenantStore, database, () => failWrite);
    const targetDatabase = new TestSqlite();
    let targetStore = new SqliteAuthorityPermitStore(targetDatabase, targetActor);

    const rebuild = (): void => {
        control = createSqliteTenantControlStore(database);
        tenantStore = new SqliteTenantAuthorityPermitStore(database, tenantActor);
        composition = createProductionSqliteComposition(tenantStore, database, () => failWrite);
    };

    return {
        currentPath: () => productionPath(control),
        persistTarget: (request) => {
            targetStore.transaction((transaction) =>
                targetStore.request(transaction, request.targetRequest)
            );
            targetStore = new SqliteAuthorityPermitStore(targetDatabase, targetActor);
            const persisted = targetStore.transaction((transaction) =>
                targetStore.requested(transaction, request.targetRequest.nonce)
            );
            if (persisted === undefined)
                throw new TypeError("Target request did not survive restart");
            return new AuthorityPermitIssuanceRequest(persisted);
        },
        dispatch: (request, caller = { kind: "actor", actor: targetActor }) =>
            dispatchProductionPermit(composition, request, caller),
        revokeAndRestartTenant: () => {
            new AuthorityMutationService(control).revokeGrant(grant);
            rebuild();
        },
        restartTenant: rebuild,
        failEvidenceAppend: (fail) => (failWrite = fail),
        issued: (nonce) =>
            tenantStore.transaction((transaction) => tenantStore.issued(transaction, nonce)),
        writes: () => count(database, "protocol_write_records")
    };
}

function createProductionMemoryStore(
    actorStore: MemoryActorStore<ProductionMemoryState>
): MemoryTenantAuthorityPermitStore<ProductionMemoryState> {
    return new MemoryTenantAuthorityPermitStore(actorStore, tenantActor, {
        authority: (state) => state.authority,
        permits: (state) => state.permits,
        savePermits: (state, permits) => (state.permits = permits)
    });
}

function createProductionMemoryComposition(
    store: MemoryTenantAuthorityPermitStore<ProductionMemoryState>,
    failWrite: () => boolean
) {
    return createComposition(
        store,
        new FailingProtocolPersistence(
            new MemoryProtocolPersistence<ProductionMemoryState>((state) => state.records),
            failWrite
        ),
        new TenantAuthorityRuntimeCommandBackend(productionCommandState, store, tenantActor),
        (state) => {
            state.nextId += 1;
            return state.nextId;
        }
    );
}

function createProductionSqliteComposition(
    store: SqliteTenantAuthorityPermitStore,
    database: TransactionalSqlite,
    failWrite: () => boolean
) {
    return createComposition(
        store,
        new FailingProtocolPersistence(new SqliteProtocolPersistence(database), failWrite),
        new TenantAuthorityRuntimeCommandBackend(productionCommandState, store, tenantActor),
        nextSqliteId
    );
}

function sqliteBackend(
    permitStore: SqliteAuthorityPermitStore
): TenantAuthorityCommandBackend<TransactionalSqlite, AuthorityCommandRead> {
    return {
        ...readBackend,
        validateBinding: (_database, request, at) => validationEvidence(request, at),
        check: (database, request, at) => {
            database.run(
                "UPDATE authority_command_test_state SET checks = checks + 1 WHERE singleton = 1",
                []
            );
            return checkEvidence(request, readSqlite(database).path, at);
        },
        projectLeaseEvidence: (database, evidence) => {
            permitStore.projectEvidence(database, evidence);
            return evidence;
        },
        issuePermit: (database, request, at) => {
            const evidence = checkEvidence(
                request.targetRequest.authority,
                readSqlite(database).path,
                at
            );
            if (!evidence.allowed) return AuthorityPermitIssuanceReply.denied(evidence);
            const permit = permitFor(request, at);
            permitStore.issue(database, permit);
            return AuthorityPermitIssuanceReply.issued(evidence, permit);
        }
    };
}

const readBackend = {
    actorFence: (read: AuthorityCommandRead, actor: ActorRef) =>
        actor.equals(sourceActor) ? read.fence : actor.equals(targetActor) ? 3 : undefined,
    checkPrincipal: (read: AuthorityCommandRead) => read.principal,
    currentCheckLease: (
        _read: AuthorityCommandRead,
        _request: AuthorityCheckRequest,
        at: Date
    ) => ({
        turn: authorityTurn,
        holder: principal,
        epoch: 2,
        expiresAt: new Date(at.getTime() + 5_000)
    }),
    currentPermitLease: (
        _read: AuthorityCommandRead,
        request: AuthorityPermitIssuanceRequest,
        at: Date
    ) => ({
        turn: request.targetRequest.expectation.lease!.turn,
        holder: principal,
        epoch: request.targetRequest.expectation.lease!.epoch,
        expiresAt: new Date(at.getTime() + 5_000)
    })
};

function createComposition<Transaction, ReadTransaction extends AuthorityReadTransaction>(
    store: ActorLocalStore<Transaction, ReadTransaction>,
    persistence: ProtocolPersistence<Transaction>,
    backend: TenantAuthorityCommandBackend<Transaction, AuthorityCommandRead>,
    nextId: (transaction: Transaction) => number,
    clock: Date | "wall" = now
): ClosedTenantAuthorityComposition<
    Transaction,
    AuthorityCommandRead,
    ReadTransaction,
    CommandCaller
> {
    const init: Assembled<
        ClosedTenantAuthorityCompositionInit<
            Transaction,
            AuthorityCommandRead,
            ReadTransaction,
            CommandCaller
        >
    > = {
        store,
        persistence,
        backend,
        ids: {
            writeRecordId: (transaction) =>
                new WriteRecordId(`authority-write-${nextId(transaction)}`),
            auditRecordId: (transaction) =>
                new AuditRecordId(`authority-audit-${nextId(transaction)}`),
            invocationId: (transaction) =>
                new InvocationId(`authority-invocation-${nextId(transaction)}`),
            correlationId: (transaction) =>
                new CorrelationId(`authority-correlation-${nextId(transaction)}`)
        },
        actor: tenantActor,
        tenant,
        readOnly: (transaction) => readTransaction(transaction),
        limits: { envelopeBytes: 32_768, payloadBytes: 32_768 },
        content: new CounterContentStore(() => undefined),
        authenticator: new CounterAuthenticator(tenant),
        leaseForMilliseconds: 60_000
    };
    if (clock !== "wall") init.now = () => clock;
    return createClosedTenantAuthorityComposition(init);
}

/** The read transactions composed by the mock and production harnesses. */
type AuthorityReadTransaction = ReadableSqlite | MemoryAuthorityState | ProductionMemoryState;

function readTransaction(transaction: AuthorityReadTransaction): AuthorityCommandRead {
    if (transaction instanceof ReadableSqlite) return readSqlite(transaction);
    if ("authority" in transaction) {
        const control = MemoryTenantControlStore.restore(transaction.authority);
        return Object.freeze({
            fence: 7,
            principal,
            path: productionPath(control)
        });
    }
    return readMemoryState(transaction);
}

function createHarness<Transaction, ReadTransaction>(
    composition: ClosedTenantAuthorityComposition<
        Transaction,
        AuthorityCommandRead,
        ReadTransaction,
        CommandCaller
    >,
    read: () => AuthorityCommandRead,
    setEpoch: (epoch: number) => void,
    failEvidenceAppend: (fail: boolean) => void,
    snapshot: () => AuthorityCommandSnapshot
): AuthorityCommandHarness {
    const caller: CommandCaller = { kind: "actor", actor: sourceActor };
    const targetCaller: CommandCaller = { kind: "actor", actor: targetActor };
    return {
        caller,
        bindingRequest: () => bindingRequest(),
        checkRequest: (path = read().path, selectedPrincipal = principal) =>
            checkRequest(path, selectedPrincipal),
        permitRequest: (path = read().path) => permitRequest(path),
        envelope: (command, key, payload, selectedCaller, lease) =>
            envelope(
                command,
                key,
                payload,
                selectedCaller ??
                    (command === TENANT_AUTHORITY_COMMANDS.issuePermit ? targetCaller : caller),
                lease
            ),
        dispatch: (raw, payload, transport) =>
            composition.dispatch(raw, transport ?? submittedCaller(raw, caller), payload),
        setEpoch,
        failEvidenceAppend,
        snapshot
    };
}

function submittedCaller(raw: Uint8Array, fallback: CommandCaller): CommandCaller {
    try {
        return CommandEnvelopeCodec.decode(raw).caller;
    } catch {
        return fallback;
    }
}

class FailingProtocolPersistence<Transaction> implements ProtocolPersistence<Transaction> {
    public constructor(
        private readonly delegate: ProtocolPersistence<Transaction>,
        private readonly failWrite: () => boolean
    ) {}

    public repair(transaction: Transaction): void {
        this.delegate.repair?.(transaction);
    }

    public findWrite(transaction: Transaction, identity: CommandIdentity) {
        return this.delegate.findWrite(transaction, identity);
    }

    public findAudit(transaction: Transaction, id: AuditRecordId) {
        return this.delegate.findAudit(transaction, id);
    }

    public appendAudit(...args: Parameters<ProtocolPersistence<Transaction>["appendAudit"]>): void {
        this.delegate.appendAudit(...args);
    }

    public appendWrite(...args: Parameters<ProtocolPersistence<Transaction>["appendWrite"]>): void {
        if (this.failWrite()) throw new TypeError("Injected authority evidence append failure");
        this.delegate.appendWrite(...args);
    }
}

function bindingRequest(
    overrides: Partial<ConstructorParameters<typeof BindingValidationRequest>[0]> = {}
): BindingValidationRequest {
    return new BindingValidationRequest({
        ownerTenant: tenant,
        workspaceActor: sourceActor,
        workspaceFence: 7,
        scope: workspaceScope,
        domain,
        name: bindingName,
        grantId: grant,
        facet,
        nonce: "binding-validation",
        ...overrides
    });
}

function checkRequest(
    path: PathEpochEvidence,
    selectedPrincipal: PrincipalRef,
    overrides: Partial<ConstructorParameters<typeof AuthorityCheckRequest>[0]> = {}
): AuthorityCheckRequest {
    const argumentsValue = { channel: "internal" } as const;
    return new AuthorityCheckRequest({
        ownerTenant: tenant,
        owner: sourceActor,
        ownerFence: 7,
        principal: selectedPrincipal,
        binding,
        intent: {
            facet,
            operation: "send",
            impact: "externalSend",
            arguments: argumentsValue,
            argumentsDigest: Digest.sha256(encodeCanonicalJson(argumentsValue))
        },
        expectedPath: path,
        invocationDigest: digest("authority-command-invocation"),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: "authority-check",
        ...overrides
    });
}

function permitRequest(
    path: PathEpochEvidence,
    lease?: AuthorityPermitExpectation["lease"],
    overrides: Partial<ConstructorParameters<typeof AuthorityPermitExpectation>[0]> = {},
    argumentsValue: Readonly<{ channel: "internal" | "external" }> = {
        channel: "internal"
    },
    nonce = "authority-command-permit"
): AuthorityPermitIssuanceRequest {
    const argumentsDigest = Digest.sha256(encodeCanonicalJson(argumentsValue));
    const invocation = new AuthorityInvocationId("authority-command-permit-invocation");
    const itemKey = "authority-command-item";
    const expectationInit: Assembled<AuthorityPermitExpectationInit> = {
        tenant,
        issuer: tenantActor,
        source: sourceActor,
        target: { actor: targetActor, fence: 3, domain },
        principal,
        binding: { name: bindingName, generation: new Revision(binding.generation) },
        facet,
        operation: new OperationRef("workspace:send"),
        package: new PackagePin(
            new PackageId("authority-command-package"),
            new SemVer("1.0.0"),
            digest("authority-command-manifest"),
            digest("authority-command-code")
        ),
        impact: "externalSend",
        invocation,
        reservation: {
            run: new RunId("authority-command-run"),
            registryEpoch: 2,
            obligation: { kind: "invocationItem", invocation, itemIndex: 0, itemKey }
        },
        itemIndex: 0,
        attemptOrdinal: 0,
        claim: new ItemClaimId("authority-command-claim"),
        claimOwner: {
            kind: "system",
            actor: targetActor,
            worker: new ClaimWorkerId("authority-command-worker")
        },
        itemKey,
        argumentsDigest,
        intentDigest: digest("authority-command-intent"),
        pathEpochs: path,
        authority: { kind: "initiator", principal, binding: bindingName },
        ...overrides
    };
    if (lease !== undefined) expectationInit.lease = lease;
    const expectation = new AuthorityPermitExpectation(expectationInit);
    const authorityBinding = new Binding(
        expectation.pathEpochs.target.scope,
        SubjectRef.principal(expectation.principal),
        expectation.target.domain,
        expectation.binding.name,
        grant,
        expectation.facet,
        expectation.binding.generation.value,
        "active",
        new Revision(expectation.binding.generation.value)
    );
    const authority = new AuthorityCheckRequest({
        ownerTenant: expectation.tenant,
        owner: expectation.target.actor,
        ownerFence: expectation.target.fence,
        principal: expectation.principal,
        binding: authorityBinding,
        intent: {
            facet: expectation.facet,
            operation: expectation.operation.operation.value,
            impact: expectation.impact,
            arguments: argumentsValue,
            argumentsDigest
        },
        expectedPath: expectation.pathEpochs,
        invocationDigest: expectation.intentDigest,
        itemIndex: expectation.itemIndex,
        attemptOrdinal: expectation.attemptOrdinal,
        nonce
    });
    return new AuthorityPermitIssuanceRequest(
        new TargetAuthorityPermitRequest(
            expectation,
            authority,
            nonce,
            new Date(now.getTime() + 5_000)
        )
    );
}

function projectedPermitRequest(
    path: PathEpochEvidence,
    lease: NonNullable<AuthorityPermitExpectationInit["lease"]>
) {
    const provisional = permitRequest(path, lease).targetRequest;
    const sourceEvidence = new TargetLeaseEvidence({
        key: new TargetLeaseEvidenceKey(provisional.expectation.source, provisional.nonce),
        tenant: provisional.expectation.tenant,
        run: provisional.expectation.reservation.run,
        lease,
        target: provisional.expectation.target,
        requestIdentity: provisional.identity(),
        deadline: provisional.expiresAt,
        watermark: InvalidationWatermark.empty(
            provisional.expectation.tenant,
            provisional.expectation.source,
            lease.holder
        )
    });
    const request = new TargetAuthorityPermitRequest(
        provisional.expectation,
        provisional.authority,
        provisional.nonce,
        provisional.expiresAt,
        sourceEvidence.reference()
    );
    return Object.freeze({
        evidence: sourceEvidence,
        request: new AuthorityPermitIssuanceRequest(request)
    });
}

function validationEvidence(
    request: BindingValidationRequest,
    at: Date
): BindingValidationEvidence {
    return new BindingValidationEvidence(
        tenant,
        tenantActor,
        request.digest(),
        workspaceScope,
        binding.subject,
        grant,
        currentPath(1),
        at
    );
}

function checkEvidence(
    request: AuthorityCheckRequest,
    path: PathEpochEvidence,
    at: Date
): AuthorityCheckEvidence {
    const stale = !request.expectedPath.equals(path);
    return new AuthorityCheckEvidence(
        tenant,
        tenantActor,
        request.digest(),
        binding.key,
        binding.generation,
        stale ? "deny" : "allow",
        stale ? "stalePath" : "allowed",
        stale ? [] : [grant],
        [],
        path,
        at
    );
}

function permitFor(request: AuthorityPermitIssuanceRequest, at: Date): AuthorityPermit {
    return new AuthorityPermit({
        ...request.targetRequest.expectation,
        nonce: request.targetRequest.nonce,
        requestDigest: request.targetRequest.digest(),
        issuedAt: at,
        expiresAt: request.targetRequest.expiresAt
    });
}

function issuedReply(
    request: AuthorityPermitIssuanceRequest,
    permit: AuthorityPermit,
    at: Date
): AuthorityPermitIssuanceReply {
    return AuthorityPermitIssuanceReply.issued(
        checkEvidence(
            request.targetRequest.authority,
            request.targetRequest.authority.expectedPath,
            at
        ),
        permit
    );
}

function envelope(
    command: string,
    key: string,
    payload: Uint8Array,
    caller: CommandCaller,
    lease?: NonNullable<CommandEnvelope["lease"]>,
    expectedRevision?: Revision
): Uint8Array {
    const payloadDigest = Digest.sha256(payload);
    const envelopeInit: Assembled<CommandEnvelopeInit> = {
        command,
        caller,
        idempotencyKey: key,
        payload: ContentRef.fromDigest(payloadDigest),
        payloadDigest
    };
    if (lease !== undefined) envelopeInit.lease = lease;
    if (expectedRevision !== undefined) envelopeInit.expectedRevision = expectedRevision;
    return CommandEnvelopeCodec.encode(new CommandEnvelope(envelopeInit));
}

function currentPath(epoch: number): PathEpochEvidence {
    return new PathEpochEvidence([
        ScopeEpoch.initial(ScopeRef.tenant(tenant)),
        new ScopeEpoch(workspaceScope, epoch)
    ]);
}

function readMemory(store: MemoryActorStore<MemoryAuthorityState>): AuthorityCommandRead {
    return readMemoryState(store.snapshot().state);
}

function readMemoryState(state: MemoryAuthorityState): AuthorityCommandRead {
    return Object.freeze({
        fence: state.fence,
        principal: new PrincipalRef(tenant, state.principal),
        path: currentPath(state.epoch)
    });
}

function cloneMemoryState(state: MemoryAuthorityState): MemoryAuthorityState {
    return {
        ...state,
        records: state.records.clone(),
        principal: new PrincipalId(state.principal.value),
        permits: Object.fromEntries(
            Object.entries(state.permits).map(([nonce, bytes]) => [nonce, bytes.slice()])
        )
    };
}

function readSqlite(database: ReadableSqlite): AuthorityCommandRead {
    const row = database.all(
        "SELECT * FROM authority_command_test_state WHERE singleton = 1",
        []
    )[0]!;
    return Object.freeze({
        fence: integerColumn(row["fence"]),
        principal: new PrincipalRef(tenant, new PrincipalId(text(row["principal"]))),
        path: currentPath(integerColumn(row["epoch"]))
    });
}

function nextMemoryId(state: MemoryAuthorityState): number {
    state.nextId += 1;
    return state.nextId;
}

function nextSqliteId(database: TransactionalSqlite): number {
    database.run(
        "UPDATE authority_command_test_ids SET next_id = next_id + 1 WHERE singleton = 1",
        []
    );
    return integer(database, "SELECT next_id AS value FROM authority_command_test_ids");
}

function count(database: ReadableSqlite, table: string): number {
    return integer(database, `SELECT COUNT(*) AS value FROM ${table}`);
}

function integer(database: ReadableSqlite, statement: string): number {
    return integerColumn(database.all(statement, [])[0]?.["value"]);
}

function integerColumn(value: SqliteValue | undefined): number {
    return recordData.safeInteger(scalar(value), "SQLite integer column");
}

function text(value: SqliteValue | undefined): string {
    return recordData.string(scalar(value), "SQLite text column");
}

/** A scalar SQLite column, as the JSON value it decodes to. */
function scalar(value: SqliteValue | undefined): JsonValue | undefined {
    if (value instanceof Uint8Array) throw new TypeError("Expected a scalar SQLite column");
    return value;
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

function duplicatePermit(): AgentCoreError {
    return new AgentCoreError("authority.denied", "Authority permit nonce was already issued");
}
