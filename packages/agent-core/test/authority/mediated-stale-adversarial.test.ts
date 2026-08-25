import { describe, expect, test } from "vitest";
import { ActorId, ActorRef, MemoryActorStore, requireSynchronousResult } from "../../src/actors";
import { Digest, JsonSchema, Revision, SemVer, encodeCanonicalJson } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    BindingName,
    CapabilitySpec,
    FacetRef,
    OperationDescriptor,
    OperationName,
    ProtectionDomain,
    type FacetData
} from "../../src/facets";
import { PrincipalId, ScopeRef, SubjectRef, TenantId, WorkspaceId } from "../../src/identity";
import { Binding } from "../../src/authority/binding";
import { BindingValidationRequest } from "../../src/authority/binding-evidence";
import { InvalidationWatermark, PathEpochEvidence, ScopeEpoch } from "../../src/authority/epoch";
import { AuthorityCheckRequest } from "../../src/authority/evidence";
import { Grant } from "../../src/authority/grant";
import { GrantId } from "../../src/authority/id";
import { MemoryTenantControlStore } from "../../src/authority/memory";
import { TenantAuthorityRuntime } from "../../src/authority/runtime";
import { AuthorityMutationService } from "../../src/authority/service";
import {
    MemoryInvalidationWatermarkStore,
    watermarkKey,
    type InvalidationWatermarkStore
} from "../../src/authority/watermark-store";
import {
    ActorAuthorityState,
    ResolvedOperationAuthority,
    TenantOperationAuthority,
    type ActorAuthorityHost,
    type OperationResolutionCandidate
} from "../../src/composition";
import { PackageId, PackagePin, PolicySet } from "../../src/definition";
import { TurnId, TurnLease, type LeaseToken } from "../../src/agents";
import { AuditRecordId, CorrelationId, InvocationId } from "../../src/interaction-references";
import { ReceiptId } from "../../src/invocation-references";
import {
    AuditRecord,
    InvocationPlacementPin,
    MemoryInvocationMediationPersistence,
    MemoryInvocationPersistence,
    PreEffectReceipt,
    cloneInvocationMediationMemoryState,
    cloneInvocationMemoryState,
    createInvocationMediationMemoryState,
    createInvocationMemoryState,
    type AuditEvidenceResolver,
    type InvocationMediationMemoryState,
    type InvocationMemoryState,
    type Receipt
} from "../../src/invocations";
import { SqliteProtocolPersistence, type TransactionalSqlite } from "../../src/substrates/sqlite";
import { SqliteInvocationMediationPersistence } from "../../src/substrates/sqlite/invocations";
import { invocationCodecs } from "../invocations/fixture";
import {
    createSqliteInvocationPersistence,
    runSynchronousSqliteTransaction
} from "../substrates/sqlite/invocations/fixture";
import { SqliteActorStore } from "../../src/substrates/sqlite/actor";
import { SqliteInvalidationWatermarkStore } from "../../src/substrates/sqlite/watermark";
import { PrincipalRef, Workspace } from "../identity/internal-fixture";
import { TestSqlite } from "../helpers/sqlite";

const tenantId = new TenantId("tenant-mediated-stale");
const principalId = new PrincipalId("principal-mediated-stale");
const workspaceId = new WorkspaceId("workspace-mediated-stale");
const tenantScope = ScopeRef.tenant(tenantId);
const workspaceScope = ScopeRef.workspace(tenantId, workspaceId);
const tenantActor = new ActorRef("tenant", new ActorId("tenant-mediated-stale-actor"));
const workspaceActor = new ActorRef("workspace", new ActorId("workspace-mediated-stale-actor"));
const holder = new PrincipalRef(tenantId, principalId);
const subject = SubjectRef.principal(holder);
const domain = new ProtectionDomain("backend", "mediated-stale", "no-secrets");
const facet = new FacetRef("workspace:mail.instance");
const bindingName = new BindingName("mail");
const boundGrantId = new GrantId("mediated-stale-allow");
const argumentsValue = { folder: "inbox" } as const;
const argumentsDigest = Digest.sha256(encodeCanonicalJson(argumentsValue));
const capability = new CapabilitySpec({
    facetPattern: "workspace:mail.*",
    impacts: ["observe"]
});

/**
 * The watermark plane of one Actor, and the single transaction its writes belong to.
 *
 * `join` is what a stale mediated observation performs before it denies (SPEC §3.4 rule 7):
 * it advances the holder's delivered epochs. `span` is the Actor-local transaction that
 * advance shares with whatever the observation does next, so a throw after the join is what
 * separates one transaction from two. `committed` reads what survived the span, never the
 * store instance the span wrote through, so a rolled-back advance cannot be read back out of
 * a live object the span still holds.
 */
interface WatermarkPlane {
    span(body: (join: (entries: readonly ScopeEpoch[]) => InvalidationWatermark) => void): void;
    committed(): InvalidationWatermark | undefined;
    joinOutsideSpan(entries: readonly ScopeEpoch[]): InvalidationWatermark;
    saveOutsideSpan(watermark: InvalidationWatermark): void;
}

