import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { RunAdmissionRegistry, RunId, type RunRepository } from "../../src/agents";
import {
    AuthorityPermit,
    AuthorityPermitAdmissionPort,
    AuthorityPermitAuthenticator,
    AuthorityPermitExpectation,
    AuthorityPermitIssuedRecordSource,
    MemoryTenantControlStore,
    PathEpochEvidence,
    ScopeEpoch,
    subjectKey,
    type AuthenticatedAuthorityPermit
} from "../../src/authority";
import {
    ConsumedAuthorityAdmissionPort,
    DeviceConsentFinalAdmissionPort,
    TargetAuthorityPermitAuthenticationPort,
    TenantMultiplicityPolicy,
    assembleSingleTenantPolicy,
    ApprovalGatewayReconciliationPort,
    DurableRunAdmissionPort,
    type AuthorityPermitDenialPort,
    type AuthorityPermitExpectationFactory,
    type AuthorityPermitReference
} from "../../src/composition";
import { ContentRef, Digest, JsonSchema, Revision, SemVer, type JsonValue } from "../../src/core";
import { ContentStore, type ContentPutResult } from "../../src/content";
import { PackageId, PackagePin } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import {
    ApprovalGatewayBackend,
    BindingName,
    DeviceConsentBackend,
    DeviceError,
    EffectDispatch,
    FacetRef,
    Operation,
    OperationDescriptor,
    OperationName,
    OperationRef,
    ProtectionDomain,
    type ApprovalGatewayReconciliationResult,
    type DeviceAgentBinding,
    type FacetData,
    type Impact,
    type OperationContext,
    type ProtectedOperationRequest
} from "../../src/facets";
import { PrincipalId, PrincipalRef, ScopeRef, TenantId, WorkspaceId } from "../../src/identity";
import { AuditRecordId, InvocationId } from "../../src/interaction-references";
import { ClaimWorkerId, EffectAttemptId, ItemClaimId } from "../../src/invocation-references";
import {
    AuthorityAdmissionReference,
    EffectAttempt,
    type AuthorityAdmissionContext,
    type CanonicalBatchInvocationRequest
} from "../../src/invocations";
import { OperationRequestKey } from "../../src/operations";
import { forwarded, reaching } from "./fixture";

const tenant = new TenantId("ports-tenant");
const tenantActor = new ActorRef("tenant", new ActorId("ports-tenant"));
const sourceActor = new ActorRef("workspace", new ActorId("ports-source"));
const targetActor = new ActorRef("run", new ActorId("ports-target"));
const principal = new PrincipalRef(tenant, new PrincipalId("ports-principal"));
const workspaceScope = ScopeRef.workspace(tenant, new WorkspaceId("ports-workspace"));
const facet = new FacetRef("workspace:ports");
const bindingName = new BindingName("ports");
const domain = new ProtectionDomain("backend", "ports-domain", "may-hold-secrets");
const invocation = new InvocationId("ports-invocation");
const itemKey = "ports-item";
const pathEpochs = new PathEpochEvidence([
    ScopeEpoch.initial(ScopeRef.tenant(tenant)),
    ScopeEpoch.initial(workspaceScope)
]);
const ISSUED_AT = new Date(1_000);
const EXPIRES_AT = new Date(6_000);

function digestOf(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}

const expectation = new AuthorityPermitExpectation({
    tenant,
    issuer: tenantActor,
    source: sourceActor,
    target: { actor: targetActor, fence: 3, domain },
    principal,
    binding: { name: bindingName, generation: Revision.initial() },
    facet,
    operation: new OperationRef("ports:send"),
    package: new PackagePin(
        new PackageId("ports-package"),
        new SemVer("1.0.0"),
        digestOf("ports-manifest"),
        digestOf("ports-code")
    ),
    impact: "externalSend",
    invocation,
    reservation: {
        run: new RunId("ports-run"),
        registryEpoch: 2,
        obligation: { kind: "invocationItem", invocation, itemIndex: 0, itemKey }
    },
    itemIndex: 0,
    attemptOrdinal: 0,
    claim: new ItemClaimId("ports-claim"),
    claimOwner: {
        kind: "system",
        actor: targetActor,
        worker: new ClaimWorkerId("ports-worker")
    },
    itemKey,
    argumentsDigest: digestOf("ports-arguments"),
    intentDigest: digestOf("ports-intent"),
    pathEpochs,
    authority: { kind: "initiator", principal, binding: bindingName }
});
const permit = new AuthorityPermit({
    ...expectation,
    nonce: "ports-permit",
    requestDigest: digestOf("ports-permit-request"),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT
});
const otherExpectation = new AuthorityPermitExpectation({ ...expectation, attemptOrdinal: 1 });

