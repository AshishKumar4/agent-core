import { ActorId, ActorRef } from "../../src/actors";
import { MemoryContentStore } from "../../src/content";
import { encodeCanonicalJson, type JsonValue } from "../../src/core";
import {
    ApprovalGatewayAction,
    ApprovalGatewayBackend,
    ApprovalGatewayFacet,
    APPROVAL_GATEWAY_OPERATION_CONTRACTS,
    BindingName,
    CapabilitySpec,
    DEVICE_COMMANDS,
    DEVICE_COMMAND_SURFACE,
    DEVICE_OPERATION_CONTRACTS,
    DeviceBackend,
    DeviceCommandId,
    DeviceEnvironmentSessionDependency,
    DeviceFacet,
    DeviceId,
    FILESYSTEM_OPERATION_CONTRACTS,
    FacetPackageId,
    FacetRef,
    MemoryDeviceConsentBackend,
    MemoryFilesystemBackend,
    ProfileRuntimeEffectsPort,
    ProfileRuntimeHostBinding,
    ProtectedProfileRuntimePort,
    SELF_OPERATION_CONTRACTS,
    SelfFacet,
    SelfRunDependency,
    TASK_ACTION_SOURCE_OPERATION,
    TaskBackend,
    TaskEntry,
    TaskFacet,
    TaskId,
    type EventDeclaration,
    type FacetData,
    type OperationDescriptor,
    type ProtectedOperationRequest,
    type ProfileControlAdmission,
    type ProfileEffectContext,
    type ReverseDeviceTransportBackend,
    type SelfCheckpointInput,
    type SelfCommitMessageInput,
    type SelfFinishInput,
    type SelfMigrationInput,
    type SelfSpawnInput,
    type SurfaceDescriptor
} from "../../src/facets";
import { Grant, GrantId } from "../../src/authority";
import {
    PrincipalId,
    PrincipalRef,
    ScopeRef,
    SubjectRef,
    TenantId,
    WorkspaceId
} from "../../src/identity";
import {
    Approval,
    ApprovalId,
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    InvocationProtectedOperationPort,
    ReceiptId,
    validateAuditAppend,
    type AuditEvidenceResolver,
    type Receipt
} from "../../src/invocations";
import { CorrelationId, EventId, InvocationId } from "../../src/interaction-references";
import { SqliteWorkspaceEventRecords } from "../../src/substrates";
import { RunId, TurnId, TurnLease } from "../../src/agents";
import {
    ContentRetentionId,
    ContentRetentionReference,
    Event,
    EventProvenance,
    EventVerification,
    RetainedRecordKind,
    RetainedRecordRef,
    WorkspacePersistence
} from "../../src/workspaces";
import { describe, expect, test } from "vitest";
import { TestSqlite } from "../helpers/sqlite";
import { CanonicalBatchHarness } from "./canonical-batch-harness";

const tenant = new TenantId("profile-conformance-tenant");
const principal = new PrincipalRef(tenant, new PrincipalId("profile-conformance-agent"));