interface WatermarkRecord {
    key: string;
    bytes: Uint8Array;
}

interface WatermarkActorState {
    watermarks: readonly WatermarkRecord[];
}

function copyRecord(record: WatermarkRecord): WatermarkRecord {
    return { key: record.key, bytes: record.bytes.slice() };
}

const emptyWatermark = InvalidationWatermark.empty(tenantId, workspaceActor, holder);
const watermarkRecordKey = watermarkKey(emptyWatermark);

/**
 * The memory reference plane. `MemoryInvalidationWatermarkStore` has no transaction-scoped
 * method, so its unit of participation is the snapshot the owning Actor holds — the idiom
 * `MemoryTenantAuthorityPermitStore` (src/authority/permit-runtime.ts) uses for permits:
 * rebuild the store from the snapshot inside the transaction, write the snapshot back, and
 * let the Actor's draft decide whether either survives.
 */
function memoryPlane(): WatermarkPlane {
    const seeded = new MemoryInvalidationWatermarkStore(tenantId, workspaceActor);
    seeded.save(emptyWatermark);
    const actors = new MemoryActorStore<WatermarkActorState>(
        { watermarks: seeded.snapshot().records.map(copyRecord) },
        (value) => ({ watermarks: value.watermarks.map(copyRecord) })
    );
    const open = (records: readonly WatermarkRecord[]): MemoryInvalidationWatermarkStore =>
        new MemoryInvalidationWatermarkStore(tenantId, workspaceActor, {
            version: 1,
            records
        });
    return {
        span(body): void {
            actors.transaction((transaction) => {
                const store = open(transaction.watermarks);
                body((entries) => {
                    const joined = store.join(watermarkRecordKey, entries);
                    transaction.watermarks = store.snapshot().records.map(copyRecord);
                    return joined;
                });
                return undefined;
            });
        },
        committed(): InvalidationWatermark | undefined {
            return open(actors.snapshot().state.watermarks).load(watermarkRecordKey);
        },
        joinOutsideSpan(entries): InvalidationWatermark {
            return actors.transaction((transaction) => {
                const store = open(transaction.watermarks);
                const joined = store.join(watermarkRecordKey, entries);
                transaction.watermarks = store.snapshot().records.map(copyRecord);
                return joined;
            });
        },
        saveOutsideSpan(watermark): void {
            actors.transaction((transaction) => {
                const store = open(transaction.watermarks);
                store.save(watermark);
                transaction.watermarks = store.snapshot().records.map(copyRecord);
                return undefined;
            });
        }
    };
}

/** The SQLite substrate plane, whose store enrols in the caller's Actor transaction. */
function sqlitePlane(): WatermarkPlane {
    const database = new TestSqlite();
    const actors = new SqliteActorStore(database);
    const store = new SqliteInvalidationWatermarkStore(database, tenantId, workspaceActor);
    store.save(emptyWatermark);
    return {
        span(body): void {
            actors.transact((transaction) => {
                body((entries) =>
                    store.joinInTransaction(transaction, watermarkRecordKey, entries)
                );
                return undefined;
            });
        },
        committed(): InvalidationWatermark | undefined {
            return store.load(watermarkRecordKey);
        },
        joinOutsideSpan(entries): InvalidationWatermark {
            return store.join(watermarkRecordKey, entries);
        },
        saveOutsideSpan(watermark): void {
            store.save(watermark);
        }
    };
}

const planes = {
    memory: memoryPlane,
    sqlite: sqlitePlane
} as const;