class IssuedPermitRecords extends AuthorityPermitIssuedRecordSource {
    public async issued(): Promise<Uint8Array | undefined> {
        return AuthorityPermit.encode(permit);
    }
}

class FixedExpectations implements AuthorityPermitExpectationFactory<
    object,
    string,
    string,
    string,
    string
> {
    public constructor(
        private readonly claimExpectation: AuthorityPermitExpectation,
        private readonly admissionExpectation: AuthorityPermitExpectation | undefined
    ) {}

    public forClaim(): AuthorityPermitExpectation {
        return this.claimExpectation;
    }

    public forAdmission(): AuthorityPermitExpectation | undefined {
        return this.admissionExpectation;
    }
}

class RecordingDenial<Transaction = object> implements AuthorityPermitDenialPort<Transaction> {
    public readonly denials: (AuthorityPermitExpectation | undefined)[] = [];

    public deny(_transaction: Transaction, value: AuthorityPermitExpectation | undefined): void {
        this.denials.push(value);
    }
}

class ScriptedAdmission extends AuthorityPermitAdmissionPort<object> {
    public consumed = 0;
    public failure: unknown;

    public consume(): void {
        this.consumed += 1;
        if (this.failure !== undefined) throw this.failure;
    }
}

const admissionContext: AuthorityAdmissionContext<string, string, string, string> = {
    invocation,
    itemIndex: 0,
    ordinal: 0,
    lease: undefined,
    authority: "ports-authority",
    domain: "ports-domain",
    pathEpochs: "ports-path",
    intentDigest: digestOf("ports-intent"),
    itemKey
};

/** Runs an action that must be refused and hands back the refusal it threw. */
async function captured<Result>(action: () => Promise<Result>): Promise<AgentCoreError> {
    try {
        await action();
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw new TypeError(`Expected an AgentCoreError, caught ${String(error)}`, {
            cause: error
        });
    }
    throw new TypeError("Expected the action to be refused");
}