describe("Exact profile runtime conformance", () => {
    test("[P11-BASE-NAMES] executes a platform alias without changing impact or invariants", async () => {
        const canonical = FILESYSTEM_OPERATION_CONTRACTS.read;
        const aliased = canonical.alias("platform.readFile");
        const fixture = profileFixture("base-alias", aliased.descriptor);
        const filesystem = new MemoryFilesystemBackend();
        filesystem.write("/file", new Uint8Array([1, 2]));

        const result = await fixture.runtime.invoke(aliased, { path: "/file" }, (input) =>
            filesystem.read(input.path, input.range)
        );

        expect(result).toEqual(new Uint8Array([1, 2]));
        expect(aliased.descriptor).toMatchObject({ impact: canonical.descriptor.impact });
        expect(aliased.descriptor.input).toBe(canonical.descriptor.input);
        expect(aliased.descriptor.output).toBe(canonical.descriptor.output);
        expect(currentReceipt(fixture)).toMatchObject({ outcome: "succeeded" });
    });

    test("[P11-APPROVAL-GATEWAY-CONTINUATION] resumes through the persisted whole-intent continuation after restart", async () => {
        const fixture = approvalFixture("approval-continuation");
        await expect(fixture.facet.applyAction({ resource: "account" })).resolves.toEqual({
            applied: true
        });
        fixture.profile.harness.transactions.restart();

        const continuation = fixture.profile.harness.transactions.transact((transaction) =>
            fixture.profile.harness.persistence.continuation(
                transaction,
                fixture.profile.invocation
            )
        );
        expect(continuation?.intentDigest.equals(fixture.intent)).toBe(true);
        expect(continuation?.invocation.equals(fixture.profile.invocation)).toBe(true);
        await expect(fixture.facet.applyAction({ resource: "account" })).resolves.toEqual({
            applied: true
        });
        expect(fixture.backend.actions).toEqual([{ approved: true }]);
    });

    test("[P11-APPROVAL-GATEWAY-MATCH] rejects an action not matching the approved PreparedInvocation and continuation", async () => {
        const fixture = approvalFixture("approval-match", "other");
        await expect(fixture.facet.applyAction({ resource: "account" })).rejects.toMatchObject({
            code: "invocation.invalid"
        });
        const continuation = fixture.profile.harness.transactions.transact((transaction) =>
            fixture.profile.harness.persistence.continuation(
                transaction,
                fixture.profile.invocation
            )
        );
        expect(continuation?.intentDigest.equals(fixture.intent)).toBe(true);
        expect(currentReceipt(fixture.profile)).toMatchObject({ outcome: "indeterminate" });
        expect(fixture.backend.actions).toEqual([]);
    });

    test("[C13-PROFILE-SOURCE-EVENT-CAUSALITY] persists a W7 Event caused by the exact successful W6 Receipt", async () => {
        const fixture = taskEventFixture("source-event-causality");
        await fixture.task.submitAction({ taskId: new TaskId("task"), action: { complete: true } });

        const event = fixture.effects.events[0]!;
        const evidence = fixture.effects.eventEvidence(event.id);
        expect(event.kind.value).toBe("task.actionSubmitted");
        expect(evidence.receipt.id.equals(currentReceipt(fixture.profile)!.id)).toBe(true);
        expect(evidence.audit.cause?.equals(evidence.receiptAudit.id)).toBe(true);
        expect(evidence.receiptAudit.kind).toMatchObject({ kind: "receipt", outcome: "succeeded" });
    });

    test("[P11-TASK-EVENT] replays one mediated task source Event across profile and SQLite restart", async () => {
        const fixture = taskEventFixture("task-event");
        const input = { taskId: new TaskId("task"), action: { complete: true } };
        await fixture.task.submitAction(input);
        fixture.profile.harness.transactions.restart();
        fixture.effects.restart();
        await fixture.task.submitAction(input);

        expect(fixture.effects.events).toHaveLength(1);
        expect(fixture.effects.events[0]?.kind.value).toBe("task.actionSubmitted");
        expect(
            fixture.profile.harness.transactions.transact((transaction) =>
                fixture.profile.harness.persistence.attemptsForItem(
                    transaction,
                    fixture.profile.invocation,
                    0
                )
            )
        ).toHaveLength(1);
    });

    test("[P11-DEVICE-COMMAND-EVENTS] persists invoked and completed Events with the command Receipt cause", async () => {
        const fixture = deviceFixture("device-command-events");
        await fixture.device.command(commandInput());
        fixture.profile.harness.transactions.restart();
        fixture.effects.restart();
        await fixture.device.command(commandInput());

        expect(fixture.effects.events.map((event) => event.kind.value)).toEqual([
            "command.invoked",
            "command.completed"
        ]);
        const receipt = currentReceipt(fixture.profile)!;
        expect(
            fixture.effects.events.map(
                (event) => fixture.effects.eventEvidence(event.id).receipt.id.value
            )
        ).toEqual([receipt.id.value, receipt.id.value]);
        expect(fixture.transportCalls).toBe(1);
    });

    test("[P11-DEVICE-TYPED-SURFACE] validates and executes the Surface command's typed Operation", async () => {
        const fixture = deviceFixture("device-typed-surface");
        expect(DEVICE_COMMAND_SURFACE.id.value).toBe("device.commands");
        expect(DEVICE_COMMANDS.find((command) => command.name === "camera")?.arguments).toBe(
            DEVICE_OPERATION_CONTRACTS.camera.descriptor.input
        );
        await expect(
            fixture.device.command({ ...commandInput(), arguments: { facing: "side" } })
        ).rejects.toMatchObject({ code: "operation.invalid-input", detailCode: "wire.input" });
        expect(currentReceipt(fixture.profile)).toBeUndefined();
        await expect(fixture.device.command(commandInput())).resolves.toEqual({ captured: true });
        expect(fixture.transportCalls).toBe(1);
    });

    test("[P11-SELF-RECEIPTS] persists and replays the canonical Self Operation Receipt", async () => {
        const dependency = new MemorySelfDependency();
        const fixture = selfFixture(
            "self-receipts",
            SELF_OPERATION_CONTRACTS.checkpoint.descriptor
        );
        const self = new SelfFacet(fixture.runtime, dependency);
        await self.checkpoint({ checkpoint: { value: 1 } });
        const first = currentReceipt(fixture)!;
        fixture.harness.transactions.restart();
        await self.checkpoint({ checkpoint: { value: 1 } });
        expect(currentReceipt(fixture)?.id.equals(first.id)).toBe(true);
        expect(dependency.calls).toEqual(["checkpoint"]);
    });

    test("[P11-SELF-AUDIT] records the canonical invocation, attempt, and Receipt audit chain", async () => {
        const fixture = selfFixture("self-audit", SELF_OPERATION_CONTRACTS.checkpoint.descriptor);
        await new SelfFacet(fixture.runtime, new MemorySelfDependency()).checkpoint({
            checkpoint: { value: 1 }
        });
        const audits = fixture.harness.transactions.transact((transaction) =>
            [...transaction.audits.values()].map((bytes) => AuditRecord.decode(bytes))
        );
        expect(audits.map((audit) => audit.kind.kind)).toEqual(["attempt", "receipt"]);
        expect(audits[1]?.cause?.equals(audits[0]!.id)).toBe(true);
    });

    test("[P11-SELF-LEASE] denies every Self Operation under a stale exact-Turn lease before EffectAttempt", async () => {
        const turn = new TurnId("self-lease-turn");
        const holder = new PrincipalId("self-lease-holder");
        const live = TurnLease.unclaimed(turn).claim(holder, new Date(1), new Date(100));
        const stale = JSON.stringify({ turn: turn.value, holder: holder.value, epoch: 0 });
        const operations = Object.values(SELF_OPERATION_CONTRACTS);
        for (const contract of operations) {
            const fixture = selfFixture(
                `self-lease-${contract.name.toLocaleLowerCase()}`,
                contract.descriptor
            );
            fixture.harness.preparation.lease = stale;
            fixture.harness.finalAdmissions.decide = (_request, context) =>
                live.admits(parseLease(context.invocation.header.lease), new Date(10))
                    ? { kind: "admitted" }
                    : { kind: "denied", reason: "stale Self Turn lease" };
            const self = new SelfFacet(fixture.runtime, new MemorySelfDependency());
            await expect(invokeSelf(self, contract.name)).rejects.toMatchObject({
                code: "authority.denied"
            });
            expect(
                fixture.harness.transactions.transact((transaction) =>
                    fixture.harness.persistence.attemptsForItem(transaction, fixture.invocation, 0)
                )
            ).toEqual([]);
        }
    });

    test("[P11-SELF-ATTENUATION] creates a child Run under a durably attenuated Grant", async () => {
        const dependency = new AttenuatingSelfDependency(false);
        const fixture = selfFixture("self-attenuation", SELF_OPERATION_CONTRACTS.spawn.descriptor);
        await new SelfFacet(fixture.runtime, dependency).spawn({
            child: { capability: "observe" }
        });
        expect(dependency.childRun?.equals(dependency.parentRun)).toBe(false);
        expect(dependency.child?.attenuationOf?.equals(dependency.parent.id)).toBe(true);
        expect(dependency.parent.canAttenuate(dependency.child!)).toBe(true);
        expect(
            dependency
                .resolvedAuthority(dependency.childRun!)
                .every((child) =>
                    dependency
                        .resolvedAuthority(dependency.parentRun)
                        .some((parent) => parent.canAttenuate(child))
                )
        ).toBe(true);
    });

    test("[P11-SELF-NO-WIDENING] rejects a spawned child authority outside the parent closure", async () => {
        const dependency = new AttenuatingSelfDependency(true);
        const fixture = selfFixture("self-no-widening", SELF_OPERATION_CONTRACTS.spawn.descriptor);
        await expect(
            new SelfFacet(fixture.runtime, dependency).spawn({
                child: { capability: "administer" }
            })
        ).rejects.toMatchObject({ code: "invocation.invalid" });
        expect(dependency.child).toBeUndefined();
    });
});