describe("adversarial stale mediated reads", () => {
    test(
        "[C13-ADV-MEDIATED-STALE] refuses the exact evidence it admitted one epoch earlier",
        { tags: "p0" },
        () => {
            const { service, runtime, store } = fixture();
            const gathered = currentPath(store);
            const request = checkRequest(gathered);
            const admitted = runtime.check(request, new Date(1_000));

            expect(admitted.allowed).toBe(true);
            expect(admitted.reason).toBe("allowed");

            // One authority mutation at the target Scope, nothing else.
            service.createGrant(grant("mediated-stale-unrelated", workspaceScope));
            const advanced = currentPath(store);
            expect(advanced.target.epoch).toBe(gathered.target.epoch + 1);

            // The same request, byte for byte: only the plane underneath moved.
            const replay = AuthorityCheckRequest.decode(AuthorityCheckRequest.encode(request));
            const refused = runtime.check(replay, new Date(1_001));

            expect(refused.allowed).toBe(false);
            expect(refused.reason).toBe("stalePath");
            expect(refused.matchedAllow).toEqual([]);
            expect(refused.matchedDeny).toEqual([]);
            // The refusal carries the current path, so its reader learns which Scope moved.
            expect(refused.pathEpochs.equals(advanced)).toBe(true);
            expect(gathered.staleScopes(refused.pathEpochs)).toEqual([workspaceScope]);
        }
    );

    test(
        "[C13-ADV-MEDIATED-STALE] refuses evidence whose ancestor Scope advanced while its target did not",
        { tags: "p0" },
        () => {
            const { service, runtime, store } = fixture();
            const gathered = currentPath(store);
            expect(runtime.check(checkRequest(gathered), new Date(2_000)).allowed).toBe(true);

            // A Tenant-Scope mutation leaves the Workspace epoch alone, so a host comparing
            // only the target epoch would still admit.
            service.createGrant(grant("mediated-stale-ancestor", tenantScope));
            const advanced = currentPath(store);
            expect(advanced.target.epoch).toBe(gathered.target.epoch);
            expect(advanced.path[0].epoch).toBe(gathered.path[0].epoch + 1);

            const refused = runtime.check(checkRequest(gathered), new Date(2_001));
            expect(refused.allowed).toBe(false);
            expect(refused.reason).toBe("stalePath");
            expect(gathered.staleScopes(refused.pathEpochs)).toEqual([tenantScope]);
        }
    );

    test(
        "[C13-ADV-MEDIATED-STALE] refuses a sibling Scope's current path and cannot be handed a truncated one",
        { tags: "p0" },
        () => {
            const { service, runtime, store } = fixture();
            const sibling = new WorkspaceId("workspace-mediated-stale-sibling");
            const siblingScope = ScopeRef.workspace(tenantId, sibling);
            service.createWorkspace(
                new Workspace(sibling, tenantId, undefined, Revision.initial())
            );

            // Current evidence, read this instant, for the Workspace next door. Every epoch in
            // it is live; only the Scope chain is the wrong one.
            const foreign = new PathEpochEvidence([
                store.epoch(tenantScope),
                store.epoch(siblingScope)
            ]);
            const refused = runtime.check(checkRequest(foreign), new Date(3_000));

            expect(refused.allowed).toBe(false);
            expect(refused.reason).toBe("stalePath");
            expect(refused.pathEpochs.target.scope.equals(workspaceScope)).toBe(true);

            // Trimming the chain down to the target alone would make the two paths agree on
            // every entry they still share. The record refuses to exist, so a stale read
            // cannot be re-presented as a shorter one.
            expect(() => new PathEpochEvidence([store.epoch(workspaceScope)])).toThrow(
                new TypeError("Authority path must be an exact Tenant-to-target Scope chain")
            );
            expect(
                () =>
                    new PathEpochEvidence([
                        store.epoch(tenantScope),
                        store.epoch(siblingScope),
                        store.epoch(workspaceScope)
                    ])
            ).toThrow(TypeError);
        }
    );
});

describe.each(["memory", "sqlite"] as const)(
    "the invalidation watermark a stale observation advances: %s",
    (name) => {
        test(
            "[C13-ADV-MEDIATED-STALE] joins monotonically and refuses a non-dominating advance",
            { tags: "p0" },
            () => {
                const plane = planes[name]();
                const advanced = plane.joinOutsideSpan([new ScopeEpoch(workspaceScope, 2)]);
                expect(advanced.epoch(workspaceScope)).toBe(2);

                // A stale observation replaying an older delivery must not walk the holder
                // back to an epoch already delivered.
                const replayed = plane.joinOutsideSpan([new ScopeEpoch(workspaceScope, 1)]);
                expect(replayed.epoch(workspaceScope)).toBe(2);
                expect(replayed.revision.value).toBe(advanced.revision.value);
                expect(plane.committed()?.epoch(workspaceScope)).toBe(2);

                // The refusal, not a silently ignored write: the next revision carrying a
                // lower epoch is not a monotone advance and the plane rejects it.
                expect(() =>
                    plane.saveOutsideSpan(
                        new InvalidationWatermark(
                            tenantId,
                            workspaceActor,
                            holder,
                            [new ScopeEpoch(workspaceScope, 1)],
                            new Revision(advanced.revision.value + 1)
                        )
                    )
                ).toThrow(
                    expect.objectContaining({
                        code: "protocol.revision-conflict",
                        message: "Watermark updates require monotonic entries and the next revision"
                    })
                );
                // A dominating advance at a skipped revision is refused for the same reason,
                // so the two guards cannot be satisfied one at a time.
                expect(() =>
                    plane.saveOutsideSpan(
                        new InvalidationWatermark(
                            tenantId,
                            workspaceActor,
                            holder,
                            [new ScopeEpoch(workspaceScope, 3)],
                            new Revision(advanced.revision.value + 2)
                        )
                    )
                ).toThrow(expect.objectContaining({ code: "protocol.revision-conflict" }));
                expect(plane.committed()?.epoch(workspaceScope)).toBe(2);
                expect(plane.committed()?.revision.value).toBe(advanced.revision.value);
            }
        );

        test(
            "[C13-ADV-MEDIATED-STALE] a join whose span then fails leaves no advance behind",
            { tags: "p0" },
            () => {
                const plane = planes[name]();
                expect(plane.committed()?.epoch(workspaceScope)).toBe(0);

                // The control: the same join in a span that completes does commit, so the
                // rollback below is a rollback and not an advance that never happened.
                plane.span((join) => {
                    expect(join([new ScopeEpoch(workspaceScope, 1)]).epoch(workspaceScope)).toBe(1);
                });
                expect(plane.committed()?.epoch(workspaceScope)).toBe(1);
                const surviving = plane.committed()?.revision.value;

                expect(() =>
                    plane.span((join) => {
                        expect(
                            join([new ScopeEpoch(workspaceScope, 2)]).epoch(workspaceScope)
                        ).toBe(2);
                        throw new AgentCoreError(
                            "protocol.invalid-state",
                            "Injected denial-append failure"
                        );
                    })
                ).toThrow(expect.objectContaining({ message: "Injected denial-append failure" }));

                // Nothing of the failed observation is visible: not the epoch it delivered,
                // not the revision that delivery would have consumed.
                expect(plane.committed()?.epoch(workspaceScope)).toBe(1);
                expect(plane.committed()?.revision.value).toBe(surviving);
            }
        );
    }
);

