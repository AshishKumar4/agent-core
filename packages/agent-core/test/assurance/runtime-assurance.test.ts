import { describe, expect, test } from "vitest";
import { Digest } from "../../src/core";
import {
    AssuredClaim,
    AssuredClaimId,
    ClaimModality,
    ClaimStanding,
    DeploymentIdentity,
    FaultConsequence,
    DomainEvidenceRef,
    MemoryRuntimeMonitor,
    MonitorBinding,
    MonitorReport,
    MonitorReportId,
    MonitorVerdict,
    ObservationWindow,
    PremiseStanding,
    RuntimeAssuranceLedger,
    RuntimeFault,
    RuntimeFaultId,
    RuntimeMonitorDeclaration,
    RuntimeMonitorId,
    RuntimePremise,
    RuntimePremiseId
} from "../../src/assurance";
import { expectAgentCoreError, expectAgentCoreRejection } from "../protocol/error-assertion";

const monitorId = new RuntimeMonitorId("runtime-fault-monitor");
const retention = RuntimePremise.durableRecordRetention;
const integrity = RuntimePremise.durableRecordIntegrity;
const delivery = RuntimePremise.eventualDelivery;
const retentionClaim = new AssuredClaim(
    new AssuredClaimId("AC-RUNTIME-RETENTION"),
    ClaimModality.safety,
    [retention]
);
const deliveryClaim = new AssuredClaim(
    new AssuredClaimId("NC-RUNTIME-DELIVERY"),
    ClaimModality.liveness,
    [delivery]
);
const declaration = new RuntimeMonitorDeclaration(monitorId, [retention]);
const deployment = new DeploymentIdentity(digest("a"), digest("b"), digest("c"));
const evidence = new DomainEvidenceRef("audit.record", "retention-discharge");

function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

function ledger(
    declarations: readonly RuntimeMonitorDeclaration[] = [declaration],
    claims: readonly AssuredClaim[] = [retentionClaim]
): RuntimeAssuranceLedger {
    return RuntimeAssuranceLedger.create(deployment, declarations, claims);
}

function report(
    id: string,
    binding: MonitorBinding,
    covers: readonly RuntimePremise[] = [retention],
    violations: readonly MonitorVerdict[] = [],
    unmodeledEventTags: readonly number[] = []
): MonitorReport {
    return new MonitorReport(
        new MonitorReportId(id),
        monitorId,
        binding,
        covers,
        violations,
        unmodeledEventTags
    );
}

function binding(
    openedAtMs: number,
    closedAtMs: number,
    identity: DeploymentIdentity = deployment
): MonitorBinding {
    return new MonitorBinding(identity, new ObservationWindow(openedAtMs, closedAtMs));
}