function profileFixture(
    label: string,
    descriptor: OperationDescriptor,
    effects: ProfileRuntimeEffectsPort<Receipt> = new ImmediateProfileEffects(),
    approvalRequired = false
) {
    const invocation = new InvocationId(label);
    const harness = new CanonicalBatchHarness<ProtectedOperationRequest>(
        approvalRequired,
        new FacetRef(`profile:${label}`),
        descriptor
    );
    const runtime = new ProtectedProfileRuntimePort(
        new ProfileRuntimeHostBinding(new FacetRef(`profile:${label}`), new BindingName(label)),
        new InvocationProtectedOperationPort({ invocation: () => invocation }, harness.port),
        effects
    );
    runtime.activate();
    return { harness, invocation, runtime };
}

function currentReceipt(fixture: ReturnType<typeof profileFixture>): Receipt | undefined {
    return fixture.harness.transactions.transact((transaction) =>
        fixture.harness.ledger.currentReceipt(transaction, fixture.invocation, 0)
    );
}

class ImmediateProfileEffects extends ProfileRuntimeEffectsPort<Receipt> {
    public async emit(): Promise<void> {}

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
        _context: import("../../src/facets").OperationContext,
        input: FacetData
    ): Promise<FacetData> {
        return input;
    }
}

class TestApprovalBackend extends ApprovalGatewayBackend {
    public readonly actions: JsonValue[] = [];

