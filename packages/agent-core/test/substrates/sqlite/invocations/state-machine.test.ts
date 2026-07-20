import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc, { type Command } from "fast-check";
import { expect, test } from "vitest";
import type { SynchronousResultGuard } from "../../../../src/actors";
import { ContentRef, Digest } from "../../../../src/core";
import { AgentCoreError } from "../../../../src/errors";
import { TenantId } from "../../../../src/identity";
import {
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    ClaimWorkerId,
    CorrelationId,
    EffectAttempt,
    EffectAttemptId,
    InvocationId,
    InvocationPublicationOutbox,
    ItemClaim,
    ItemClaimId,
    MemoryInvocationMediationPersistence,
    MemoryInvocationPersistence,
    ReceiptId,
    cloneInvocationMediationMemoryState,
    cloneInvocationMemoryState,
    createInvocationMediationMemoryState,
    createInvocationMemoryState,
    type AttemptReceiptOutcome,
    type InvocationEvidencePersistence,
    type InvocationLedger,
    type InvocationMediationMemoryState,
    type InvocationMemoryState,
    type Receipt,
    type PreparedInvocation
} from "../../../../src/invocations";
import {
    SqliteProtocolPersistence,
    type TransactionalSqlite
} from "../../../../src/substrates/sqlite";
import { SqliteInvocationMediationPersistence } from "../../../../src/substrates/sqlite/invocations";
import { FileSqlite } from "../../../helpers/sqlite";
import {
    admissionFor,
    createLedger,
    invocationCodecs,
    prepared,
    type TestPersistence
} from "../../../invocations/fixture";
import { createSqliteInvocationPersistence } from "./fixture";

type TestLedger<Transaction> = InvocationLedger<
    Transaction,
    string,
    string,
    string,
    string,
    string
>;

type MemoryState = InvocationMemoryState & InvocationMediationMemoryState;

interface ClaimState {
    readonly id: string;
    readonly ordinal: number;
    readonly worker: string;
    readonly expiresAt: number;
}

interface AttemptState {
    readonly id: string;
    readonly claim: string;
    readonly ordinal: number;
    readonly audit: string;
    readonly startedAt: number;
}

interface ReceiptState {
    readonly id: string;
    readonly attempt: string;
    readonly outcome: AttemptReceiptOutcome;
    readonly audit: string;
    readonly recordedAt: number;
}

interface InvocationModel {
    prepared: boolean;
    now: number;
    nextClaim: number;
    nextAttempt: number;
    nextReceipt: number;
    claims: ClaimState[];
    attempts: AttemptState[];
    receipts: ReceiptState[];
    audits: string[];
    coverage: Set<CoverageHit>;
}

type CoverageHit =
    "prepare" | "claim" | "recover" | "admit" | "receipt" | "retry" | "restart" | "rejection";

type AttemptMutation =
    | "exact"
    | "wrongClaim"
    | "wrongToken"
    | "wrongAdmission"
    | "wrongItemKey"
    | "wrongAuditCause"
    | "futureStart";

type RecoveryMutation = "exact" | "wrongInvocation" | "wrongItem" | "wrongOrdinal" | "wrongToken";

type ReceiptMutation =
    | "exact"
    | "wrongAttempt"
    | "wrongAttemptAudit"
    | "wrongReceiptCause"
    | "wrongPublicationReceipt"
    | "wrongPublicationAudit";

interface Observation {
    readonly prepared: ReturnType<typeof projectPrepared> | undefined;
    readonly claims: readonly ReturnType<typeof projectClaim>[];
    readonly attempts: readonly ReturnType<typeof projectAttempt>[];
    readonly receipts: readonly ReturnType<typeof projectReceipt>[];
    readonly currentReceipt: ReturnType<typeof projectReceipt> | undefined;
    readonly batchOutcome: string | undefined;
    readonly audits: readonly ReturnType<typeof projectAudit>[];
    readonly publications: readonly ReturnType<typeof projectPublication>[];
}

interface InvocationRuntime {
    prepare(record: PreparedInvocation<string, string, string, string>, audit: AuditRecord): void;
    claim(claim: ItemClaim<string>, now: Date): void;
    recover(previous: ItemClaimId, replacement: ItemClaim<string>, now: Date): void;
    admit(attempt: EffectAttempt<string, string>, now: Date, audit: AuditRecord): void;
    recordReceipt(
        receipt: AttemptReceipt,
        attemptAudit: AuditRecord,
        receiptAudit: AuditRecord,
        publication: InvocationPublicationOutbox
    ): void;
    observe(audits: readonly string[]): Observation;
    hasClaim(id: ItemClaimId): boolean;
    hasAttempt(id: EffectAttemptId): boolean;
    hasReceipt(id: ReceiptId): boolean;
    hasAudit(id: AuditRecordId): boolean;
    hasPublication(id: Digest): boolean;
    restart(): void;
    dispose(): void;
}

class DualRuntime {
    readonly #memory = new MemoryRuntime();
    readonly #sqlite = new SqliteRuntime();