describe.each(["memory", "sqlite"] as const)(
    "the durable target-local denial a stale mediated read commits: %s",
    (name) => {
        test(
            "[C13-AUTH-MEDIATED-STALE] commits the Receipt, its AuditRecord and the watermark join in one target-local transaction",
            { tags: "p0" },
            async () => {
                const harness = await staleDenialHarness(name);
                expect(harness.plane.committed()).toEqual({
                    receipts: [],
                    attempts: 0,
                    rootAudit: true,
                    denialAudit: false,
                    denialAuditByEvidence: false,
                    watermarkEpoch: 0,
                    watermarkRevision: 0
                });

                await expect(harness.authorizeMediated()).rejects.toMatchObject({
                    code: "authority.denied",
                    message: "Mediated authority intent is stale"
                });

                // One commit carries all three: the denied Receipt, the AuditRecord caused by
                // the invocation root, and the advanced watermark. The audit's own edge check
                // is what proves the Receipt was durable first and carries no EffectAttempt —
                // src/invocations/audit.ts refuses an invocation -> receipt edge whose Receipt
                // the transaction cannot read, or whose Receipt names an attempt.
                expect(harness.plane.committed()).toEqual({
                    receipts: [DENIAL_RECEIPT_ID.value],
                    attempts: 0,
                    rootAudit: true,
                    denialAudit: true,
                    denialAuditByEvidence: true,
                    watermarkEpoch: 1,
                    watermarkRevision: 1
                });
                const receipt = harness.plane.denialReceipt();
                expect(receipt?.outcome).toBe("deniedPreEffect");
                expect(receipt?.variant).toBe("preEffect");
                const audit = harness.plane.denialAuditRecord();
                expect(audit?.cause?.equals(ROOT_AUDIT_ID)).toBe(true);
                expect(audit?.kind.kind).toBe("receipt");
            }
        );

        test(
            "[C13-AUTH-MEDIATED-STALE] refuses the denial AuditRecord unless its Receipt is already durable in the same span",
            { tags: "p0" },
            async () => {
                const harness = await staleDenialHarness(name);
                harness.failure = "auditFirst";

                // The audit edge is substantiated out of the durable Receipt ledger, so
                // appending the AuditRecord first cannot be admitted: there is no Receipt in
                // this transaction for the invocation root to have caused.
                await expect(harness.authorizeMediated()).rejects.toMatchObject({
                    code: "invocation.invalid",
                    failure: "audit.evidence-mismatch",
                    message: "Audit edge invocation -> receipt is not permitted"
                });
                expect(harness.plane.committed()).toEqual({
                    receipts: [],
                    attempts: 0,
                    rootAudit: true,
                    denialAudit: false,
                    denialAuditByEvidence: false,
                    watermarkEpoch: 0,
                    watermarkRevision: 0
                });
            }
        );

        test.each(["afterReceipt", "afterAudit"] as const)(
            "[C13-AUTH-MEDIATED-STALE] a failure %s leaves no Receipt, no AuditRecord and no watermark advance",
            { tags: "p0" },
            async (failure) => {
                const harness = await staleDenialHarness(name);
                harness.failure = failure;

                await expect(harness.authorizeMediated()).rejects.toThrow(
                    /Injected durable denial failure/u
                );

                // Nothing of the observation survived, and the audit root that predates it is
                // untouched — so the span rolled back rather than the writes never running.
                expect(harness.plane.committed()).toEqual({
                    receipts: [],
                    attempts: 0,
                    rootAudit: true,
                    denialAudit: false,
                    denialAuditByEvidence: false,
                    watermarkEpoch: 0,
                    watermarkRevision: 0
                });
            }
        );

        test(
            "[C13-AUTH-MEDIATED-STALE] [C13-ADV-MEDIATED-STALE] advances the watermark strictly before it appends the denial",
            { tags: "p0" },
            async () => {
                const harness = await staleDenialHarness(name);

                await expect(harness.authorizeMediated()).rejects.toMatchObject({
                    code: "authority.denied"
                });

                // The clause is an ORDER, so it is asserted as one. Nothing read after the
                // commit could tell this from the reverse, which is why both seams are
                // observed as they are called instead.
                expect(harness.order).toEqual(["watermark.save", "appendDenial"]);
                // And the order is not an artefact of a half-finished span: both writes are
                // durable afterwards, so this is the committed sequence rather than a partial.
                expect(harness.plane.committed()).toMatchObject({
                    attempts: 0,
                    denialAudit: true,
                    watermarkEpoch: 1
                });
            }
        );
    }
);