    public async observe(resource: string): Promise<JsonValue> {
        return { resource };
    }

    public async apply(
        _context: ProfileEffectContext,
        _resource: string,
        action: JsonValue
    ): Promise<JsonValue> {
        this.actions.push(action);
        return { applied: true };
    }
}

function approvalFixture(label: string, actionResource = "account") {
    const descriptor = APPROVAL_GATEWAY_OPERATION_CONTRACTS.applyAction.descriptor;
    const profile = profileFixture(label, descriptor, new ImmediateProfileEffects(), true);
    const input = { resource: "account" } as const;
    const intent = profile.harness.preparation.create(
        profile.invocation,
        [input],
        "single"
    ).intentDigest;
    const pending = Approval.pending(
        new ApprovalId(`${label}-approval`),
        profile.invocation,
        intent,
        new Date(1),
        new Date(10_000)
    );
    profile.harness.transactions.transact((transaction) => {
        profile.harness.ledger.prepare(
            transaction,
            profile.harness.preparation.create(profile.invocation, [input], "single")
        );
        profile.harness.ledger.requestApproval(transaction, pending);
        profile.harness.ledger.appendApprovalRevision(
            transaction,
            pending.approve(new PrincipalId(`${label}-approver`), new Date(2))
        );
    });
    const backend = new TestApprovalBackend();
    const facet = new ApprovalGatewayFacet(
        profile.runtime,
        new ApprovalGatewayAction(profile.invocation, intent, actionResource, { approved: true }),
        backend
    );
    return { profile, intent, backend, facet };
}

function taskEventFixture(label: string) {
    const bootstrap = profileFixture(label, TASK_ACTION_SOURCE_OPERATION.descriptor);
    const effects = new SqliteCausalProfileEffects(bootstrap.harness);
    const profile = profileFixtureWithHarness(bootstrap, effects);
    const backend = new TaskBackend();
    backend.create(new TaskEntry(new TaskId("task"), undefined, undefined, {}));
    return { profile, effects, task: new TaskFacet(profile.runtime, backend) };
}

function profileFixtureWithHarness(
    fixture: ReturnType<typeof profileFixture>,
    effects: ProfileRuntimeEffectsPort<Receipt>
) {
    const runtime = new ProtectedProfileRuntimePort(
        fixture.runtime.host,
        new InvocationProtectedOperationPort(
            { invocation: () => fixture.invocation },
            fixture.harness.port
        ),
        effects
    );
    runtime.activate();
    return { ...fixture, runtime };
}

function deviceFixture(label: string) {
    const bootstrap = profileFixture(label, DEVICE_OPERATION_CONTRACTS.camera.descriptor);
    const effects = new SqliteCausalProfileEffects(bootstrap.harness);
    const profile = profileFixtureWithHarness(bootstrap, effects);
    const consent = new MemoryDeviceConsentBackend(() => 10);
    const phone = new DeviceId("phone");
    consent.grant(phone, principal, 20);
    const admission = consent.admit(undefined, phone, principal);
    profile.harness.finalAdmissions.result = { kind: "admitted", evidence: admission };
    let transportCalls = 0;
    const transport: ReverseDeviceTransportBackend = {
        async pair(): Promise<void> {},
        async send() {
            transportCalls += 1;
            return { captured: true };
        }
    };
    const device = new DeviceFacet(
        profile.runtime,
        new DeviceBackend(new LiveDeviceSession(), transport, { read: () => undefined })
    );
    return {
        profile,
        effects,
        device,
        get transportCalls() {
            return transportCalls;
        }
    };
}