describe("authority permit composition ports", () => {
    test(
        "target permit authentication refuses malformed replies and digest substitution",
        { tags: "p0" },
        async () => {
            const port = new TargetAuthorityPermitAuthenticationPort<
                object,
                string,
                string,
                string,
                string
            >(
                new AuthorityPermitAuthenticator(new IssuedPermitRecords()),
                new FixedExpectations(expectation, expectation)
            );

            const malformed = await captured(() =>
                port.authenticate(
                    forwarded(),
                    forwarded(),
                    new AuthorityAdmissionReference<AuthorityPermitReference>(
                        { substituted: true },
                        permit.digest()
                    )
                )
            );
            expect(malformed).toBeInstanceOf(AgentCoreError);
            expect(malformed).toMatchObject({
                code: "authority.denied",
                message: "Authority permit reply is malformed"
            });

            const mismatched = await captured(() =>
                port.authenticate(
                    forwarded(),
                    forwarded(),
                    new AuthorityAdmissionReference<AuthorityPermitReference>(
                        permit.toData(),
                        digestOf("ports-substituted-digest")
                    )
                )
            );
            expect(mismatched).toBeInstanceOf(AgentCoreError);
            expect(mismatched).toMatchObject({
                code: "authority.denied",
                message: "Authority permit reply digest does not match its canonical record"
            });

            const authenticated = await port.authenticate(
                forwarded(),
                forwarded(),
                new AuthorityAdmissionReference<AuthorityPermitReference>(
                    permit.toData(),
                    permit.digest()
                )
            );
            expect(authenticated.matches(permit)).toBe(true);
        }
    );

    test(
        "consumed authority admission denies each missing admission precondition",
        { tags: "p0" },
        async () => {
            const authentication = await new AuthorityPermitAuthenticator(
                new IssuedPermitRecords()
            ).authenticate(permit, expectation);
            const reference = new AuthorityAdmissionReference<AuthorityPermitReference>(
                permit.toData(),
                permit.digest()
            );
            const cases: readonly {
                readonly reason: string;
                readonly expected?: AuthorityPermitExpectation | undefined;
                readonly admission?: AuthorityAdmissionReference<AuthorityPermitReference>;
                readonly authentication?: AuthenticatedAuthorityPermit | undefined;
                readonly consumed: number;
            }[] = [
                {
                    reason: "a malformed permit reference",
                    admission: new AuthorityAdmissionReference<AuthorityPermitReference>(
                        { substituted: true },
                        permit.digest()
                    ),
                    consumed: 0
                },
                { reason: "no target expectation", expected: undefined, consumed: 0 },
                { reason: "no authenticated permit", authentication: undefined, consumed: 0 },
                {
                    reason: "a substituted reply digest",
                    admission: new AuthorityAdmissionReference<AuthorityPermitReference>(
                        permit.toData(),
                        digestOf("ports-substituted-digest")
                    ),
                    consumed: 0
                }
            ];

            for (const entry of cases) {
                const denial = new RecordingDenial();
                const admission = new ScriptedAdmission();
                const expected = "expected" in entry ? entry.expected : expectation;
                const port = new ConsumedAuthorityAdmissionPort<
                    object,
                    string,
                    string,
                    string,
                    string
                >(admission, new FixedExpectations(expectation, expected), denial, () => ISSUED_AT);

                expect(
                    port.admits(
                        {},
                        entry.admission ?? reference,
                        admissionContext,
                        "authentication" in entry ? entry.authentication : authentication
                    ),
                    entry.reason
                ).toBe(false);
                expect(denial.denials, entry.reason).toEqual([expected]);
                expect(admission.consumed, entry.reason).toBe(entry.consumed);
            }
        }
    );

    test(
        "consumed authority admission converts denials and propagates other faults",
        { tags: "p0" },
        async () => {
            const authentication = await new AuthorityPermitAuthenticator(
                new IssuedPermitRecords()
            ).authenticate(permit, expectation);
            const reference = new AuthorityAdmissionReference<AuthorityPermitReference>(
                permit.toData(),
                permit.digest()
            );
            const build = () => {
                const denial = new RecordingDenial();
                const admission = new ScriptedAdmission();
                return {
                    port: new ConsumedAuthorityAdmissionPort(
                        admission,
                        new FixedExpectations(expectation, expectation),
                        denial,
                        () => ISSUED_AT
                    ),
                    admission,
                    denial
                };
            };

            const accepted = build();
            expect(accepted.port.admits({}, reference, admissionContext, authentication)).toBe(
                true
            );
            expect(accepted.admission.consumed).toBe(1);
            expect(accepted.denial.denials).toEqual([]);

            const denied = build();
            denied.admission.failure = new AgentCoreError(
                "authority.denied",
                "Authority permit nonce was already consumed"
            );
            expect(denied.port.admits({}, reference, admissionContext, authentication)).toBe(false);
            expect(denied.denial.denials).toEqual([expectation]);

            for (const failure of [
                new AgentCoreError("protocol.invalid-state", "permit store is unavailable"),
                new TypeError("permit store crashed")
            ]) {
                const propagated = build();
                propagated.admission.failure = failure;
                expect(() =>
                    propagated.port.admits({}, reference, admissionContext, authentication)
                ).toThrow(failure);
                expect(propagated.denial.denials).toEqual([]);
            }
        }
    );

    test(
        "target permit authentication binds the reply to the claim expectation",
        { tags: "p0" },
        async () => {
            const port = new TargetAuthorityPermitAuthenticationPort<
                object,
                string,
                string,
                string,
                string
            >(
                new AuthorityPermitAuthenticator(new IssuedPermitRecords()),
                new FixedExpectations(otherExpectation, otherExpectation)
            );

            const error = await captured(() =>
                port.authenticate(
                    forwarded(),
                    forwarded(),
                    new AuthorityAdmissionReference<AuthorityPermitReference>(
                        permit.toData(),
                        permit.digest()
                    )
                )
            );
            expect(error).toBeInstanceOf(AgentCoreError);
            expect(error).toMatchObject({
                code: "authority.denied",
                message: "Authority permit does not match the target expectation"
            });
        }
    );
});

