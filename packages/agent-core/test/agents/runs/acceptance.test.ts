import { describe, expect, it } from "vitest";
import { Digest, Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { OperationRef } from "../../../src/facets";
import { RunCommitId } from "../../../src/execution-references";
import { ApprovalId, ReceiptId } from "../../../src/invocation-references";
import {
    AcceptanceCriterion,
    AcceptanceCriterionCodec,
    AcceptanceVerdict,
    AcceptanceVerdictCodec
} from "../../../src/agents/runs/acceptance";
import {
    RunAdmissionRegistry,
    RunAdmissionRegistryCodec,
    decodeRunObligation,
    runObligationKey,
    type RunObligation
} from "../../../src/agents/runs/admission";
import { RunCommit, type RunCommitInit } from "../../../src/agents/runs/commit";
import type { LeaseToken } from "../../../src/agents/runs/lease";
import type { AcceptanceReceiptEvidence } from "../../../src/agents/runs/evidence";
import { AcceptanceId, RunBranchId, RunId } from "../../../src/agents/runs/id";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import {
    configuration,
    content,
    digest,
    genesis,
    harness,
    ids,
    objectAt,
    pins,
    seedRunningTurn,
    thrownBy,
    type Assembled
} from "./fixture";

const operation = new OperationRef("verifier-package:verify");
const firstId = new AcceptanceId("acceptance-first");
const secondId = new AcceptanceId("acceptance-second");

function criterion(id: AcceptanceId): AcceptanceCriterion {
    return new AcceptanceCriterion({ id, operation });
}

function verdict(acceptance: AcceptanceId, subject: Digest, receipt: string): AcceptanceVerdict {
    return new AcceptanceVerdict({ acceptance, subject, receipt: new ReceiptId(receipt) });
}

function attempted(
    value: ReturnType<typeof harness>,
    receipt: string,
    outcome: AcceptanceReceiptEvidence["outcome"],
    invoked: OperationRef = operation
): void {
    value.evidence.acceptances.set(receipt, {
        kind: "acceptanceReceipt",
        receipt: new ReceiptId(receipt),
        outcome,
        operation: invoked
    });
}

function frontierKeys(value: ReturnType<typeof harness>): readonly string[] {
    return value.repository
        .transaction((tx) => {
            const admission = value.repository.loadAdmission(tx, ids.run);
            if (admission === undefined) throw new TypeError("Expected Run admission registry");
            return admission.frontier();
        })
        .map(runObligationKey);
}

function expectCode(operationUnderTest: () => void, code: AgentCoreError["code"]): void {
    expect(thrownBy(AgentCoreError, operationUnderTest).code).toBe(code);
}

function expectTypeError(label: string, operation: () => void, message: string): void {
    expect(thrownBy(TypeError, operation, label).message, label).toBe(message);
}

function treeMessage(id: string, parent: RunCommitId, token: LeaseToken, tree?: string): RunCommit {
    const init: Assembled<RunCommitInit> = {
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "message",
        parents: [parent],
        pins: pins(),
        writer: { kind: "turn", token },
        subjectTurn: token.turn,
        content: content("1")
    };
    if (tree !== undefined) init.treeCheckpoint = content(tree);
    return new RunCommit(init);
}

function otherRunGenesis() {
    const snapshot = configuration();
    const run = new RunId("run-2");
    const branch = new RunBranchId("branch-main-2");
    const root = new RunCommit({
        id: new RunCommitId("commit-root-2"),
        run,
        branch,
        kind: "root",
        parents: [],
        pins: snapshot.pins,
        writer: { kind: "root" },
        content: content("4"),
        treeCheckpoint: content("e")
    });
    return {
        run: new Run({
            id: run,
            agent: ids.agent,
            configuration: snapshot.id,
            root: root.id,
            initialBranch: branch,
            revision: new Revision(0)
        }),
        configuration: snapshot,
        branch: new RunBranch(branch, run, "main", root.id, new Revision(0)),
        root
    };
}

describe("Run acceptance criteria", () => {
    it(
        "[C13-RUN-ACCEPTANCE-OBLIGATION] reserves each declared criterion at open and completes only through a succeeded current-subject verdict",
        { tags: "p0" },
        () => {
            const value = harness();
            value.runtime.createRun({
                ...genesis(),
                acceptanceCriteria: [criterion(firstId), criterion(secondId)]
            });

            const obligations: readonly RunObligation[] = [
                { kind: "acceptance", acceptance: firstId },
                { kind: "acceptance", acceptance: secondId }
            ];
            expect(frontierKeys(value)).toEqual(
                [...obligations]
                    .map(runObligationKey)
                    .sort((left, right) => left.localeCompare(right))
            );
            expect(
                value.repository.transaction((tx) =>
                    value.repository.loadAcceptanceCriterion(tx, firstId)
                )
            ).toEqual(criterion(firstId));
            const firstObligation = obligations[0];
            if (firstObligation === undefined)
                throw new TypeError("Expected acceptance obligation");
            // The generic obligation paths serve every kind uniformly, so acceptance has to
            // be carved out of both: a uniform completion would discharge a criterion with
            // no verdict at all and make "completes exactly when" false.
            expect(() => value.runtime.reserveRunObligation(ids.run, firstObligation)).toThrow(
                expect.objectContaining({
                    code: "run.invalid-state",
                    message: "Acceptance criteria are reserved when the Run declares them at open"
                })
            );
            expect(() =>
                value.runtime.completeRunObligation({
                    run: ids.run,
                    registryEpoch: 0,
                    obligation: firstObligation
                })
            ).toThrow(
                expect.objectContaining({
                    code: "run.invalid-state",
                    message: "An acceptance obligation discharges only through a recorded verdict"
                })
            );
            expect(frontierKeys(value)).toEqual(
                [...obligations]
                    .map(runObligationKey)
                    .sort((left, right) => left.localeCompare(right))
            );

            attempted(value, "verifier-pass", "succeeded");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("e"), "verifier-pass")
            );
            // The criterion stays outstanding: it is a condition evaluated against the
            // head the Run finishes on, not a box ticked at the instant of the verdict.
            expect(value.runtime.acceptanceSatisfied(ids.run, firstId)).toBe(true);

            attempted(value, "verifier-fail", "failed");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(secondId, digest("e"), "verifier-fail")
            );
            expect(value.runtime.acceptanceSatisfied(ids.run, secondId)).toBe(false);
            expect(
                value.repository.transaction((tx) =>
                    value.repository.loadAcceptanceVerdict(tx, secondId, digest("e"))
                )
            ).toEqual(verdict(secondId, digest("e"), "verifier-fail"));
            expect(value.runtime.acceptanceAttemptAdmissible(ids.run, secondId)).toBe(false);

            expectCode(
                () =>
                    value.runtime.recordAcceptanceVerdict(
                        ids.run,
                        verdict(new AcceptanceId("undeclared"), digest("e"), "verifier-pass")
                    ),
                "run.invalid-state"
            );
            expectCode(
                () =>
                    value.runtime.recordAcceptanceVerdict(
                        ids.run,
                        verdict(firstId, digest("2"), "unattempted-receipt")
                    ),
                "authority.denied"
            );
            // The criterion names the Operation that decides it, so a succeeded Receipt
            // from some other Operation is not evidence for this criterion — otherwise
            // the declared verifier would be decoration and any success would discharge.
            // One subject holds one verdict. Redelivering the identical verdict is
            // idempotent, but a second verdict naming a different Receipt for the same
            // subject is a contradiction about the same tree and is refused.
            attempted(value, "first-at-subject", "succeeded");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("7"), "first-at-subject")
            );
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("7"), "first-at-subject")
            );
            attempted(value, "second-at-subject", "succeeded");
            // Assert the message, not just the code: the record store rejects the same
            // write generically, so only the exact text proves this rule is the one that
            // fired and that a caller learns which invariant it broke.
            expect(() =>
                value.runtime.recordAcceptanceVerdict(
                    ids.run,
                    verdict(firstId, digest("7"), "second-at-subject")
                )
            ).toThrow("Acceptance subject already holds a recorded verdict");

            attempted(value, "foreign-verifier", "succeeded", new OperationRef("other:verify"));
            expectCode(
                () =>
                    value.runtime.recordAcceptanceVerdict(
                        ids.run,
                        verdict(firstId, digest("9"), "foreign-verifier")
                    ),
                "authority.denied"
            );
            value.evidence.acceptances.set("mismatched-receipt", {
                kind: "acceptanceReceipt",
                receipt: new ReceiptId("some-other-receipt"),
                outcome: "succeeded",
                operation
            });
            expectCode(
                () =>
                    value.runtime.recordAcceptanceVerdict(
                        ids.run,
                        verdict(firstId, digest("2"), "mismatched-receipt")
                    ),
                "authority.denied"
            );
        }
    );

    it(
        "[C13-RUN-ACCEPTANCE-SUBJECT] treats a verdict as evidence for its exact subject and admits a further attempt only against an unnamed head tree digest",
        { tags: "p0" },
        () => {
            const base = harness();
            base.runtime.createRun({ ...genesis(), acceptanceCriteria: [criterion(firstId)] });
            const value = seedRunningTurn(base);
            expect(value.runtime.acceptanceAttemptAdmissible(ids.run, firstId)).toBe(true);
            // The criterion is outstanding for the Run's whole life; what changes is
            // whether a verdict for the current head satisfies it.
            expect(frontierKeys(value)).toEqual([
                runObligationKey({ kind: "acceptance", acceptance: firstId })
            ]);

            attempted(value, "stale-pass", "succeeded");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("f"), "stale-pass")
            );
            expect(value.runtime.acceptanceAttemptAdmissible(ids.run, firstId)).toBe(true);
            expect(value.runtime.acceptanceSatisfied(ids.run, firstId)).toBe(false);

            attempted(value, "current-pass", "succeeded");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("e"), "current-pass")
            );
            expect(value.runtime.acceptanceSatisfied(ids.run, firstId)).toBe(true);
            expect(value.runtime.acceptanceAttemptAdmissible(ids.run, firstId)).toBe(false);

            attempted(value, "verifier-rerun", "succeeded");
            expectCode(
                () =>
                    value.runtime.recordAcceptanceVerdict(
                        ids.run,
                        verdict(firstId, digest("e"), "verifier-rerun")
                    ),
                "run.invalid-state"
            );
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("e"), "current-pass")
            );

            value.runtime.appendTurnCommit(
                treeMessage("advance-tree", ids.root, value.token, "2"),
                new Revision(0),
                new Date(1500)
            );
            expect(value.runtime.acceptanceAttemptAdmissible(ids.run, firstId)).toBe(true);
            expect(value.runtime.acceptanceSatisfied(ids.run, firstId)).toBe(false);

            attempted(value, "moved-pass", "succeeded");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("2"), "moved-pass")
            );
            expect(value.runtime.acceptanceSatisfied(ids.run, firstId)).toBe(true);
        }
    );

    it(
        "[C13-RUN-ACCEPTANCE-SUBJECT] withholds admission and completion while the head names no tree digest",
        { tags: "p1" },
        () => {
            const base = genesis();
            const bare = new RunCommit({
                id: ids.root,
                run: ids.run,
                branch: ids.branch,
                kind: "root",
                parents: [],
                pins: base.configuration.pins,
                writer: { kind: "root" },
                content: content("4")
            });
            const value = harness();
            value.runtime.createRun({
                ...base,
                root: bare,
                acceptanceCriteria: [criterion(firstId)]
            });
            expect(value.runtime.acceptanceAttemptAdmissible(ids.run, firstId)).toBe(false);
            expect(value.runtime.acceptanceSatisfied(ids.run, firstId)).toBe(false);

            attempted(value, "no-subject-pass", "succeeded");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("e"), "no-subject-pass")
            );
            expect(frontierKeys(value)).toEqual([
                runObligationKey({ kind: "acceptance", acceptance: firstId })
            ]);
        }
    );

    it(
        "[C13-RUN-ACCEPTANCE-OBLIGATION] snapshots an unsatisfied criterion into the terminal frontier and blocks Settled until a current satisfying verdict",
        { tags: "p0" },
        () => {
            const base = harness();
            base.runtime.createRun({
                ...genesis(),
                acceptanceCriteria: [criterion(firstId), criterion(secondId)]
            });
            const value = seedRunningTurn(base);
            const approval = new ApprovalId("acceptance-approval");
            const approved = value.runtime.reserveRunObligation(ids.run, {
                kind: "approval",
                approval
            });
            attempted(value, "first-pass", "succeeded");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("e"), "first-pass")
            );

            const snapshot = value.runtime.terminalizeRun({
                run: ids.run,
                turn: ids.turn,
                expectedRunRevision: value.repository.transaction((tx) => {
                    const run = value.repository.loadRun(tx, ids.run);
                    if (run === undefined) throw new TypeError("Expected active Run");
                    return run.revision;
                }),
                expectedTurnRevision: value.running.revision,
                expectedBranchRevision: new Revision(0),
                token: value.token,
                outcome: "succeeded",
                commit: new RunCommit({
                    id: new RunCommitId("acceptance-terminal"),
                    run: ids.run,
                    branch: ids.branch,
                    kind: "result",
                    parents: [ids.root],
                    pins: pins(),
                    writer: { kind: "turn", token: value.token },
                    subjectTurn: ids.turn,
                    content: content("f"),
                    treeCheckpoint: content("3")
                }),
                siblingCancellations: new Map(),
                now: new Date(2000)
            });

            expect(snapshot.obligation.obligations.map(runObligationKey)).toEqual(
                [
                    { kind: "acceptance", acceptance: firstId } as const,
                    { kind: "acceptance", acceptance: secondId } as const,
                    { kind: "approval", approval } as const
                ]
                    .map(runObligationKey)
                    .sort((left, right) => left.localeCompare(right))
            );
            expect(snapshot.obligation.requiredAudits).toEqual([]);
            value.runtime.completeRunObligation(approved);
            value.settlement.approvals.add(approval.value);
            expect(value.runtime.settled(ids.run)).toBe(false);

            attempted(value, "late-pass", "succeeded");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(secondId, digest("3"), "late-pass")
            );
            // The obligation is still snapshotted — settlement is what evaluates it, and it
            // now evaluates against the head the Run finished on.
            expect(value.runtime.acceptanceSatisfied(ids.run, secondId)).toBe(true);
            // Both declared criteria are snapshotted, so both must be satisfied at the
            // head the Run finished on — the first one's verdict is still current.
            value.settlement.acceptances.add(firstId.value);
            value.settlement.acceptances.add(secondId.value);
            expect(value.runtime.settled(ids.run)).toBe(true);
        }
    );

    it(
        "[C13-RUN-ACCEPTANCE-OBLIGATION] leaves a Run declaring no criteria on the exact prior genesis bytes",
        { tags: "p0" },
        () => {
            const value = harness();
            value.runtime.createRun(genesis());
            const snapshot = value.storage.snapshot();

            expect(
                snapshot.records.some(
                    (record) => record.kind === "acceptance" || record.kind === "verdict"
                )
            ).toBe(false);
            const stored = snapshot.records.find((record) => record.kind === "admission")!;
            expect([...stored.bytes]).toEqual([
                ...RunAdmissionRegistryCodec.encode(RunAdmissionRegistry.initial(ids.run))
            ]);
        }
    );

    it(
        "[run.acceptance-criterion] [run.acceptance-verdict] persists criteria, verdicts, and completion across a memory restart",
        { tags: "p0" },
        () => {
            const value = harness();
            value.runtime.createRun({ ...genesis(), acceptanceCriteria: [criterion(firstId)] });
            attempted(value, "durable-pass", "succeeded");
            value.runtime.recordAcceptanceVerdict(
                ids.run,
                verdict(firstId, digest("e"), "durable-pass")
            );

            const restarted = harness(value.storage.snapshot());
            expect(
                restarted.repository.transaction((tx) =>
                    restarted.repository.loadAcceptanceCriterion(tx, firstId)
                )
            ).toEqual(criterion(firstId));
            expect(
                restarted.repository.transaction((tx) =>
                    restarted.repository.loadAcceptanceVerdict(tx, firstId, digest("e"))
                )
            ).toEqual(verdict(firstId, digest("e"), "durable-pass"));
            expect(frontierKeys(restarted)).toEqual([
                runObligationKey({ kind: "acceptance", acceptance: firstId })
            ]);
            expect(restarted.runtime.acceptanceAttemptAdmissible(ids.run, firstId)).toBe(false);
            expect(restarted.runtime.acceptanceSatisfied(ids.run, firstId)).toBe(false);
            attempted(restarted, "durable-pass", "succeeded");
            expect(restarted.runtime.acceptanceSatisfied(ids.run, firstId)).toBe(true);
        }
    );

    it("binds a verdict to the declaring Run's own reserved criterion", { tags: "p1" }, () => {
        const value = harness();
        value.runtime.createRun({ ...genesis(), acceptanceCriteria: [criterion(firstId)] });
        const other = otherRunGenesis();
        expectCode(
            () =>
                value.runtime.createRun({
                    ...other,
                    acceptanceCriteria: [criterion(firstId)]
                }),
            "run.invalid-state"
        );
        value.runtime.createRun(other);

        expectCode(
            () =>
                value.runtime.recordAcceptanceVerdict(
                    other.run.id,
                    verdict(firstId, digest("e"), "foreign-pass")
                ),
            "run.invalid-state"
        );
        expect(value.runtime.acceptanceAttemptAdmissible(other.run.id, firstId)).toBe(false);
        expect(value.runtime.acceptanceAttemptAdmissible(ids.run, firstId)).toBe(true);
    });

    it("rejects duplicate and preexisting criterion identities at genesis", { tags: "p1" }, () => {
        const value = harness();
        expectCode(
            () =>
                value.runtime.createRun({
                    ...genesis(),
                    acceptanceCriteria: [criterion(firstId), criterion(firstId)]
                }),
            "run.invalid-state"
        );
        expect(
            value.repository.transaction((tx) => value.repository.loadRun(tx, ids.run))
        ).toBeUndefined();
        expect(
            value.repository.transaction((tx) =>
                value.repository.loadAcceptanceCriterion(tx, firstId)
            )
        ).toBeUndefined();
    });

    it(
        "[run.acceptance-criterion] [run.acceptance-verdict] round-trips exact records and rejects malformed identities",
        { tags: "p1" },
        () => {
            const decodedCriterion = AcceptanceCriterionCodec.decode(
                AcceptanceCriterionCodec.encode(criterion(firstId))
            );
            expect(decodedCriterion).toEqual(criterion(firstId));
            expect(Object.isFrozen(decodedCriterion)).toBe(true);
            const recorded = verdict(firstId, digest("e"), "codec-receipt");
            const decodedVerdict = AcceptanceVerdictCodec.decode(
                AcceptanceVerdictCodec.encode(recorded)
            );
            expect(decodedVerdict).toEqual(recorded);
            expect(Object.isFrozen(decodedVerdict)).toBe(true);

            expect(() => new AcceptanceCriterion({ id: ids.run, operation })).toThrow(
                /exact context classes/
            );
            expect(
                () =>
                    new AcceptanceCriterion({
                        id: firstId,
                        // @ts-expect-error Runtime validation must reject the wrong operation identifier class.
                        operation: ids.run
                    })
            ).toThrow(/exact context classes/);
            expect(
                () =>
                    new AcceptanceVerdict({
                        acceptance: ids.run,
                        subject: digest("e"),
                        receipt: new ReceiptId("codec-receipt")
                    })
            ).toThrow(/exact context classes/);
            expect(
                () =>
                    new AcceptanceVerdict({
                        acceptance: firstId,
                        // @ts-expect-error Runtime validation must reject ContentRef as Digest evidence.
                        subject: content("e"),
                        receipt: new ReceiptId("codec-receipt")
                    })
            ).toThrow(/exact context classes/);
            expect(
                () =>
                    new AcceptanceVerdict({
                        acceptance: firstId,
                        subject: digest("e"),
                        receipt: ids.run
                    })
            ).toThrow(/exact context classes/);
            expect(() => AcceptanceCriterion.fromData({ id: firstId.value })).toThrow(
                /missing or unknown fields/
            );
            expect(() =>
                AcceptanceCriterion.fromData({
                    id: firstId.value,
                    operation: operation.value,
                    extra: true
                })
            ).toThrow(/missing or unknown fields/);
            expect(() =>
                AcceptanceVerdict.fromData({
                    acceptance: firstId.value,
                    receipt: "codec-receipt",
                    subject: "not-a-digest"
                })
            ).toThrow(/lowercase SHA-256/);

            const obligation: RunObligation = { kind: "acceptance", acceptance: firstId };
            const registry = RunAdmissionRegistry.initial(ids.run).reserve(obligation).registry;
            const decoded = RunAdmissionRegistryCodec.decode(
                RunAdmissionRegistryCodec.encode(registry)
            );
            expect(decoded.reserved.map(runObligationKey)).toEqual([runObligationKey(obligation)]);
            expect(decodeRunObligation({ acceptance: firstId.value, kind: "acceptance" })).toEqual(
                obligation
            );
            expect(() =>
                decodeRunObligation({
                    acceptance: firstId.value,
                    kind: "acceptance",
                    extra: 1
                })
            ).toThrow(/missing or unknown fields/);
            expect(() =>
                RunAdmissionRegistry.initial(ids.run).reserve({
                    kind: "acceptance",
                    acceptance: ids.run
                })
            ).toThrow(/exact canonical ID/);
        }
    );

    it(
        "[run.acceptance-criterion] [run.acceptance-verdict] names the exact field each malformed acceptance record failed on",
        { tags: "p1" },
        () => {
            // The subject each validator carries is what tells an operator which field of a
            // corrupt record is at fault. Both records reject every one of these, so a test
            // asserting only that decoding fails would pass with every subject blanked.
            expectTypeError(
                "criterion id",
                () =>
                    AcceptanceCriterion.fromData({
                        id: 42,
                        operation: operation.value
                    }),
                "Acceptance criterion ID must be a non-empty string"
            );
            expectTypeError(
                "criterion operation",
                () => AcceptanceCriterion.fromData({ id: firstId.value, operation: 42 }),
                "Acceptance criterion Operation must be a non-empty string"
            );
            const verdictData = objectAt(
                verdict(firstId, digest("e"), "codec-receipt").toData(),
                "acceptance verdict"
            );
            const cases = [
                { label: "acceptance", subject: "Acceptance verdict criterion" },
                { label: "subject", subject: "Acceptance verdict subject" },
                { label: "receipt", subject: "Acceptance verdict Receipt" }
            ] as const;
            for (const { label, subject } of cases) {
                expectTypeError(
                    label,
                    () => AcceptanceVerdict.fromData({ ...verdictData, [label]: 42 }),
                    `${subject} must be a non-empty string`
                );
            }
            expectTypeError(
                "acceptance obligation",
                () => decodeRunObligation({ acceptance: 42, kind: "acceptance" }),
                "Acceptance obligation must be a non-empty string"
            );
        }
    );

    it(
        "[run.acceptance-criterion] [run.acceptance-verdict] admits no field beyond the ones it declares",
        { tags: "p1" },
        () => {
            // Every acceptance shape declares its fields as required with no optional set,
            // so an unknown key is refused whatever it is named. The name below is the one
            // a field-set that had quietly grown by one entry would accept.
            const unknown = "Stryker was here";
            expectTypeError(
                "criterion",
                () =>
                    AcceptanceCriterion.fromData({
                        id: firstId.value,
                        operation: operation.value,
                        [unknown]: 1
                    }),
                "Acceptance criterion contains missing or unknown fields"
            );
            expectTypeError(
                "verdict",
                () =>
                    AcceptanceVerdict.fromData({
                        ...objectAt(
                            verdict(firstId, digest("e"), "codec-receipt").toData(),
                            "acceptance verdict"
                        ),
                        [unknown]: 1
                    }),
                "Acceptance verdict contains missing or unknown fields"
            );
            expectTypeError(
                "obligation",
                () =>
                    decodeRunObligation({
                        acceptance: firstId.value,
                        kind: "acceptance",
                        [unknown]: 1
                    }),
                "Acceptance obligation contains missing or unknown fields"
            );
        }
    );
});