class LiveDeviceSession extends DeviceEnvironmentSessionDependency {
    public assertUsable(): void {}
}

function commandInput() {
    return {
        commandId: new DeviceCommandId("camera-command"),
        deviceId: new DeviceId("phone"),
        operation: "camera" as const,
        arguments: { facing: "front" }
    };
}

class SqliteCausalProfileEffects extends ProfileRuntimeEffectsPort<Receipt> {
    readonly #database = new TestSqlite();
    readonly #content = new MemoryContentStore();
    readonly #eventAudits = new Map<
        string,
        { audit: AuditRecord; receiptAudit: AuditRecord; receipt: Receipt }
    >();
    #records = new SqliteWorkspaceEventRecords(this.#database);
    public readonly events: Event[] = [];

    public constructor(private readonly harness: CanonicalBatchHarness<ProtectedOperationRequest>) {
        super();
    }

    public async emit(
        host: ProfileRuntimeHostBinding,
        declaration: EventDeclaration,
        payload: FacetData,
        cause: Receipt
    ): Promise<void> {
        if (!(cause instanceof AttemptReceipt) || cause.outcome !== "succeeded") {
            throw new TypeError("Profile source Event requires a successful canonical Receipt");
        }
        const idempotencyKey = `${declaration.kind.value}:${cause.id.value}`;
        const actor = new ActorRef("run", new ActorId(`profile-event:${host.facet.value}`));
        const persistence = this.persistence(actor);
        const existing = this.#database.transaction(() =>
            persistence.findEventByIdentity(this.#database, idempotencyKey)
        );
        if (existing !== undefined) return;

        const bytes = encodeCanonicalJson(payload);
        const stored = await this.#content.put(bytes);
        const event = new Event({
            id: new EventId(`event:${idempotencyKey}`),
            scope: ScopeRef.workspace(tenant, new WorkspaceId("profile-events")),
            source: { kind: "facet", facet: new FacetPackageId(host.facet.value) },
            kind: declaration.kind,
            payload: stored.ref,
            payloadDigest: stored.ref.digest,
            idempotencyKey,
            correlation: new CorrelationId(`correlation:${cause.id.value}`),
            provenance: new EventProvenance({
                verification: EventVerification.host(),
                claims: { receipt: cause.id.value }
            }),
            trust: "self",
            visibility: declaration.visibility
        });
        const linked = this.appendEventAudit(actor, event, cause);
        const retention = new ContentRetentionReference({
            id: new ContentRetentionId(`retention:${event.id.value}`),
            tenant,
            actor,
            recordKind: RetainedRecordKind.event(),
            record: new RetainedRecordRef(event.id.value),
            content: event.payload,
            digest: event.payloadDigest
        });
        this.#database.transaction(() => persistence.appendEvent(this.#database, event, retention));
        this.events.push(event);
        this.#eventAudits.set(event.id.value, { ...linked, receipt: cause });
    }

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
        _context: import("../../src/facets").OperationContext,
        input: FacetData
    ): Promise<FacetData> {
        return input;
    }

    public restart(): void {
        this.#records = new SqliteWorkspaceEventRecords(this.#database);
    }

    public eventEvidence(id: EventId) {
        const evidence = this.#eventAudits.get(id.value);
        if (evidence === undefined) throw new TypeError("Missing Event audit evidence");
        return evidence;
    }

    private persistence(actor: ActorRef): WorkspacePersistence<TestSqlite> {
        return new WorkspacePersistence(
            () => this.#records,
            { verify: () => true, release() {}, discard() {} },
            actor,
            tenant
        );
    }

    private appendEventAudit(actor: ActorRef, event: Event, receipt: Receipt) {
        return this.harness.transactions.transact((transaction) => {
            const publication = this.harness.evidence
                .pendingPublications(transaction)
                .find((candidate) => candidate.observation.receipt.equals(receipt.id));
            if (publication === undefined)
                throw new TypeError("Receipt publication is unavailable");
            const receiptAudit = this.harness.evidence.audit(
                transaction,
                publication.observation.audit
            );
            if (receiptAudit === undefined) throw new TypeError("Receipt audit is unavailable");
            const audit = new AuditRecord({
                id: new AuditRecordId(`audit:${event.id.value}`),
                actor: receiptAudit.actor.equals(actor) ? actor : receiptAudit.actor,
                tenant: receiptAudit.tenant,
                correlation: receiptAudit.correlation,
                cause: receiptAudit.id,
                kind: { kind: "event", id: event.id }
            });
            const records = {
                get: (id: AuditRecordId) => this.harness.evidence.audit(transaction, id)
            };
            validateAuditAppend(audit, records, undefined, eventEvidence(event.id, receipt.id));
            this.harness.evidence.appendAudit(transaction, audit);
            return { audit, receiptAudit };
        });
    }
}