const deviceFacet = new FacetRef("profile:device");
const otherFacet = new FacetRef("profile:other");
const deviceAgent = new PrincipalRef(tenant, new PrincipalId("ports-device-agent"));
const deviceSchema = new JsonSchema({});

class FixedDeviceAgent implements DeviceAgentBinding {
    public agent(): PrincipalRef {
        return deviceAgent;
    }
}

class ScriptedConsent extends DeviceConsentBackend<object> {
    public failure: unknown;
    public calls = 0;

    protected assertLive(): number {
        this.calls += 1;
        if (this.failure !== undefined) throw this.failure;
        return 5;
    }
}

class NoopOperation extends Operation {
    public readonly descriptor = new OperationDescriptor(
        new OperationName("noop"),
        "observe",
        deviceSchema,
        deviceSchema
    );

    public async execute(_context: OperationContext, _input: FacetData): Promise<FacetData> {
        return null;
    }
}

function deviceRequest(init: {
    readonly facet?: FacetRef;
    readonly operation: string;
    readonly impact: Impact;
    readonly inputs: readonly FacetData[];
}): CanonicalBatchInvocationRequest<ProtectedOperationRequest> {
    const target = init.facet ?? deviceFacet;
    const operation = new NoopOperation();
    return {
        invocation,
        request: {
            requestKey: new OperationRequestKey("ports-device-request"),
            facet: target,
            descriptor: new OperationDescriptor(
                new OperationName(init.operation),
                init.impact,
                deviceSchema,
                deviceSchema
            ),
            cardinality: { kind: "single" },
            inputs: init.inputs,
            authorization: {
                facet: target,
                binding: bindingName,
                operation,
                input: null,
                resultMode: "output"
            },
            interceptions: [],
            execute: async () => null
        }
    };
}

describe("device consent final admission", () => {
    test(
        "admits only the exact cached read or a consented live Device Operation",
        { tags: "p0" },
        () => {
            const consent = new ScriptedConsent();
            const port = new DeviceConsentFinalAdmissionPort<
                object,
                string,
                string,
                string,
                string,
                string
            >(deviceFacet, new FixedDeviceAgent(), consent);

            expect(
                port.admit(
                    {},
                    deviceRequest({
                        operation: "readCached",
                        impact: "observe",
                        inputs: [{ key: "last" }]
                    }),
                    forwarded()
                )
            ).toEqual({ kind: "admitted" });
            expect(consent.calls).toBe(0);

            const live = port.admit(
                {},
                deviceRequest({
                    operation: "camera",
                    impact: "externalSend",
                    inputs: [{ deviceId: "ports-device" }]
                }),
                forwarded()
            );
            expect(live).toMatchObject({ kind: "admitted" });
            expect(consent.calls).toBe(1);
        }
    );

    test("denies every admission the Device consent gate rejects", { tags: "p0" }, () => {
        const cases: readonly (readonly [string, Parameters<typeof deviceRequest>[0], string])[] = [
            [
                "another Facet",
                {
                    facet: otherFacet,
                    operation: "camera",
                    impact: "externalSend",
                    inputs: [{ deviceId: "ports-device" }]
                },
                "Device consent admission targeted a different Facet"
            ],
            [
                "an unknown observing Operation",
                { operation: "peek", impact: "observe", inputs: [{ deviceId: "ports-device" }] },
                "Device consent admission rejected an unknown live Operation"
            ],
            [
                "a cached read at a mutating impact",
                { operation: "readCached", impact: "mutate", inputs: [{ key: "last" }] },
                "Device consent admission rejected an unknown live Operation"
            ],
            [
                "a live Operation below the external send impact",
                { operation: "camera", impact: "mutate", inputs: [{ deviceId: "ports-device" }] },
                "Device consent admission rejected an unknown live Operation"
            ],
            [
                "an unknown Operation at the external send impact",
                {
                    operation: "detonate",
                    impact: "externalSend",
                    inputs: [{ deviceId: "ports-device" }]
                },
                "Device consent admission rejected an unknown live Operation"
            ],
            [
                "more than one Device input",
                {
                    operation: "camera",
                    impact: "externalSend",
                    inputs: [{ deviceId: "ports-device" }, { deviceId: "ports-device" }]
                },
                "Device consent admission requires one exact Device input"
            ],
            [
                "no Device input",
                { operation: "camera", impact: "externalSend", inputs: [] },
                "Device consent admission requires one exact Device input"
            ],
            [
                "a null Device input",
                { operation: "camera", impact: "externalSend", inputs: [null] },
                "Device consent admission requires one exact Device input"
            ],
            [
                "an array Device input",
                { operation: "camera", impact: "externalSend", inputs: [["ports-device"]] },
                "Device consent admission requires one exact Device input"
            ],
            [
                "a scalar Device input",
                { operation: "camera", impact: "externalSend", inputs: ["ports-device"] },
                "Device consent admission requires one exact Device input"
            ],
            [
                "a Device input without a string identifier",
                { operation: "camera", impact: "externalSend", inputs: [{ deviceId: 7 }] },
                "Device consent admission requires one exact Device input"
            ]
        ];

        for (const [reason, init, expectedReason] of cases) {
            const consent = new ScriptedConsent();
            const port = new DeviceConsentFinalAdmissionPort<
                object,
                string,
                string,
                string,
                string,
                string
            >(deviceFacet, new FixedDeviceAgent(), consent);
            expect(port.admit({}, deviceRequest(init), forwarded()), reason).toEqual({
                kind: "denied",
                reason: expectedReason
            });
            expect(consent.calls, reason).toBe(0);
        }
    });

    test("maps Device consent faults and propagates other faults", { tags: "p0" }, () => {
        const consent = new ScriptedConsent();
        const port = new DeviceConsentFinalAdmissionPort<
            object,
            string,
            string,
            string,
            string,
            string
        >(deviceFacet, new FixedDeviceAgent(), consent);
        const request = deviceRequest({
            operation: "location",
            impact: "externalSend",
            inputs: [{ deviceId: "ports-device" }]
        });

        consent.failure = new DeviceError("consent.denied", "Device consent was revoked");
        expect(port.admit({}, request, forwarded())).toEqual({
            kind: "denied",
            reason: "Device consent was revoked"
        });

        const crash = new TypeError("device consent store crashed");
        consent.failure = crash;
        expect(() => port.admit({}, request, forwarded())).toThrow(crash);
    });
});