    public transition(operation: (runtime: InvocationRuntime) => void): TransitionOutcome {
        const memory = capture(() => operation(this.#memory));
        const sqlite = capture(() => operation(this.#sqlite));
        expect(sqlite).toEqual(memory);
        return memory;
    }

    public assertState(model: Readonly<InvocationModel>): void {
        const expected = expectedObservation(model);
        const memory = this.#memory.observe(model.audits);
        const sqlite = this.#sqlite.observe(model.audits);
        expect(sqlite).toEqual(memory);
        expect(memory).toEqual(expected);
    }

    public observations(audits: readonly string[]): readonly [Observation, Observation] {
        return [this.#memory.observe(audits), this.#sqlite.observe(audits)];
    }

    public expectAuditAbsent(id: AuditRecordId): void {
        expect(this.#memory.hasAudit(id)).toBe(false);
        expect(this.#sqlite.hasAudit(id)).toBe(false);
    }

    public expectClaimAbsent(id: ItemClaimId): void {
        expect(this.#memory.hasClaim(id)).toBe(false);
        expect(this.#sqlite.hasClaim(id)).toBe(false);
    }

    public expectAttemptAbsent(id: EffectAttemptId): void {
        expect(this.#memory.hasAttempt(id)).toBe(false);
        expect(this.#sqlite.hasAttempt(id)).toBe(false);
    }

    public expectReceiptAbsent(id: ReceiptId): void {
        expect(this.#memory.hasReceipt(id)).toBe(false);
        expect(this.#sqlite.hasReceipt(id)).toBe(false);
    }

    public expectPublicationAbsent(id: Digest): void {
        expect(this.#memory.hasPublication(id)).toBe(false);
        expect(this.#sqlite.hasPublication(id)).toBe(false);
    }

    public restart(): void {
        this.#memory.restart();
        this.#sqlite.restart();
    }

    public dispose(): void {
        this.#memory.dispose();
        this.#sqlite.dispose();
    }
}

abstract class Runtime<Transaction> implements InvocationRuntime {
    protected abstract readonly persistence: TestPersistence<Transaction>;
    protected abstract readonly evidence: InvocationEvidencePersistence<Transaction>;
    protected abstract readonly ledger: TestLedger<Transaction>;
    protected abstract transaction<Result>(operation: (transaction: Transaction) => Result): Result;

    public prepare(
        record: PreparedInvocation<string, string, string, string>,
        audit: AuditRecord
    ): void {
        this.transaction((transaction) =>
            this.ledger.prepareWithAudit(transaction, record, audit, this.evidence)
        );
    }

    public claim(claim: ItemClaim<string>, now: Date): void {
        this.transaction((transaction) => this.ledger.claimItem(transaction, claim, now));
    }

    public recover(previous: ItemClaimId, replacement: ItemClaim<string>, now: Date): void {
        this.transaction((transaction) =>
            this.ledger.recoverClaim(transaction, previous, replacement, now)
        );
    }

    public admit(attempt: EffectAttempt<string, string>, now: Date, audit: AuditRecord): void {
        this.transaction((transaction) =>
            this.ledger.admitAttemptWithAudit(transaction, attempt, now, audit, this.evidence)
        );
    }

    public recordReceipt(
        receipt: AttemptReceipt,
        attemptAudit: AuditRecord,
        receiptAudit: AuditRecord,
        publication: InvocationPublicationOutbox
    ): void {
        this.transaction((transaction) =>
            this.ledger.recordAttemptReceiptWithAudit(
                transaction,
                receipt,
                attemptAudit,
                receiptAudit,
                publication,
                this.evidence
            )
        );
    }

    public observe(audits: readonly string[]): Observation {
        return this.transaction((transaction) =>
            observe(transaction, this.persistence, this.evidence, this.ledger, audits)
        );
    }

    public hasAudit(id: AuditRecordId): boolean {
        return this.transaction(
            (transaction) => this.evidence.audit(transaction, id) !== undefined
        );
    }

    public hasClaim(id: ItemClaimId): boolean {
        return this.transaction(
            (transaction) => this.persistence.claim(transaction, id) !== undefined
        );
    }

    public hasAttempt(id: EffectAttemptId): boolean {
        return this.transaction(
            (transaction) => this.persistence.attempt(transaction, id) !== undefined
        );
    }

    public hasReceipt(id: ReceiptId): boolean {
        return this.transaction(
            (transaction) => this.persistence.receipt(transaction, id) !== undefined
        );
    }

    public hasPublication(id: Digest): boolean {
        return this.transaction(
            (transaction) => this.evidence.publication(transaction, id) !== undefined
        );
    }

    public abstract restart(): void;
    public abstract dispose(): void;
}

class MemoryRuntime extends Runtime<MemoryState> {
    protected persistence = new MemoryInvocationPersistence(invocationCodecs);
    protected evidence = new MemoryInvocationMediationPersistence();
    protected ledger: TestLedger<MemoryState> = createLedger(this.persistence);
    #state = createMemoryState();

    protected transaction<Result>(operation: (transaction: MemoryState) => Result): Result {
        const draft = cloneMemoryState(this.#state);
        const result = operation(draft);
        this.#state = cloneMemoryState(draft);
        return result;
    }

    public restart(): void {
        this.#state = cloneMemoryState(this.#state);
        this.persistence = new MemoryInvocationPersistence(invocationCodecs);
        this.evidence = new MemoryInvocationMediationPersistence();
        this.ledger = createLedger(this.persistence);
    }

    public dispose(): void {}
}

class SqliteRuntime extends Runtime<TransactionalSqlite> {
    readonly #directory = mkdtempSync(join(tmpdir(), "agent-core-invocation-model-"));
    readonly #path = join(this.#directory, "ledger.sqlite");
    #database = new FileSqlite(this.#path);
    protected persistence = createSqliteInvocationPersistence(this.#database);
    #audits = new SqliteProtocolPersistence(this.#database);
    protected evidence = new SqliteInvocationMediationPersistence(this.#database, this.#audits);
    protected ledger: TestLedger<TransactionalSqlite> = createLedger(this.persistence);

    protected transaction<Result>(operation: (transaction: TransactionalSqlite) => Result): Result {
        return this.#database.transaction(
            () => operation(this.#database),
            ...([] as SynchronousResultGuard<Result>)
        );
    }

    public restart(): void {
        this.#database.close();
        this.#database = new FileSqlite(this.#path);
        this.persistence = createSqliteInvocationPersistence(this.#database);
        this.#audits = new SqliteProtocolPersistence(this.#database);
        this.evidence = new SqliteInvocationMediationPersistence(this.#database, this.#audits);
        this.ledger = createLedger(this.persistence);
    }

    public dispose(): void {
        this.#database.close();
        rmSync(this.#directory, { recursive: true, force: true });
    }
}

test(
    "generated InvocationLedger histories preserve exact records, outbox evidence, and test-audit state across memory and SQLite restarts",
    { tags: "p0", timeout: 30_000 },
    () => {
        runRequiredLifecycle();
        const generatedCoverage = new Set<CoverageHit>();
        runGeneratedReachableLifecycles(generatedCoverage);

        const ttl = fc.integer({ min: 0, max: 12 });
        const worker = fc.integer({ min: 0, max: 3 });
        const ordinalOffset = fc.integer({ min: -1, max: 1 });
        const histories = fc.commands<InvocationModel, DualRuntime>(
            [
                fc.constant(new Prepare()),
                fc
                    .tuple(ttl, worker, ordinalOffset)
                    .map(([duration, owner, offset]) => new Claim(duration, owner, offset)),
                fc.integer({ min: 0, max: 12 }).map((elapsed) => new AdvanceTime(elapsed)),
                fc
                    .tuple(
                        ttl,
                        worker,
                        fc.constantFrom<RecoveryMutation>(
                            "exact",
                            "wrongInvocation",
                            "wrongItem",
                            "wrongOrdinal",
                            "wrongToken"
                        )
                    )
                    .map(([duration, owner, mutation]) => new Recover(duration, owner, mutation)),
                fc
                    .constantFrom<AttemptMutation>(
                        "exact",
                        "wrongClaim",
                        "wrongToken",
                        "wrongAdmission",
                        "wrongItemKey",
                        "wrongAuditCause",
                        "futureStart"
                    )
                    .map((mutation) => new Admit(mutation)),
                fc
                    .tuple(
                        fc.constantFrom<AttemptReceiptOutcome>(
                            "succeeded",
                            "failed",
                            "indeterminate"
                        ),
                        fc.constantFrom<ReceiptMutation>(
                            "exact",
                            "wrongAttempt",
                            "wrongAttemptAudit",
                            "wrongReceiptCause",
                            "wrongPublicationReceipt",
                            "wrongPublicationAudit"
                        )
                    )
                    .map(([outcome, mutation]) => new RecordReceipt(outcome, mutation)),
                fc
                    .tuple(ttl, worker, ordinalOffset)
                    .map(([duration, owner, offset]) => new RetryClaim(duration, owner, offset)),
                fc.constant(new Restart())
            ],
            { maxCommands: 80 }
        );
        fc.assert(
            fc.property(histories, (history) => {
                const runtime = new DualRuntime();
                try {
                    fc.modelRun(
                        () => ({ model: initialModel(generatedCoverage), real: runtime }),
                        history
                    );
                } finally {
                    runtime.dispose();
                }
            }),
            { numRuns: 200 }
        );
        expect([...generatedCoverage].sort()).toEqual([...requiredCoverage].sort());
    }
);

function runGeneratedReachableLifecycles(coverage: Set<CoverageHit>): void {
    const workerPair = fc
        .tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 }))
        .filter(([initial, recovered]) => initial !== recovered);
    fc.assert(
        fc.property(
            fc.integer({ min: 1, max: 12 }),
            fc.integer({ min: 1, max: 12 }),
            fc.integer({ min: 1, max: 12 }),
            workerPair,
            fc.integer({ min: 0, max: 2 }),
            (claimTtl, recoveryTtl, retryTtl, [initialWorker, recoveryWorker], retryWorker) => {
                const model = initialModel(coverage);
                const runtime = new DualRuntime();
                const commands: readonly Command<InvocationModel, DualRuntime>[] = [
                    new Prepare(),
                    new Claim(claimTtl, initialWorker, 0),
                    new Claim(claimTtl, recoveryWorker, 0),
                    new AdvanceTime(claimTtl),
                    new Recover(recoveryTtl, recoveryWorker),
                    new Admit(),
                    new RecordReceipt("failed"),
                    new RetryClaim(retryTtl, retryWorker, 0),
                    new Admit(),
                    new RecordReceipt("succeeded"),
                    new Restart()
                ];
                try {
                    for (const command of commands) {
                        expect(command.check(model)).toBe(true);
                        command.run(model, runtime);
                    }
                } finally {
                    runtime.dispose();
                }
            }
        ),
        { numRuns: 50 }
    );
}

class Prepare implements Command<InvocationModel, DualRuntime> {
    public check(): boolean {
        return true;
    }

    public run(model: InvocationModel, runtime: DualRuntime): void {
        const before = runtime.observations(model.audits);
        const outcome = runtime.transition((target) => target.prepare(invocation, invocationAudit));
        const accepted = !model.prepared;
        expect(outcome.ok).toBe(accepted);
        if (accepted) {
            model.prepared = true;
            model.audits.push(invocationAudit.id.value);
            model.coverage.add("prepare");
        } else {
            model.coverage.add("rejection");
            expect(runtime.observations(model.audits)).toEqual(before);
        }
        runtime.assertState(model);
    }

    public toString(): string {
        return "prepare";
    }
}

class Claim implements Command<InvocationModel, DualRuntime> {
    public constructor(
        private readonly ttl: number,
        private readonly worker: number,
        private readonly ordinalOffset: number
    ) {}

    public check(model: Readonly<InvocationModel>): boolean {
        return model.prepared && model.attempts.length === 0;
    }

    public run(model: InvocationModel, runtime: DualRuntime): void {
        runClaim(model, runtime, this.ttl, this.worker, this.ordinalOffset);
    }

    public toString(): string {
        return `claim(worker=${this.worker},ttl=${this.ttl},offset=${this.ordinalOffset})`;
    }
}

class RetryClaim implements Command<InvocationModel, DualRuntime> {
    public constructor(
        private readonly ttl: number,
        private readonly worker: number,
        private readonly ordinalOffset: number
    ) {}

    public check(model: Readonly<InvocationModel>): boolean {
        return model.prepared && model.attempts.length > 0;
    }

    public run(model: InvocationModel, runtime: DualRuntime): void {
        runClaim(model, runtime, this.ttl, this.worker, this.ordinalOffset);
    }

    public toString(): string {
        return `retryClaim(worker=${this.worker},ttl=${this.ttl},offset=${this.ordinalOffset})`;
    }
}

class AdvanceTime implements Command<InvocationModel, DualRuntime> {
    public constructor(private readonly elapsed: number) {}

    public check(): boolean {
        return true;
    }

    public run(model: InvocationModel, runtime: DualRuntime): void {
        model.now += this.elapsed;
        runtime.assertState(model);
    }

    public toString(): string {
        return `advance(+${this.elapsed})`;
    }
}

class Recover implements Command<InvocationModel, DualRuntime> {
    public constructor(
        private readonly ttl: number,
        private readonly worker: number,
        private readonly mutation: RecoveryMutation = "exact"
    ) {}

    public check(model: Readonly<InvocationModel>): boolean {
        return model.claims.length > 0;
    }

    public run(model: InvocationModel, runtime: DualRuntime): void {
        const previous = model.claims.at(-1)!;
        const next: ClaimState = {
            id: `model-claim-${model.nextClaim++}`,
            ordinal: previous.ordinal,
            worker: workerName(this.worker),
            expiresAt: model.now + this.ttl
        };
        const replacement = recoveryClaimRecord(next, this.mutation);
        const before = runtime.observations(model.audits);
        const outcome = runtime.transition((target) =>
            target.recover(new ItemClaimId(previous.id), replacement, at(model.now))
        );
        const accepted =
            currentUnattemptedClaim(model)?.id === previous.id &&
            previous.expiresAt <= model.now &&
            next.expiresAt > model.now &&
            previous.worker !== next.worker &&
            this.mutation === "exact";
        expect(outcome.ok).toBe(accepted);
        if (accepted) {
            model.claims.push(next);
            model.coverage.add("recover");
        } else {
            model.coverage.add("rejection");
            runtime.expectClaimAbsent(replacement.id);
            expect(runtime.observations(model.audits)).toEqual(before);
        }
        runtime.assertState(model);
    }

    public toString(): string {
        return `recover(worker=${this.worker},ttl=${this.ttl},mutation=${this.mutation})`;
    }
}

class Admit implements Command<InvocationModel, DualRuntime> {
    public constructor(private readonly mutation: AttemptMutation = "exact") {}

    public check(model: Readonly<InvocationModel>): boolean {
        return (
            model.claims.length > 0 && (this.mutation !== "wrongClaim" || model.claims.length > 1)
        );
    }

    public run(model: InvocationModel, runtime: DualRuntime): void {
        const claim = model.claims.at(-1)!;
        const attempt: AttemptState = {
            id: `model-attempt-${model.nextAttempt++}`,
            claim: claim.id,
            ordinal: claim.ordinal,
            audit: `model-audit-attempt-${model.nextAttempt - 1}`,
            startedAt: model.now
        };
        const record = attemptRecord(
            attempt,
            this.mutation,
            model.claims.find((candidate) => candidate.id !== claim.id)?.id
        );
        const audit = attemptAudit(record, attempt.audit);
        const before = runtime.observations(model.audits);
        const outcome = runtime.transition((target) => target.admit(record, at(model.now), audit));
        const accepted =
            currentUnattemptedClaim(model)?.id === claim.id &&
            claim.expiresAt > model.now &&
            claim.worker !== "stale-worker" &&
            retryOrdinal(model) === claim.ordinal &&
            this.mutation === "exact";
        expect(outcome.ok).toBe(accepted);
        if (accepted) {
            model.attempts.push(attempt);
            model.audits.push(audit.id.value);
            model.coverage.add("admit");
        } else {
            model.coverage.add("rejection");
            runtime.expectAttemptAbsent(record.id);
            runtime.expectAuditAbsent(audit.id);
            expect(runtime.observations(model.audits)).toEqual(before);
        }
        runtime.assertState(model);
    }

    public toString(): string {
        return `admit(${this.mutation})`;
    }
}

class RecordReceipt implements Command<InvocationModel, DualRuntime> {
    public constructor(
        private readonly outcome: AttemptReceiptOutcome,
        private readonly mutation: ReceiptMutation = "exact"
    ) {}

    public check(model: Readonly<InvocationModel>): boolean {
        return (
            model.attempts.length > 0 &&
            (this.mutation !== "wrongAttempt" || model.attempts.length > 1)
        );
    }

    public run(model: InvocationModel, runtime: DualRuntime): void {
        const attempt = model.attempts.at(-1)!;
        const receipt: ReceiptState = {
            id: `model-receipt-${model.nextReceipt++}`,
            attempt: attempt.id,
            outcome: this.outcome,
            audit: `model-audit-receipt-${model.nextReceipt - 1}`,
            recordedAt: model.now
        };
        const record = receiptRecord(
            receipt,
            this.mutation,
            model.attempts.find((candidate) => candidate.id !== attempt.id)?.id
        );
        const persistedAttemptAudit =
            this.mutation === "wrongAttemptAudit"
                ? audit(new AuditRecordId(attempt.audit), invocation.header.auditCause, {
                      kind: "attempt",
                      id: new EffectAttemptId("model-attempt-substituted")
                  })
                : attemptAudit(attemptRecord(attempt), attempt.audit);
        const auditRecord = receiptAudit(
            record,
            this.mutation === "wrongReceiptCause"
                ? invocation.header.auditCause
                : persistedAttemptAudit.id,
            receipt.audit
        );
        const publication = InvocationPublicationOutbox.pending({
            invocation: invocation.header.id,
            receipt:
                this.mutation === "wrongPublicationReceipt"
                    ? new ReceiptId("model-publication-receipt-substituted")
                    : record.id,
            audit:
                this.mutation === "wrongPublicationAudit"
                    ? new AuditRecordId("model-publication-audit-substituted")
                    : auditRecord.id
        });
        const before = runtime.observations(model.audits);
        const outcome = runtime.transition((target) =>
            target.recordReceipt(record, persistedAttemptAudit, auditRecord, publication)
        );
        const accepted =
            this.mutation === "exact" &&
            model.receipts.every((candidate) => candidate.attempt !== attempt.id);
        expect(outcome.ok).toBe(accepted);
        if (accepted) {
            model.receipts.push(receipt);
            model.audits.push(auditRecord.id.value);
            model.coverage.add("receipt");
        } else {
            model.coverage.add("rejection");
            runtime.expectReceiptAbsent(record.id);
            runtime.expectAuditAbsent(auditRecord.id);
            runtime.expectPublicationAbsent(publication.id);
            expect(runtime.observations(model.audits)).toEqual(before);
        }
        runtime.assertState(model);
    }

    public toString(): string {
        return `recordReceipt(${this.outcome},${this.mutation})`;
    }
}

class Restart implements Command<InvocationModel, DualRuntime> {
    public check(): boolean {
        return true;
    }

    public run(model: InvocationModel, runtime: DualRuntime): void {
        const before = runtime.observations(model.audits);
        runtime.restart();
        model.coverage.add("restart");
        expect(runtime.observations(model.audits)).toEqual(before);
        runtime.assertState(model);
    }

    public toString(): string {
        return "restart";
    }
}

function runClaim(
    model: InvocationModel,
    runtime: DualRuntime,
    ttl: number,
    worker: number,
    ordinalOffset: number
): void {
    const expectedOrdinal = retryOrdinal(model);
    const candidateOrdinal = expectedOrdinal + ordinalOffset;
    const claim: ClaimState = {
        id: `model-claim-${model.nextClaim++}`,
        ordinal: candidateOrdinal < 0 ? expectedOrdinal + 1 : candidateOrdinal,
        worker: workerName(worker),
        expiresAt: model.now + ttl
    };
    const before = runtime.observations(model.audits);
    const record = claimRecord(claim);
    const outcome = runtime.transition((target) => target.claim(record, at(model.now)));
    const accepted =
        currentUnattemptedClaim(model) === undefined &&
        unresolvedAttempt(model) === undefined &&
        claim.expiresAt > model.now &&
        claim.ordinal === expectedOrdinal &&
        (model.attempts.length === 0 || currentReceipt(model)?.outcome === "failed");
    expect(outcome.ok).toBe(accepted);
    if (accepted) {
        model.claims.push(claim);
        model.coverage.add(claim.ordinal === 0 ? "claim" : "retry");
    } else {
        model.coverage.add("rejection");
        runtime.expectClaimAbsent(record.id);
        expect(runtime.observations(model.audits)).toEqual(before);
    }
    runtime.assertState(model);
}

function runRequiredLifecycle(): void {
    const model = initialModel();
    const runtime = new DualRuntime();
    const commands: readonly Command<InvocationModel, DualRuntime>[] = [
        new Prepare(),
        new Claim(2, 0, 1),
        new Claim(2, 0, 0),
        new Claim(3, 1, 0),
        new Recover(4, 1),
        new AdvanceTime(2),
        new Admit(),
        new Recover(4, 1, "wrongInvocation"),
        new Recover(4, 1, "wrongItem"),
        new Recover(4, 1, "wrongOrdinal"),
        new Recover(4, 1, "wrongToken"),
        new Recover(4, 1),
        new Restart(),
        new Admit("wrongClaim"),
        new Admit("wrongToken"),
        new Admit("wrongAdmission"),
        new Admit("wrongItemKey"),
        new Admit("wrongAuditCause"),
        new Admit("futureStart"),
        new Admit(),
        new Admit(),
        new RecordReceipt("failed", "wrongAttemptAudit"),
        new RecordReceipt("failed", "wrongReceiptCause"),
        new RecordReceipt("failed", "wrongPublicationReceipt"),
        new RecordReceipt("failed", "wrongPublicationAudit"),
        new RecordReceipt("failed"),
        new RecordReceipt("succeeded"),
        new RetryClaim(0, 2, 0),
        new RetryClaim(5, 3, 0),
        new Admit(),
        new AdvanceTime(5),
        new Recover(5, 2),
        new Restart(),
        new Admit(),
        new RecordReceipt("succeeded", "wrongAttempt"),
        new RecordReceipt("succeeded"),
        new RetryClaim(5, 0, 0),
        new Restart()
    ];
    try {
        for (const command of commands) {
            expect(command.check(model)).toBe(true);
            command.run(model, runtime);
        }
    } finally {
        runtime.dispose();
    }
}

function initialModel(coverage: Set<CoverageHit> = new Set()): InvocationModel {
    return {
        prepared: false,
        now: 0,
        nextClaim: 0,
        nextAttempt: 0,
        nextReceipt: 0,
        claims: [],
        attempts: [],
        receipts: [],
        audits: [],
        coverage
    };
}

function expectedObservation(model: Readonly<InvocationModel>): Observation {
    const current = currentReceipt(model);
    return {
        prepared: model.prepared ? projectPrepared(invocation) : undefined,
        claims: model.claims.map((claim) => projectClaim(claimRecord(claim))),
        attempts: model.attempts.map((attempt) => projectAttempt(attemptRecord(attempt))),
        receipts: model.receipts.map((receipt) => projectReceipt(receiptRecord(receipt))),
        currentReceipt: current === undefined ? undefined : projectReceipt(receiptRecord(current)),
        batchOutcome:
            !model.prepared || current === undefined
                ? undefined
                : current.outcome === "succeeded"
                  ? "succeeded"
                  : current.outcome,
        audits: expectedAudits(model),
        publications: model.receipts
            .map((receipt) => projectPublication(publicationFor(receipt)))
            .sort((left, right) => left.id.localeCompare(right.id))
    };
}

function observe<Transaction>(
    transaction: Transaction,
    persistence: TestPersistence<Transaction>,
    evidence: InvocationEvidencePersistence<Transaction>,
    ledger: TestLedger<Transaction>,
    auditIds: readonly string[]
): Observation {
    const stored = persistence.prepared(transaction, invocation.header.id);
    const claims = persistence.claimsForItem(transaction, invocation.header.id, 0);
    const attempts = persistence.attemptsForItem(transaction, invocation.header.id, 0);
    const receipts = persistence
        .receiptsForItem(transaction, invocation.header.id, 0)
        .map(requireAttemptReceipt);
    const current =
        stored === undefined ? undefined : ledger.currentReceipt(transaction, stored.header.id, 0);
    return {
        prepared: stored === undefined ? undefined : projectPrepared(stored),
        claims: claims.map(projectClaim),
        attempts: attempts.map(projectAttempt),
        receipts: receipts.map(projectReceipt),
        currentReceipt:
            current === undefined ? undefined : projectReceipt(requireAttemptReceipt(current)),
        batchOutcome:
            stored === undefined ? undefined : ledger.batchOutcome(transaction, stored.header.id),
        audits: auditIds
            .map((id) => {
                const record = evidence.audit(transaction, new AuditRecordId(id));
                return record === undefined ? undefined : projectAudit(record);
            })
            .filter((record): record is ReturnType<typeof projectAudit> => record !== undefined)
            .sort((left, right) => left.id.localeCompare(right.id)),
        publications: evidence
            .pendingPublications(transaction)
            .map(projectPublication)
            .sort((left, right) => left.id.localeCompare(right.id))
    };
}

function createMemoryState(): MemoryState {
    return { ...createInvocationMemoryState(), ...createInvocationMediationMemoryState() };
}

function cloneMemoryState(state: MemoryState): MemoryState {
    return {
        ...cloneInvocationMemoryState(state),
        ...cloneInvocationMediationMemoryState(state)
    };
}

function currentUnattemptedClaim(model: Readonly<InvocationModel>): ClaimState | undefined {
    const latest = model.claims.at(-1);
    return latest === undefined || model.attempts.some((attempt) => attempt.claim === latest.id)
        ? undefined
        : latest;
}

function unresolvedAttempt(model: Readonly<InvocationModel>): AttemptState | undefined {
    return model.attempts.find(
        (attempt) => !model.receipts.some((receipt) => receipt.attempt === attempt.id)
    );
}

function currentReceipt(model: Readonly<InvocationModel>): ReceiptState | undefined {
    const attempt = model.attempts.at(-1);
    return attempt === undefined
        ? undefined
        : model.receipts.find((receipt) => receipt.attempt === attempt.id);
}

function retryOrdinal(model: Readonly<InvocationModel>): number {
    const latest = model.attempts.at(-1);
    return latest === undefined ? 0 : latest.ordinal + 1;
}

function claimRecord(claim: ClaimState): ItemClaim<string> {
    return new ItemClaim(
        new ItemClaimId(claim.id),
        invocation.header.id,
        0,
        claim.ordinal,
        {
            kind: "executor",
            token: "lease:1",
            worker: new ClaimWorkerId(claim.worker)
        },
        at(claim.expiresAt)
    );
}

function recoveryClaimRecord(claim: ClaimState, mutation: RecoveryMutation): ItemClaim<string> {
    return new ItemClaim(
        new ItemClaimId(claim.id),
        mutation === "wrongInvocation"
            ? new InvocationId("differential-state-machine-substituted")
            : invocation.header.id,
        mutation === "wrongItem" ? 1 : 0,
        claim.ordinal + (mutation === "wrongOrdinal" ? 1 : 0),
        {
            kind: "executor",
            token: mutation === "wrongToken" ? "lease:substituted" : "lease:1",
            worker: new ClaimWorkerId(claim.worker)
        },
        at(claim.expiresAt)
    );
}

function attemptRecord(
    attempt: AttemptState,
    mutation: AttemptMutation = "exact",
    wrongClaim?: string
): EffectAttempt<string, string> {
    return new EffectAttempt(
        new EffectAttemptId(attempt.id),
        invocation.header.id,
        0,
        attempt.ordinal,
        new ItemClaimId(
            mutation === "wrongClaim"
                ? requireSubstitution(wrongClaim, "Claim substitution")
                : attempt.claim
        ),
        mutation === "wrongToken" ? "lease:substituted" : "lease:1",
        admissionFor(
            mutation === "wrongAdmission" ? "substituted-invocation" : invocation.header.id.value,
            0,
            attempt.ordinal
        ),
        at(attempt.startedAt + (mutation === "futureStart" ? 1 : 0)),
        mutation === "wrongItemKey"
            ? `${invocation.item(0).idempotencyKey}:substituted`
            : invocation.item(0).idempotencyKey,
        mutation === "wrongAuditCause"
            ? new AuditRecordId("model-audit-cause-substituted")
            : invocation.header.auditCause
    );
}

function receiptRecord(
    receipt: ReceiptState,
    mutation: ReceiptMutation = "exact",
    wrongAttempt?: string
): AttemptReceipt {
    return new AttemptReceipt(
        new ReceiptId(receipt.id),
        new EffectAttemptId(
            mutation === "wrongAttempt"
                ? requireSubstitution(wrongAttempt, "EffectAttempt substitution")
                : receipt.attempt
        ),
        receipt.outcome,
        undefined,
        at(receipt.recordedAt),
        receipt.outcome === "succeeded" ? content(receipt.id) : undefined
    );
}

function attemptAudit(attempt: EffectAttempt<string, string>, id: string): AuditRecord {
    return audit(new AuditRecordId(id), invocation.header.auditCause, {
        kind: "attempt",
        id: attempt.id
    });
}

function receiptAudit(receipt: AttemptReceipt, cause: AuditRecordId, id: string): AuditRecord {
    return audit(new AuditRecordId(id), cause, {
        kind: "receipt",
        id: receipt.id,
        outcome: receipt.outcome
    });
}

function expectedAudits(
    model: Readonly<InvocationModel>
): readonly ReturnType<typeof projectAudit>[] {
    const records: AuditRecord[] = model.prepared ? [invocationAudit] : [];
    for (const attempt of model.attempts) {
        records.push(attemptAudit(attemptRecord(attempt), attempt.audit));
    }
    for (const receipt of model.receipts) {
        const attempt = model.attempts.find((candidate) => candidate.id === receipt.attempt);
        if (attempt === undefined) throw new TypeError("Receipt model has no EffectAttempt");
        records.push(
            receiptAudit(receiptRecord(receipt), new AuditRecordId(attempt.audit), receipt.audit)
        );
    }
    return records.map(projectAudit).sort((left, right) => left.id.localeCompare(right.id));
}

function publicationFor(receipt: ReceiptState): InvocationPublicationOutbox {
    return InvocationPublicationOutbox.pending({
        invocation: invocation.header.id,
        receipt: new ReceiptId(receipt.id),
        audit: new AuditRecordId(receipt.audit)
    });
}

function projectPrepared(record: PreparedInvocation<string, string, string, string>) {
    const operation = record.header.operation;
    const placement = operation.placement;
    return {
        header: {
            id: record.header.id.value,
            operation: {
                operation: operation.operation.value,
                target: operation.target,
                package: operation.packageId.value,
                version: operation.version.toString(),
                manifestDigest: operation.manifestDigest.value,
                descriptorDigest: operation.descriptorDigest.value,
                configurationDigest: operation.configurationDigest.value,
                runtimeDigest: operation.runtimeDigest.value,
                activationGeneration: operation.activationGeneration,
                registration: operation.registration,
                impact: operation.impact,
                approvalRequired: operation.approvalRequired,
                placement: {
                    manifest: [...placement.manifest],
                    policy: [...placement.policy],
                    substrate: [...placement.substrate],
                    trust: [...placement.trust],
                    selected: placement.selected
                }
            },
            domain: record.header.domain,
            actor: { kind: record.header.actor.kind, id: record.header.actor.id.value },
            authority: record.header.authority,
            pathEpochs: record.header.pathEpochs,
            lease: record.header.lease,
            route: record.header.route?.value,
            projectionDigest: record.header.projectionDigest?.value,
            auditCause: record.header.auditCause.value,
            idempotencySeed: record.header.idempotencySeed
        },
        payload: {
            kind: record.payload.kind,
            items: Array.from({ length: record.itemCount }, (_, index) => {
                const item = record.item(index);
                return { arguments: item.arguments, idempotencyKey: item.idempotencyKey };
            })
        },
        intentDigest: record.intentDigest.value
    };
}

function projectClaim(record: ItemClaim<string>) {
    const owner =
        record.owner.kind === "executor"
            ? {
                  kind: record.owner.kind,
                  token: record.owner.token,
                  worker: record.owner.worker.value
              }
            : {
                  kind: record.owner.kind,
                  actor: { kind: record.owner.actor.kind, id: record.owner.actor.id.value },
                  worker: record.owner.worker.value
              };
    return {
        id: record.id.value,
        invocation: record.invocation.value,
        itemIndex: record.itemIndex,
        attemptOrdinal: record.attemptOrdinal,
        owner,
        expiresAt: record.expiresAt.getTime()
    };
}

function projectAttempt(record: EffectAttempt<string, string>) {
    return {
        id: record.id.value,
        invocation: record.invocation.value,
        itemIndex: record.itemIndex,
        ordinal: record.ordinal,
        claim: record.claim.value,
        token: record.token,
        admission: {
            reference: record.admission.reference,
            digest: record.admission.digest.value
        },
        startedAt: record.startedAt.getTime(),
        idempotencyKey: record.idempotencyKey,
        auditCause: record.auditCause.value
    };
}

function projectReceipt(record: AttemptReceipt) {
    return {
        variant: record.variant,
        id: record.id.value,
        attempt: record.attempt.value,
        outcome: record.outcome,
        previous: record.previous?.value,
        recordedAt: record.recordedAt.getTime(),
        result: record.result?.value
    };
}

function projectAudit(record: AuditRecord) {
    return {
        id: record.id.value,
        actor: { kind: record.actor.kind, id: record.actor.id.value },
        tenant: record.tenant.value,
        correlation: record.correlation.value,
        cause: record.cause?.value,
        kind: projectAuditKind(record.kind)
    };
}

function projectAuditKind(kind: AuditRecord["kind"]) {
    switch (kind.kind) {
        case "invocation":
        case "attempt":
        case "event":
        case "routeReserved":
        case "commit":
            return { kind: kind.kind, id: kind.id.value };
        case "approval":
            return { kind: kind.kind, id: kind.id.value, phase: kind.phase };
        case "receipt":
            return { kind: kind.kind, id: kind.id.value, outcome: kind.outcome };
        case "receiptSuperseded":
            return {
                kind: kind.kind,
                previous: kind.previous.value,
                next: kind.next.value
            };
        case "write":
            return { kind: kind.kind, id: kind.id.value, outcome: kind.outcome };
        case "routeProjected":
            return {
                kind: kind.kind,
                projection: kind.projection.value,
                reservation: kind.reservation.value
            };
        case "delivery":
            return { kind: kind.kind, reservation: kind.reservation.value };
    }
}

function projectPublication(record: InvocationPublicationOutbox) {
    const state = record.state;
    return {
        id: record.id.value,
        observation: {
            invocation: record.observation.invocation.value,
            receipt: record.observation.receipt.value,
            audit: record.observation.audit.value
        },
        state: {
            kind: state.kind,
            eventPublishedAt: state.eventPublishedAt?.getTime(),
            commitAppendedAt: state.commitAppendedAt?.getTime()
        },
        revision: record.revision.value
    };
}

function audit(
    id: AuditRecordId,
    cause: AuditRecordId | undefined,
    kind: ConstructorParameters<typeof AuditRecord>[0]["kind"]
): AuditRecord {
    return new AuditRecord({
        id,
        actor: invocation.header.actor,
        tenant: tenant,
        correlation,
        ...(cause === undefined ? {} : { cause }),
        kind
    });
}

function requireAttemptReceipt(receipt: Receipt): AttemptReceipt {
    if (!(receipt instanceof AttemptReceipt)) {
        throw new TypeError("Invocation state model only admits attempted Receipts");
    }
    return receipt;
}

function capture(operation: () => void): TransitionOutcome {
    try {
        operation();
        return { ok: true };
    } catch (error) {
        if (!(error instanceof AgentCoreError)) throw error;
        return { ok: false, code: error.code };
    }
}

function workerName(index: number): string {
    return index === 3 ? "stale-worker" : `model-worker-${index}`;
}

function at(milliseconds: number): Date {
    return new Date(milliseconds);
}

function content(value: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(value)));
}

function requireSubstitution(value: string | undefined, label: string): string {
    if (value === undefined) throw new TypeError(`${label} requires an existing alternative`);
    return value;
}

type TransitionOutcome = { readonly ok: true } | { readonly ok: false; readonly code: string };

const requiredCoverage = Object.freeze([
    "prepare",
    "claim",
    "recover",
    "admit",
    "receipt",
    "retry",
    "restart",
    "rejection"
] satisfies readonly CoverageHit[]);

const invocation = prepared(
    "differential-state-machine",
    { externalSend: true },
    { lease: "lease:1" }
);
const tenant = new TenantId("differential-state-machine-tenant");
const correlation = new CorrelationId("differential-state-machine-correlation");
const invocationAudit = audit(invocation.header.auditCause, undefined, {
    kind: "invocation",
    id: invocation.header.id
});