/** A bootstrapped Tenant holding one Workspace, one allow Grant, and the Binding it backs. */
function fixture() {
    const anchor = {
        actorId: tenantActor.id,
        tenantId,
        principalId,
        trustAnchor: Uint8Array.of(9, 9, 9)
    };
    const store = MemoryTenantControlStore.create(anchor);
    store.bootstrapTenant(anchor, Revision.initial());
    const service = new AuthorityMutationService(store);
    service.createWorkspace(new Workspace(workspaceId, tenantId, undefined, Revision.initial()));
    service.createGrant(grant(boundGrantId.value, workspaceScope));
    const binding = Binding.active(
        workspaceScope,
        subject,
        domain,
        bindingName,
        boundGrantId,
        facet
    );
    service.createBinding(binding);
    const runtime = new TenantAuthorityRuntime(store, tenantActor);
    // The Binding write advanced the Workspace epoch; taking the path after it means every
    // later advance in a test is the one that test caused.
    runtime.validateBinding(
        new BindingValidationRequest({
            ownerTenant: tenantId,
            workspaceActor,
            workspaceFence: 1,
            scope: workspaceScope,
            domain,
            name: bindingName,
            grantId: boundGrantId,
            facet,
            nonce: "mediated-stale-validation"
        }),
        new Date(500)
    );
    return { store, service, runtime, binding };
}

function currentPath(store: MemoryTenantControlStore): PathEpochEvidence {
    return new PathEpochEvidence([store.epoch(tenantScope), store.epoch(workspaceScope)]);
}

function grant(id: string, scope: ScopeRef): Grant {
    return new Grant(new GrantId(id), scope, subject, "allow", capability, { kind: "direct" });
}

function checkRequest(expectedPath: PathEpochEvidence): AuthorityCheckRequest {
    return new AuthorityCheckRequest({
        ownerTenant: tenantId,
        owner: workspaceActor,
        ownerFence: 1,
        principal: holder,
        binding: Binding.active(workspaceScope, subject, domain, bindingName, boundGrantId, facet),
        intent: {
            facet,
            operation: "read",
            impact: "observe",
            arguments: argumentsValue,
            argumentsDigest
        },
        expectedPath,
        invocationDigest: Digest.sha256(Uint8Array.of(4)),
        itemIndex: 0,
        attemptOrdinal: 0,
        nonce: "mediated-stale-check"
    });
}

const DENIAL_INVOCATION = new InvocationId("mediated-stale-invocation");
const DENIAL_CORRELATION = new CorrelationId("mediated-stale-correlation");
const ROOT_AUDIT_ID = new AuditRecordId("mediated-stale-invocation-root");
const DENIAL_RECEIPT_ID = new ReceiptId("mediated-stale-denied");
const DENIAL_AUDIT_ID = new AuditRecordId("mediated-stale-denied-audit");
const DENIAL_KIND = Object.freeze({
    kind: "receipt" as const,
    id: DENIAL_RECEIPT_ID,
    outcome: "deniedPreEffect" as const
});
const RESOLVED_AT = 1_000_000;
const LEASE_EXPIRY = RESOLVED_AT + 5_000;
const DIRECT_WINDOW_MS = 2_000;
const denialSchema = new JsonSchema({ type: "object" });
const readDescriptor = new OperationDescriptor(
    new OperationName("read"),
    "observe",
    denialSchema,
    denialSchema
);
const readInputs: readonly FacetData[] = [{ channel: "internal" }];

/** What the target Actor's durable state holds after a span commits or rolls back. */
interface DenialCommit {
    readonly receipts: readonly string[];
    readonly attempts: number;
    readonly rootAudit: boolean;
    readonly denialAudit: boolean;
    readonly denialAuditByEvidence: boolean;
    readonly watermarkEpoch: number;
    readonly watermarkRevision: number;
}

/**
 * One target-local durable plane: the holder watermark, the Receipt ledger, and the
 * AuditRecord chain, all reached through the one Actor transaction `span` opens. Reads
 * outside a span answer from committed state, because the resolver asks for the current
 * watermark before any transaction exists.
 */
/**
 * §3.4 rule 7 says the join happens BEFORE the pre-effect denial. Both writes land in one
 * Actor transaction, so nothing read AFTER the commit can tell the required order from the
 * reverse — which is why this is observed AT the two seams instead. Both are interfaces the
 * host supplies, so recording the order needs no production seam and no widened contract:
 * this decorator delegates every call to the real store and notes when the watermark's
 * durable advance happens, and the harness notes when the denial is appended.
 */
class OrderedWatermarkStore implements InvalidationWatermarkStore {
    public constructor(
        private readonly inner: InvalidationWatermarkStore,
        private readonly order: string[]
    ) {}