describe("single-tenant policy assembly", () => {
    const anchor = {
        actorId: new ActorId("ports-single-tenant"),
        tenantId: new TenantId("ports-personal"),
        principalId: new PrincipalId("ports-owner"),
        trustAnchor: Uint8Array.of(1),
        tenantKind: "personal" as const
    };
    const workspaceId = new WorkspaceId("ports-assistant");
    const init = {
        anchor,
        workspaceId,
        binding: {
            name: new BindingName("ports-assistant"),
            domain: new ProtectionDomain("backend", "ports-assistant", "may-hold-secrets"),
            facet: new FacetRef("profile:self")
        }
    };

    test("multiplicity policy values are frozen and count-checked", { tags: "p0" }, () => {
        const policy = TenantMultiplicityPolicy.singleTenant();

        expect(Object.isFrozen(policy)).toBe(true);
        expect(Object.isFrozen(policy.promote())).toBe(true);
        expect(policy.canCreateTenant(0)).toBe(true);
        expect(policy.canCreateTenant(1)).toBe(false);
        expect(policy.promote().canCreateTenant(1)).toBe(true);
    });

    test(
        "the owner Membership materializes the one allow Grant the Binding names",
        { tags: "p0" },
        () => {
            // The assembly finds the owner's Grant by searching the bootstrap plan for an
            // allow whose subject is the owner Membership's. That search is only right
            // while the plan holds exactly one such Grant, and that is a fact about
            // OWNER_ROLE — a single allow RoleRule over every impact — rather than about
            // this file. Pinning it here is what makes the search's absent-Grant branch
            // genuinely unreachable, and what fails first if the Role gains a rule.
            const control = MemoryTenantControlStore.create(anchor);
            const assembly = assembleSingleTenantPolicy(control, init);

            expect(assembly.grants).toHaveLength(1);
            const [ownerGrant] = assembly.grants;
            if (ownerGrant === undefined) throw new TypeError("expected an owner Grant");
            expect(ownerGrant.effect).toBe("allow");
            expect(subjectKey(ownerGrant.subject)).toBe(
                subjectKey(assembly.ownerMembership.subject)
            );
            expect(assembly.binding.grantId.equals(ownerGrant.id)).toBe(true);
        }
    );

    test("a second assembly is refused with the exact typed error", { tags: "p0" }, () => {
        const control = MemoryTenantControlStore.create(anchor);
        assembleSingleTenantPolicy(control, init);

        let failure: unknown;
        try {
            assembleSingleTenantPolicy(control, init);
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(AgentCoreError);
        expect(failure).toMatchObject({
            code: "protocol.invalid-state",
            message: "Single-tenant policy already has its Tenant"
        });
    });
});

class RecordingContentStore extends ContentStore {
    public readonly stored: Uint8Array[] = [];

    public async put(bytes: Uint8Array): Promise<ContentPutResult> {
        this.stored.push(bytes.slice());
        const digest = Digest.sha256(bytes);
        return { ref: ContentRef.fromDigest(digest), digest };
    }

    public async get(): Promise<Uint8Array> {
        throw new TypeError("Reconciliation must not read stored content");
    }

    public async stat(): Promise<undefined> {
        return undefined;
    }
}

class ScriptedGateway extends ApprovalGatewayBackend {
    public constructor(private readonly outcome: ApprovalGatewayReconciliationResult) {
        super();
    }

    public async observe(): Promise<JsonValue> {
        throw new TypeError("Reconciliation must not observe");
    }

    public async apply(): Promise<JsonValue> {
        throw new TypeError("Reconciliation must not apply");
    }

    public async reconcile(
        _dispatch: EffectDispatch
    ): Promise<ApprovalGatewayReconciliationResult> {
        return this.outcome;
    }
}

const reconciliationAttempt = new EffectAttempt<string, string>(
    new EffectAttemptId("ports-attempt"),
    invocation,
    0,
    0,
    new ItemClaimId("ports-claim"),
    undefined,
    new AuthorityAdmissionReference<string>("ports-admission", digestOf("ports-admission")),
    ISSUED_AT,
    "ports-idempotency",
    new AuditRecordId("ports-audit")
);

describe("approval gateway reconciliation", () => {
    test(
        "an unknown reconciliation is returned unchanged and stores nothing",
        { tags: "p0" },
        async () => {
            const unknown: ApprovalGatewayReconciliationResult = { kind: "unknown" };
            const content = new RecordingContentStore();
            const port = new ApprovalGatewayReconciliationPort<string, string>(
                new ScriptedGateway(unknown),
                content
            );

            const result = await port.query(reconciliationAttempt, digestOf("ports-intent"));

            expect(result).toBe(unknown);
            expect(content.stored).toEqual([]);
        }
    );

    test("resolved reconciliations store their canonical result", { tags: "p0" }, async () => {
        const content = new RecordingContentStore();
        const port = new ApprovalGatewayReconciliationPort<string, string>(
            new ScriptedGateway({ kind: "succeeded", result: { ok: true } }),
            content
        );

        const result = await port.query(reconciliationAttempt, digestOf("ports-intent"));

        expect(result).toMatchObject({ kind: "succeeded" });
        expect(content.stored).toHaveLength(1);

        const withoutResult = new RecordingContentStore();
        const bare = new ApprovalGatewayReconciliationPort<string, string>(
            new ScriptedGateway({ kind: "failed" }),
            withoutResult
        );
        expect(await bare.query(reconciliationAttempt, digestOf("ports"))).toEqual({
            kind: "failed"
        });
        expect(withoutResult.stored).toEqual([]);
    });
});

describe("durable Run admission validation", () => {
    test(
        "an absent admission registry refuses the reservation without faulting",
        { tags: "p0" },
        () => {
            const run = new RunId("ports-admission-run");
            const reservation = {
                run,
                registryEpoch: 0,
                obligation: { kind: "invocationItem" as const, invocation, itemIndex: 0, itemKey }
            };
            const registry = new RunAdmissionRegistry({
                run,
                epoch: 0,
                accepting: true,
                reserved: [reservation.obligation],
                completed: []
            });
            let stored: RunAdmissionRegistry | undefined;
            const port = new DurableRunAdmissionPort<object>(
                reaching<RunRepository<object>>({ loadAdmission: () => stored })
            );

            expect(port.accepts({}, reservation)).toBe(false);

            stored = registry;
            expect(port.accepts({}, reservation)).toBe(true);
            expect(port.accepts({}, { ...reservation, registryEpoch: 1 })).toBe(false);
        }
    );
});