function eventEvidence(event: EventId, receipt: ReceiptId): AuditEvidenceResolver {
    return {
        approval: () => undefined,
        attempt: () => undefined,
        receipt: () => undefined,
        event: (id) => (id.equals(event) ? { receipt } : undefined),
        route: () => undefined,
        projection: () => undefined,
        delivery: () => undefined,
        commit: () => undefined,
        write: () => undefined
    };
}

class MemorySelfDependency extends SelfRunDependency {
    public readonly calls: string[] = [];

    public async checkpoint(_input: SelfCheckpointInput): Promise<JsonValue> {
        return this.record("checkpoint");
    }
    public async commitMessage(_input: SelfCommitMessageInput): Promise<JsonValue> {
        return this.record("commitMessage");
    }
    public async spawn(_input: SelfSpawnInput): Promise<JsonValue> {
        return this.record("spawn");
    }
    public async finish(_input: SelfFinishInput): Promise<JsonValue> {
        return this.record("finish");
    }
    public async proposeMigration(_input: SelfMigrationInput): Promise<JsonValue> {
        return this.record("proposeMigration");
    }

    private record(operation: string): JsonValue {
        this.calls.push(operation);
        return { operation };
    }
}

class AttenuatingSelfDependency extends MemorySelfDependency {
    public readonly parentRun = new RunId("self-parent-run");
    public readonly parent = grant(
        "parent",
        new CapabilitySpec({
            facetPattern: "workspace:*",
            impacts: ["observe", "delegate"]
        })
    );
    public childRun: RunId | undefined;
    public child: Grant | undefined;
    readonly #authorityByRun = new Map<string, readonly Grant[]>([
        [this.parentRun.value, [this.parent]]
    ]);

    public constructor(private readonly widen: boolean) {
        super();
    }

    public override async spawn(_input: SelfSpawnInput): Promise<JsonValue> {
        const candidate = grant(
            "child",
            new CapabilitySpec({
                facetPattern: "workspace:*",
                impacts: this.widen ? ["administer"] : ["observe"]
            }),
            this.parent.id
        );
        if (!this.parent.canAttenuate(candidate)) throw new TypeError("child authority widened");
        this.childRun = new RunId("self-child-run");
        this.child = Grant.decode(Grant.encode(candidate));
        this.#authorityByRun.set(this.childRun.value, [this.child]);
        return { run: this.childRun.value, grant: this.child.id.value };
    }

    public resolvedAuthority(run: RunId): readonly Grant[] {
        return this.#authorityByRun.get(run.value) ?? [];
    }
}

function grant(id: string, capability: CapabilitySpec, attenuation?: GrantId): Grant {
    return new Grant(
        new GrantId(`self-${id}`),
        ScopeRef.workspace(tenant, new WorkspaceId("self-workspace")),
        SubjectRef.principal(principal.principalId),
        "allow",
        capability,
        { kind: "direct" },
        attenuation
    );
}

function selfFixture(label: string, descriptor: OperationDescriptor) {
    return profileFixture(label, descriptor);
}

function parseLease(value: string | undefined) {
    if (value === undefined)
        return { turn: new TurnId("missing"), holder: new PrincipalId("missing"), epoch: 0 };
    const parsed = JSON.parse(value) as { turn: string; holder: string; epoch: number };
    return {
        turn: new TurnId(parsed.turn),
        holder: new PrincipalId(parsed.holder),
        epoch: parsed.epoch
    };
}

function invokeSelf(self: SelfFacet<Receipt>, operation: string): Promise<JsonValue> {
    switch (operation) {
        case "checkpoint":
            return self.checkpoint({ checkpoint: {} });
        case "commitMessage":
            return self.commitMessage({ message: {} });
        case "spawn":
            return self.spawn({ child: {} });
        case "finish":
            return self.finish({ result: {} });
        case "proposeMigration":
            return self.proposeMigration({ migration: {} });
        default:
            throw new TypeError("Unknown Self Operation");
    }
}