    public load(key: string): InvalidationWatermark | undefined {
        return this.inner.load(key);
    }

    public save(watermark: InvalidationWatermark): void {
        this.inner.save(watermark);
        this.order.push("watermark.save");
    }

    public join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark {
        const joined = this.inner.join(key, entries);
        this.order.push("watermark.join");
        return joined;
    }
}

interface DenialPlane {
    readonly watermarks: InvalidationWatermarkStore;
    seedAuditRoot(): void;
    span<Result>(operation: () => Result): Result;
    appendDenial(receipt: PreEffectReceipt, audit: AuditRecord): void;
    appendReceiptOnly(receipt: PreEffectReceipt): void;
    appendAuditOnly(audit: AuditRecord): void;
    committed(): DenialCommit;
    denialReceipt(): PreEffectReceipt | undefined;
    denialAuditRecord(): AuditRecord | undefined;
}

interface DenialActorState {
    watermarks: readonly WatermarkRecord[];
    invocations: InvocationMemoryState;
    mediation: InvocationMediationMemoryState;
}

/**
 * The audit edge an invocation root to a pre-effect Receipt is admitted by, resolved out
 * of the durable Receipt ledger rather than out of the record in flight — so the edge is
 * substantiated only if the Receipt is already readable in this transaction.
 */
function durableReceiptEvidence(
    lookup: (id: ReceiptId) => Receipt | undefined
): AuditEvidenceResolver {
    return {
        approval: () => undefined,
        attempt: () => undefined,
        receipt: (id) => {
            const record = lookup(id);
            return record instanceof PreEffectReceipt
                ? { invocation: record.invocation, outcome: record.outcome }
                : undefined;
        },
        event: () => undefined,
        route: () => undefined,
        projection: () => undefined,
        delivery: () => undefined,
        commit: () => undefined,
        write: () => undefined
    };
}

function auditRoot(): AuditRecord {
    return new AuditRecord({
        id: ROOT_AUDIT_ID,
        actor: workspaceActor,
        tenant: tenantId,
        correlation: DENIAL_CORRELATION,
        kind: { kind: "invocation", id: DENIAL_INVOCATION }
    });
}

function memoryDenialPlane(): DenialPlane {
    const seeded = new MemoryInvalidationWatermarkStore(tenantId, workspaceActor);
    seeded.save(emptyWatermark);
    const receipts = new MemoryInvocationPersistence(invocationCodecs);
    const audits = new MemoryInvocationMediationPersistence();
    const actors = new MemoryActorStore<DenialActorState>(
        {
            watermarks: seeded.snapshot().records.map(copyRecord),
            invocations: createInvocationMemoryState(),
            mediation: createInvocationMediationMemoryState()
        },
        (value) => ({
            watermarks: value.watermarks.map(copyRecord),
            invocations: cloneInvocationMemoryState(value.invocations),
            mediation: cloneInvocationMediationMemoryState(value.mediation)
        })
    );
    let active: DenialActorState | undefined;
    const open = (records: readonly WatermarkRecord[]): MemoryInvalidationWatermarkStore =>
        new MemoryInvalidationWatermarkStore(tenantId, workspaceActor, { version: 1, records });
    const inSpan = (): DenialActorState => {
        if (active === undefined) {
            throw new TypeError("Denial plane writes require the open Actor span");
        }
        return active;
    };
    const read = <Result>(operation: (state: DenialActorState) => Result): Result =>
        active === undefined ? operation(actors.snapshot().state) : operation(active);
    return {
        watermarks: {
            load: (key) => read((state) => open(state.watermarks).load(key)),
            save: (watermark) => {
                const state = inSpan();
                const store = open(state.watermarks);
                store.save(watermark);
                state.watermarks = store.snapshot().records.map(copyRecord);
            },
            join: (key, entries) => {
                const state = inSpan();
                const store = open(state.watermarks);
                const joined = store.join(key, entries);
                state.watermarks = store.snapshot().records.map(copyRecord);
                return joined;
            }
        },
        seedAuditRoot(): void {
            actors.transaction((state) => {
                audits.appendAudit(state.mediation, auditRoot());
                return undefined;
            });
        },
        span<Result>(operation: () => Result): Result {
            // The Actor store proves synchronicity through a phantom guard tuple its
            // caller supplies. A generic Result cannot supply one, so the result is
            // carried out of a void transaction after the same check the store makes.
            let outcome: { readonly value: Result } | undefined;
            actors.transaction((state) => {
                active = state;
                try {
                    outcome = { value: requireSynchronousResult(operation()) };
                } finally {
                    active = undefined;
                }
                return undefined;
            });
            if (outcome === undefined) throw new TypeError("Denial span produced no result");
            return outcome.value;
        },
        appendDenial(receipt, audit): void {
            this.appendReceiptOnly(receipt);
            this.appendAuditOnly(audit);
        },
        appendReceiptOnly(receipt): void {
            receipts.appendReceipt(inSpan().invocations, receipt);
        },
        appendAuditOnly(audit): void {
            const state = inSpan();
            audits.appendAudit(state.mediation, audit, {
                evidence: durableReceiptEvidence((id) => receipts.receipt(state.invocations, id))
            });
        },
        committed(): DenialCommit {
            return read((state) =>
                denialCommit(
                    receipts.receiptsForItem(state.invocations, DENIAL_INVOCATION, 0),
                    receipts.attemptsForItem(state.invocations, DENIAL_INVOCATION, 0).length,
                    audits.audit(state.mediation, ROOT_AUDIT_ID),
                    audits.audit(state.mediation, DENIAL_AUDIT_ID),
                    audits.findAuditByEvidence(state.mediation, workspaceActor, DENIAL_KIND),
                    open(state.watermarks).load(watermarkRecordKey)
                )
            );
        },
        denialReceipt(): PreEffectReceipt | undefined {
            return read((state) => {
                const record = receipts.receipt(state.invocations, DENIAL_RECEIPT_ID);
                return record instanceof PreEffectReceipt ? record : undefined;
            });
        },
        denialAuditRecord(): AuditRecord | undefined {
            return read((state) => audits.audit(state.mediation, DENIAL_AUDIT_ID));
        }
    };
}