describe("Runtime assurance ledger", () => {
    test(
        "keeps a clean monitor report conditional until a durable domain record discharges it",
        { tags: "p0" },
        () => {
            const initial = ledger();
            const clean = report("clean-observation", binding(1, 10));
            const admitted = initial.admitReport(clean);

            expect(admitted.standingOf(retention)).toBe(PremiseStanding.conditional);
            expect(admitted.standingOfClaim(retentionClaim)).toBe(ClaimStanding.conditional);
            expect(admitted.watchingReports(retention, 5)).toHaveLength(1);
            expect(admitted.admitReport(clean)).toBe(admitted);

            const discharged = admitted.recordDomainEvidence(retention, evidence);
            expect(discharged.standingOf(retention)).toBe(PremiseStanding.discharged);
            expect(discharged.standingOfClaim(retentionClaim)).toBe(ClaimStanding.residual);
            expect(discharged.evidenceFor(retention)).toBe(evidence);
        }
    );

    test(
        "lets a monitor refute an established premise without replacing its durable evidence",
        { tags: "p0" },
        () => {
            const established = ledger().recordDomainEvidence(retention, evidence);
            const violation = new MonitorVerdict(
                RuntimeFault.storedRecordAbsentAfterCommit,
                retention
            );
            const refuted = established.admitReport(
                report("retention-loss", binding(11, 12), [retention], [violation])
            );

            expect(refuted.evidenceFor(retention)).toBe(evidence);
            expect(refuted.standingOf(retention)).toBe(PremiseStanding.refuted);
            expect(refuted.standingOfClaim(retentionClaim)).toBe(ClaimStanding.voided);
            expect(refuted.failedPremises(retentionClaim)).toEqual([retention]);
            expect(refuted.voidedClaims()).toEqual([retentionClaim]);
        }
    );

    test(
        "keeps a stale report's violation but never treats its closed window as live coverage",
        { tags: "p0" },
        () => {
            const staleClean = ledger().admitReport(report("stale-clean", binding(1, 2)));
            expect(staleClean.watchingReports(retention, 3)).toEqual([]);
            expect(staleClean.standingOf(retention)).toBe(PremiseStanding.conditional);

            const violation = new MonitorVerdict(
                RuntimeFault.storedRecordAbsentAfterCommit,
                retention
            );
            const staleViolation = ledger().admitReport(
                report("stale-violation", binding(1, 2), [retention], [violation])
            );
            expect(staleViolation.watchingReports(retention, 3)).toEqual([]);
            expect(staleViolation.standingOf(retention)).toBe(PremiseStanding.refuted);
        }
    );

    test(
        "keeps a missing memory observation conditional and unwatched",
        { tags: "p0" },
        async () => {
            const monitor = new MemoryRuntimeMonitor(declaration, [undefined]);
            const initial = ledger();
            const observed = await initial.observe(monitor, 5);

            expect(observed).toBe(initial);
            expect(observed.standingOf(retention)).toBe(PremiseStanding.conditional);
            expect(observed.watchingReports(retention, 5)).toEqual([]);
            expect(await observed.observe(monitor, 5)).toBe(observed);
        }
    );

    test("refuses reports bound to another model, adapter, or runtime", { tags: "p0" }, () => {
        const modelDrift = new DeploymentIdentity(digest("d"), digest("b"), digest("c"));
        const adapterDrift = new DeploymentIdentity(digest("a"), digest("d"), digest("c"));
        const runtimeDrift = new DeploymentIdentity(digest("a"), digest("b"), digest("d"));
        const foreignDeployments: readonly (readonly [string, DeploymentIdentity])[] = [
            ["wrong-model", modelDrift],
            ["wrong-adapter", adapterDrift],
            ["wrong-runtime", runtimeDrift]
        ];

        for (const [id, foreign] of foreignDeployments) {
            expectAgentCoreError(
                () => ledger().admitReport(report(id, binding(1, 2, foreign))),
                "assurance.observation-refused"
            );
            expect(binding(1, 2, foreign).digest.equals(binding(1, 2).digest)).toBe(false);
        }

        expect(binding(1, 2).digest.equals(binding(1, 3).digest)).toBe(false);
    });

    test(
        "refuses a report that substitutes its declared coverage or reuses its id",
        { tags: "p0" },
        () => {
            const coverageDeclaration = new RuntimeMonitorDeclaration(monitorId, [retention]);
            const substitutedCoverage = report(
                "coverage-substitution",
                binding(1, 2),
                [integrity],
                [new MonitorVerdict(RuntimeFault.storedRecordReadBackDifferent, integrity)]
            );
            expectAgentCoreError(
                () =>
                    RuntimeAssuranceLedger.create(
                        deployment,
                        [coverageDeclaration],
                        [retentionClaim]
                    ).admitReport(substitutedCoverage),
                "assurance.observation-refused"
            );

            const accepted = ledger().admitReport(report("reused-id", binding(1, 2)));
            const substituted = report("reused-id", binding(1, 2), [retention], [], [99]);
            expectAgentCoreError(
                () => accepted.admitReport(substituted),
                "assurance.observation-refused"
            );
        }
    );

    test(
        "refuses an outside-model fault instead of promoting it into a premise",
        { tags: "p0" },
        () => {
            const reordered = new MonitorVerdict(RuntimeFault.messageReordered, retention);
            expectAgentCoreError(
                () =>
                    ledger().admitReport(
                        report("reordered-message", binding(1, 2), [retention], [reordered])
                    ),
                "assurance.observation-refused"
            );

            const acknowledgement = new MonitorVerdict(
                RuntimeFault.remoteAcknowledgementLost,
                retention
            );
            expectAgentCoreError(
                () =>
                    ledger().admitReport(
                        report("lost-ack", binding(1, 2), [retention], [acknowledgement])
                    ),
                "assurance.observation-refused"
            );
        }
    );

    test(
        "an outside-model event voids coverage but cannot suppress a modeled verdict",
        { tags: "p0" },
        () => {
            const violation = new MonitorVerdict(
                RuntimeFault.storedRecordAbsentAfterCommit,
                retention
            );
            const result = ledger().admitReport(
                report("unmodeled-event", binding(1, 10), [retention], [violation], [7])
            );

            expect(result.standingOf(retention)).toBe(PremiseStanding.refuted);
            expect(result.watchingReports(retention, 5)).toEqual([]);
        }
    );

    test(
        "separates a progress refutation from a safety claim's residual standing",
        { tags: "p0" },
        () => {
            const progressDeclaration = new RuntimeMonitorDeclaration(
                new RuntimeMonitorId("delivery-monitor"),
                [delivery]
            );
            const safetyAndLiveness = RuntimeAssuranceLedger.create(
                deployment,
                [declaration, progressDeclaration],
                [retentionClaim, deliveryClaim]
            )
                .recordDomainEvidence(retention, evidence)
                .recordDomainEvidence(
                    delivery,
                    new DomainEvidenceRef("audit.record", "delivery-discharge")
                )
                .recordDurableRefutation(
                    RuntimeFault.deliveryExceededDeclaredBound,
                    new DomainEvidenceRef("audit.record", "delivery-failure")
                );

            expect(safetyAndLiveness.standingOfClaim(retentionClaim)).toBe(ClaimStanding.residual);

            const unconditional = new AssuredClaim(
                new AssuredClaimId("AC-RUNTIME-UNCONDITIONAL"),
                ClaimModality.safety,
                []
            );
            const withUnconditional = RuntimeAssuranceLedger.create(
                deployment,
                [declaration],
                [retentionClaim, unconditional]
            ).recordDurableRefutation(
                RuntimeFault.storedRecordAbsentAfterCommit,
                new DomainEvidenceRef("audit.record", "unconditional-check")
            );
            expect(withUnconditional.standingOfClaim(unconditional)).toBe(ClaimStanding.residual);
            expect(safetyAndLiveness.standingOfClaim(deliveryClaim)).toBe(ClaimStanding.voided);
            expect(safetyAndLiveness.residualClaims()).toEqual([retentionClaim]);
            expect(safetyAndLiveness.voidedClaims()).toEqual([deliveryClaim]);
        }
    );

    test(
        "maps every premise to a refutable fault while preserving modeled transport and acknowledgement ambiguity",
        { tags: "p0" },
        () => {
            const refutedPremiseIds: string[] = [];
            for (const fault of RuntimeFault.all) {
                const premise = fault.consequence.premise;
                if (premise !== undefined) refutedPremiseIds.push(premise.id.value);
            }

            expect([...refutedPremiseIds].sort()).toEqual(
                RuntimePremise.all.map((premise) => premise.id.value).sort()
            );
            expect(RuntimeFault.withinModelFaults.map((fault) => fault.id.value)).toEqual([
                "restart-lost-volatile-state",
                "caller-submitted-over-bound-payload",
                "message-lost",
                "message-duplicated",
                "message-reordered",
                "remote-acknowledgement-lost"
            ]);
        }
    );

    test(
        "preserves idempotent evidence and refutation writes while refusing conflicting evidence",
        { tags: "p0" },
        () => {
            const discharged = ledger().recordDomainEvidence(retention, evidence);
            expect(discharged.recordDomainEvidence(retention, evidence)).toBe(discharged);
            expectAgentCoreError(
                () =>
                    discharged.recordDomainEvidence(
                        retention,
                        new DomainEvidenceRef("audit.record", "other-retention-discharge")
                    ),
                "assurance.duplicate-evidence"
            );

            const refutationEvidence = new DomainEvidenceRef("audit.record", "retention-failure");
            const refuted = ledger().recordDurableRefutation(
                RuntimeFault.storedRecordAbsentAfterCommit,
                refutationEvidence
            );
            expect(
                refuted.recordDurableRefutation(
                    RuntimeFault.storedRecordAbsentAfterCommit,
                    refutationEvidence
                )
            ).toBe(refuted);
            expect(refuted.refutationsFor(retention)).toHaveLength(1);
            expect(refuted.unestablishedPremises(retentionClaim)).toEqual([]);
            expectAgentCoreError(
                () =>
                    ledger().recordDurableRefutation(
                        RuntimeFault.messageLost,
                        new DomainEvidenceRef("audit.record", "lost-message")
                    ),
                "assurance.observation-refused"
            );
        }
    );

    test(
        "rejects malformed declarations and unknown premise or fault names",
        { tags: "p1" },
        () => {
            expect(() => new ObservationWindow(2, 1)).toThrow(
                "Observation window closes before it opens"
            );
            expect(() => new DomainEvidenceRef("invalid kind", "record")).toThrow(TypeError);
            expect(() => new RuntimePremiseId("Uppercase")).toThrow(TypeError);
            expectAgentCoreError(
                () => RuntimePremise.named(new RuntimePremiseId("not-a-premise")),
                "assurance.unknown-premise"
            );
            expectAgentCoreError(
                () => RuntimeFault.named(new RuntimeFaultId("not-a-fault")),
                "assurance.unknown-fault"
            );
            expect(RuntimePremise.named(retention.id)).toBe(retention);
            expect(RuntimeFault.named(RuntimeFault.messageLost.id)).toBe(RuntimeFault.messageLost);
            expect(
                RuntimeFault.messageLost.equals(RuntimeFault.named(RuntimeFault.messageLost.id))
            ).toBe(true);
            expectAgentCoreError(
                () =>
                    new AssuredClaim(
                        new AssuredClaimId("NC-MISSING-PROGRESS"),
                        ClaimModality.liveness,
                        []
                    ),
                "assurance.invalid-claim"
            );
            expectAgentCoreError(
                () =>
                    new AssuredClaim(
                        new AssuredClaimId("AC-PROGRESS-SAFETY"),
                        ClaimModality.safety,
                        [delivery]
                    ),
                "assurance.invalid-claim"
            );
            expectAgentCoreError(
                () => new RuntimeMonitorDeclaration(monitorId, [retention, retention]),
                "assurance.observation-refused"
            );
            expectAgentCoreError(
                () =>
                    RuntimeAssuranceLedger.create(
                        deployment,
                        [declaration, declaration],
                        [retentionClaim]
                    ),
                "assurance.observation-refused"
            );
            expectAgentCoreError(
                () =>
                    RuntimeAssuranceLedger.create(
                        deployment,
                        [declaration],
                        [retentionClaim, retentionClaim]
                    ),
                "assurance.invalid-claim"
            );

            // @ts-expect-error Runtime checks defend decoded hostile values too.
            expect(() => FaultConsequence.refutes({})).toThrow(TypeError);

            // @ts-expect-error A non-DomainEvidenceRef is a contract violation, not a conflict.
            expect(() => ledger().recordDomainEvidence(retention, {})).toThrow(TypeError);
        }
    );

    test(
        "accepts a declared memory monitor and refuses a foreign claim or monitor",
        { tags: "p0" },
        async () => {
            const liveReport = report("memory-observation", binding(1, 10));
            const observed = await ledger().observe(
                new MemoryRuntimeMonitor(declaration, [liveReport]),
                5
            );
            expect(observed.reports).toEqual([liveReport]);
            expect(observed.watchingReports(retention, 5)).toEqual([liveReport]);
            expect(observed.conditionalClaims()).toEqual([retentionClaim]);

            const foreignClaim = new AssuredClaim(
                new AssuredClaimId("AC-RUNTIME-INTEGRITY"),
                ClaimModality.safety,
                [integrity]
            );
            expectAgentCoreError(
                () => observed.standingOfClaim(foreignClaim),
                "assurance.invalid-claim"
            );

            const foreignDeclaration = new RuntimeMonitorDeclaration(
                new RuntimeMonitorId("foreign-monitor"),
                [retention]
            );
            await expectAgentCoreRejection(
                observed.observe(new MemoryRuntimeMonitor(foreignDeclaration, [undefined]), 5),
                "assurance.observation-refused"
            );
        }
    );

    test(
        "compaction drops closed clean reports while preserving standing and live coverage",
        { tags: "p0" },
        () => {
            const closedClean = report("compaction-closed-clean", binding(1, 10));
            const liveClean = report("compaction-live-clean", binding(1, 100));
            const futureClean = report("compaction-future-clean", binding(50, 90));
            const violation = new MonitorVerdict(
                RuntimeFault.storedRecordAbsentAfterCommit,
                retention
            );
            const closedViolated = report(
                "compaction-closed-violated",
                binding(1, 4),
                [retention],
                [violation]
            );
            const before = ledger()
                .admitReport(closedClean)
                .admitReport(liveClean)
                .admitReport(futureClean)
                .admitReport(closedViolated);

            const compacted = before.compact(11);

            expect(compacted.reports).toEqual([liveClean, futureClean, closedViolated]);
            expect(compacted.watchingReports(retention, 60)).toEqual(
                before.watchingReports(retention, 60)
            );
            expect(compacted.standingOf(retention)).toBe(before.standingOf(retention));
            expect(compacted.refutationsFor(retention)).toEqual(before.refutationsFor(retention));
            expect(compacted.watchingReports(retention, 11)).toEqual(
                before.watchingReports(retention, 11)
            );
            expect(compacted.standingOfClaim(retentionClaim)).toBe(
                before.standingOfClaim(retentionClaim)
            );
        }
    );

    test(
        "compaction keeps a discharged premise discharged and re-admits a replayed clean report",
        { tags: "p1" },
        () => {
            const closedClean = report("compaction-replay", binding(1, 4));
            const discharged = ledger()
                .recordDomainEvidence(retention, evidence)
                .admitReport(closedClean);

            const compacted = discharged.compact(9);
            expect(compacted.reports).toEqual([]);
            expect(compacted.standingOf(retention)).toBe(PremiseStanding.discharged);
            expect(compacted.evidenceFor(retention)).toBe(evidence);

            const replayed = compacted.admitReport(closedClean);
            expect(replayed.reports).toEqual([closedClean]);
            expect(replayed.standingOf(retention)).toBe(PremiseStanding.discharged);
            expect(replayed.watchingReports(retention, 9)).toEqual([]);
        }
    );
});