function sqliteDenialPlane(): DenialPlane {
    const database = new TestSqlite();
    const actors = new SqliteActorStore(database);
    const watermarks = new SqliteInvalidationWatermarkStore(database, tenantId, workspaceActor);
    watermarks.save(emptyWatermark);
    const receipts = createSqliteInvocationPersistence(database);
    const audits = new SqliteInvocationMediationPersistence(
        database,
        new SqliteProtocolPersistence(database)
    );
    let active: TransactionalSqlite | undefined;
    const inSpan = (): TransactionalSqlite => {
        if (active === undefined) {
            throw new TypeError("Denial plane writes require the open Actor span");
        }
        return active;
    };
    const read = <Result>(operation: (transaction: TransactionalSqlite) => Result): Result =>
        active === undefined
            ? runSynchronousSqliteTransaction(database, () => operation(database))
            : operation(active);
    return {
        watermarks: {
            load: (key) =>
                active === undefined
                    ? watermarks.load(key)
                    : watermarks.loadInTransaction(active, key),
            save: (watermark) => watermarks.saveInTransaction(inSpan(), watermark),
            join: (key, entries) => watermarks.joinInTransaction(inSpan(), key, entries)
        },
        seedAuditRoot(): void {
            actors.transact((transaction) => {
                audits.appendAudit(transaction, auditRoot());
                return undefined;
            });
        },
        span<Result>(operation: () => Result): Result {
            return actors.transact((transaction) => {
                active = transaction;
                try {
                    return operation();
                } finally {
                    active = undefined;
                }
            });
        },
        appendDenial(receipt, audit): void {
            this.appendReceiptOnly(receipt);
            this.appendAuditOnly(audit);
        },
        appendReceiptOnly(receipt): void {
            receipts.appendReceipt(inSpan(), receipt);
        },
        appendAuditOnly(audit): void {
            const transaction = inSpan();
            audits.appendAudit(transaction, audit, {
                evidence: durableReceiptEvidence((id) => receipts.receipt(transaction, id))
            });
        },
        committed(): DenialCommit {
            return read((transaction) =>
                denialCommit(
                    receipts.receiptsForItem(transaction, DENIAL_INVOCATION, 0),
                    receipts.attemptsForItem(transaction, DENIAL_INVOCATION, 0).length,
                    audits.audit(transaction, ROOT_AUDIT_ID),
                    audits.audit(transaction, DENIAL_AUDIT_ID),
                    audits.findAuditByEvidence(transaction, workspaceActor, DENIAL_KIND),
                    watermarks.load(watermarkRecordKey)
                )
            );
        },
        denialReceipt(): PreEffectReceipt | undefined {
            return read((transaction) => {
                const record = receipts.receipt(transaction, DENIAL_RECEIPT_ID);
                return record instanceof PreEffectReceipt ? record : undefined;
            });
        },
        denialAuditRecord(): AuditRecord | undefined {
            return read((transaction) => audits.audit(transaction, DENIAL_AUDIT_ID));
        }
    };
}

function denialCommit(
    receipts: readonly Receipt[],
    attempts: number,
    rootAudit: AuditRecord | undefined,
    denialAudit: AuditRecord | undefined,
    byEvidence: AuditRecord | undefined,
    watermark: InvalidationWatermark | undefined
): DenialCommit {
    return {
        receipts: receipts.map((receipt) => receipt.id.value),
        attempts,
        rootAudit: rootAudit !== undefined,
        denialAudit: denialAudit !== undefined,
        denialAuditByEvidence: byEvidence !== undefined,
        watermarkEpoch: watermark?.epoch(workspaceScope) ?? 0,
        watermarkRevision: watermark?.revision.value ?? 0
    };
}

const denialPlanes = {
    memory: memoryDenialPlane,
    sqlite: sqliteDenialPlane
} as const;

/**
 * The production `ActorAuthorityState` over a real durable plane. Everything the port
 * needs that is not authority — how a candidate is built, where the lease lives, which
 * policy admits — is host data; the denial write and the transaction it belongs to are
 * the plane's, so `observeStale` is the only thing under test.
 */
class StaleDenialHarness implements ActorAuthorityHost {
    public readonly order: string[] = [];
    public readonly state: ActorAuthorityState;
    public readonly authority: TenantOperationAuthority<PrincipalRef>;
    public failure: "none" | "afterReceipt" | "afterAudit" | "auditFirst" = "none";
    public path = new PathEpochEvidence([
        ScopeEpoch.initial(tenantScope),
        ScopeEpoch.initial(workspaceScope)
    ]);
    public readonly binding = Binding.active(
        workspaceScope,
        subject,
        domain,
        bindingName,
        boundGrantId,
        facet
    );
    readonly #lease = TurnLease.restore(
        new TurnId("mediated-stale-turn"),
        holder,
        1,
        new Date(LEASE_EXPIRY)
    );
    readonly #token: LeaseToken = { turn: this.#lease.turn, holder, epoch: 1 };
    readonly #now = new Date(RESOLVED_AT);

    public constructor(public readonly plane: DenialPlane) {
        this.state = new ActorAuthorityState(
            tenantId,
            workspaceActor,
            new OrderedWatermarkStore(plane.watermarks, this.order),
            this,
            () => this.#now
        );
        this.authority = new TenantOperationAuthority(this.state, () => this.#now);
    }

    public resolve(caller: PrincipalRef): OperationResolutionCandidate | undefined {
        if (!caller.equals(holder)) return undefined;
        return {
            principal: holder,
            binding: this.binding,
            pathEpochs: this.path,
            watermark: this.state.currentWatermark(holder),
            lease: this.#token,
            originalLease: this.#lease,
            route: undefined,
            package: new PackagePin(
                new PackageId("mediated-stale-package"),
                new SemVer("1.0.0"),
                new Digest("d".repeat(64)),
                new Digest("d".repeat(64))
            ),
            placement: new InvocationPlacementPin({
                manifest: ["bundled"],
                policy: ["bundled"],
                substrate: ["bundled"],
                trust: ["bundled"],
                selected: "bundled"
            }),
            owner: workspaceActor,
            policies: [new PolicySet({ maxDirectRevocationWindowMs: DIRECT_WINDOW_MS })],
            turnOwnedSession: true,
            sessionFilesystemTarget: false,
            turnActorAuthorityLocal: true,
            directAuthority: new ResolvedOperationAuthority(facet, [
                new CapabilitySpec({
                    facetPattern: facet.value,
                    operations: ["read"],
                    impacts: ["observe"],
                    argumentConstraints: { channel: "internal" }
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

    public currentLease(token: LeaseToken): TurnLease | undefined {
        return token.turn.equals(this.#lease.turn) ? this.#lease : undefined;
    }

    public admits(): boolean {
        return true;
    }

    public contributorDomain(): ProtectionDomain | undefined {
        return domain;
    }

    public admitsInterception(): boolean {
        return true;
    }

    public transaction<Result>(operation: () => Result): Result {
        return this.plane.span(operation);
    }

    public denialEvidence() {
        return {
            receipt: new PreEffectReceipt(
                DENIAL_RECEIPT_ID,
                DENIAL_INVOCATION,
                0,
                "deniedPreEffect",
                this.#now,
                "Mediated authority intent is stale"
            ),
            audit: new AuditRecord({
                id: DENIAL_AUDIT_ID,
                actor: workspaceActor,
                tenant: tenantId,
                correlation: DENIAL_CORRELATION,
                cause: ROOT_AUDIT_ID,
                kind: DENIAL_KIND
            })
        };
    }

    public appendDenial(receipt: PreEffectReceipt, audit: AuditRecord): void {
        this.order.push("appendDenial");
        if (this.failure === "auditFirst") {
            this.plane.appendAuditOnly(audit);
            return;
        }
        if (this.failure === "afterReceipt") {
            this.plane.appendReceiptOnly(receipt);
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Injected durable denial failure after the Receipt"
            );
        }
        this.plane.appendDenial(receipt, audit);
        if (this.failure === "afterAudit") {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Injected durable denial failure after the AuditRecord"
            );
        }
    }

    public async authorizeMediated(): Promise<void> {
        const resolved = await this.authority.resolve(holder, bindingName);
        // The Workspace epoch advances after the resolution was handed out, which is the
        // one thing that makes the mediated re-check stale.
        this.path = new PathEpochEvidence([
            ScopeEpoch.initial(tenantScope),
            new ScopeEpoch(workspaceScope, 1)
        ]);
        await this.authority.authorizeMediated(resolved.resolution, readDescriptor, readInputs);
    }
}

async function staleDenialHarness(name: "memory" | "sqlite"): Promise<StaleDenialHarness> {
    const harness = new StaleDenialHarness(denialPlanes[name]());
    harness.plane.seedAuditRoot();
    return harness;
}
