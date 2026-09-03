import { describe, expect, test } from "vitest";
import { Digest } from "../../src/core";
import {
    AssuredClaim,
    AssuredClaimId,
    ClaimModality,
    ClaimStanding,
    DeploymentIdentity,
    DomainEvidenceRef,
    MemoryRuntimeMonitor,
    MonitorBinding,
    MonitorReport,
    MonitorReportId,
    MonitorVerdict,
    ObservationWindow,
    PremiseStanding,
    RefutationSource,
    RuntimeAssuranceLedger,
    RuntimeFault,
    RuntimeMonitor,
    RuntimeMonitorDeclaration,
    RuntimeMonitorId,
    RuntimePremise,
    RuntimeRefutation
} from "../../src/assurance";
import { expectAgentCoreError, expectAgentCoreRejection } from "../protocol/error-assertion";

const monitorId = new RuntimeMonitorId("runtime-fault-monitor");
const retention = RuntimePremise.durableRecordRetention;
const integrity = RuntimePremise.durableRecordIntegrity;
const delivery = RuntimePremise.eventualDelivery;
const retentionLoss = RuntimeFault.storedRecordAbsentAfterCommit;
const integrityLoss = RuntimeFault.storedRecordReadBackDifferent;
const deliveryLoss = RuntimeFault.deliveryExceededDeclaredBound;
const deployment = new DeploymentIdentity(digest("a"), digest("b"), digest("c"));
const declaration = new RuntimeMonitorDeclaration(monitorId, [retention]);
const bothDeclaration = new RuntimeMonitorDeclaration(monitorId, [retention, integrity]);
const retentionClaim = new AssuredClaim(
    new AssuredClaimId("AC-RUNTIME-RETENTION"),
    ClaimModality.safety,
    [retention]
);
const evidence = new DomainEvidenceRef("audit.record", "retention-discharge");

/**
 * A TypeError whose message names the exact contract that refused. The message matters: with
 * the guard gone, the very next line usually raises a TypeError of its own, and a test that
 * only asked for the type would pass against the removed guard.
 */
function expectTypeError(operation: () => void, message: RegExp): void {
    let failure: unknown;
    try {
        operation();
    } catch (error) {
        failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).toMatchObject({ message: expect.stringMatching(message) });
}

function digest(character: string): Digest {
    return new Digest(character.repeat(64));
}

function binding(openedAtMs: number, closedAtMs: number): MonitorBinding {
    return new MonitorBinding(deployment, new ObservationWindow(openedAtMs, closedAtMs));
}

function report(
    id: string,
    covers: readonly RuntimePremise[] = [retention],
    violations: readonly MonitorVerdict[] = [],
    unmodeledEventTags: readonly number[] = []
): MonitorReport {
    return new MonitorReport(
        new MonitorReportId(id),
        monitorId,
        binding(1, 10),
        covers,
        violations,
        unmodeledEventTags
    );
}

function ledger(
    declarations: readonly RuntimeMonitorDeclaration[] = [declaration],
    claims: readonly AssuredClaim[] = [retentionClaim]
): RuntimeAssuranceLedger {
    return RuntimeAssuranceLedger.create(deployment, declarations, claims);
}

/**
 * An adapter that answers the observation seam with something that is not a report. The seam
 * is a real boundary to a platform watcher, so what arrives across it is decoded input.
 */
class NonReportingMonitor extends RuntimeMonitor {
    public observe(): Promise<MonitorReport | undefined> {
        // @ts-expect-error A broken or hostile adapter answers whatever it likes here.
        return Promise.resolve({ monitor: monitorId, covers: this.covers, violations: [] });
    }
}

/** An adapter that answers with a report another monitor produced. */
class BorrowedReportMonitor extends RuntimeMonitor {
    public constructor(
        declaredAs: RuntimeMonitorDeclaration,
        private readonly answer: MonitorReport
    ) {
        super(declaredAs);
    }

    public observe(): Promise<MonitorReport | undefined> {
        return Promise.resolve(this.answer);
    }
}

describe("the assurance plane refuses what it cannot account for", () => {
    test("admits only the two planes' claim identifiers", { tags: "p0" }, () => {
        // D-2: routing a claim through the wrong plane is the mistake this identity exists to
        // prevent, so the shape is checked rather than inferred from context. Both planes'
        // shapes are admitted, and an `ASM-*` traceability assumption is not one of them —
        // minting one here would assert a ledger entry this plane does not carry.
        for (const value of [
            "AC-COMPOSED-001",
            "NC-RUNTIME-DELIVERY",
            "C13-TURN-HANDLE-DETACHMENT",
            "P11-PREMISE-LEDGER"
        ]) {
            expect(new AssuredClaimId(value).value).toBe(value);
        }
        for (const value of [
            "ASM-TRANSITION-ATOMICITY",
            "AC_COMPOSED_001",
            "ac-composed-001",
            "AC-",
            "AC-composed-001",
            "XX-COMPOSED-001",
            "C14-TURN-HANDLE"
        ]) {
            expect(() => new AssuredClaimId(value), value).toThrow(TypeError);
        }
    });

    test("refuses a claim that is not the reviewed record it claims to be", { tags: "p1" }, () => {
        // `support` is reviewed input under AGENT_OPERATING_DOCTRINE.md, so a claim assembled
        // from decoded values is refused at construction: the blast radius this plane computes
        // is only as sound as the mapping it was handed.
        // @ts-expect-error A decoded value is not an AssuredClaimId.
        expect(() => new AssuredClaim("AC-RUNTIME-RETENTION", ClaimModality.safety, [])).toThrow(
            TypeError
        );
        expectTypeError(
            // @ts-expect-error A modality is a sealed case, not the string that names it.
            () => new AssuredClaim(new AssuredClaimId("AC-SHAPE"), "safety", []),
            /modality must be a ClaimModality/u
        );
        expectTypeError(
            // @ts-expect-error Support holds premises, not the names of premises.
            () => new AssuredClaim(new AssuredClaimId("AC-SHAPE"), ClaimModality.safety, ["x"]),
            /support must hold RuntimePremise values/u
        );
        // A repeated premise would count one assumption twice in every answer derived from the
        // support, including the injective claim key the ledger identifies it by.
        expectAgentCoreError(
            () =>
                new AssuredClaim(new AssuredClaimId("AC-SHAPE"), ClaimModality.safety, [
                    retention,
                    retention
                ]),
            "assurance.invalid-claim"
        );
    });

    test("lets a liveness claim rest on safety premises as well", { tags: "p0" }, () => {
        // A liveness claim needs at least one progress premise; it is not confined to them.
        // A rule that refused every safety premise in a liveness claim would make the ordinary
        // case — progress that also depends on durable state — undeclarable.
        const mixed = new AssuredClaim(
            new AssuredClaimId("NC-RUNTIME-MIXED"),
            ClaimModality.liveness,
            [retention, delivery]
        );
        expect(mixed.wellFormed()).toBe(true);
        expect(mixed.support).toEqual([retention, delivery]);
        expectAgentCoreError(
            () =>
                new AssuredClaim(new AssuredClaimId("NC-RUNTIME-SAFETY"), ClaimModality.liveness, [
                    retention,
                    integrity
                ]),
            "assurance.invalid-claim"
        );
    });

    test(
        "refuses a claim whose support is not the support this ledger registered",
        { tags: "p0" },
        () => {
            // Standing is computed from the reviewed support, so a caller that could present
            // the same claim id carrying a narrower support set would obtain a residual answer
            // for a claim whose real premises include a refuted one. That is the fabricated
            // answer this plane exists to refuse, and claim identity alone cannot catch it:
            // the two claims are equal by ledger id.
            const both = new AssuredClaim(
                new AssuredClaimId("AC-RUNTIME-BOTH"),
                ClaimModality.safety,
                [retention, integrity]
            );
            const narrowed = new AssuredClaim(
                new AssuredClaimId("AC-RUNTIME-BOTH"),
                ClaimModality.safety,
                [retention]
            );
            expect(narrowed.equals(both)).toBe(true);
            expect(narrowed.key).not.toBe(both.key);

            const registered = ledger([bothDeclaration], [both]).recordDomainEvidence(
                retention,
                evidence
            );
            expect(registered.standingOfClaim(both)).toBe(ClaimStanding.conditional);
            expectAgentCoreError(
                () => registered.standingOfClaim(narrowed),
                "assurance.invalid-claim"
            );
            expectAgentCoreError(
                // @ts-expect-error A decoded value is not an AssuredClaim.
                () => registered.standingOfClaim({ id: both.id, key: both.key }),
                "assurance.invalid-claim"
            );
        }
    );

    test("names exactly which premises void a claim and which hold it open", { tags: "p0" }, () => {
        // The answer incident review needs is not that a claim is voided but which of its
        // premises did it, and which of the rest are merely not established. A query that
        // returned the whole support would name premises this ledger holds evidence for.
        const both = new AssuredClaim(new AssuredClaimId("AC-RUNTIME-PAIR"), ClaimModality.safety, [
            retention,
            integrity
        ]);
        const partly = ledger([bothDeclaration], [both]).recordDomainEvidence(
            integrity,
            new DomainEvidenceRef("audit.record", "integrity-discharge")
        );
        expect(partly.standingOfClaim(both)).toBe(ClaimStanding.conditional);
        expect(partly.unestablishedPremises(both)).toEqual([retention]);
        expect(partly.failedPremises(both)).toEqual([]);

        const refuted = partly.recordDurableRefutation(
            integrityLoss,
            new DomainEvidenceRef("audit.record", "integrity-failure")
        );
        expect(refuted.standingOfClaim(both)).toBe(ClaimStanding.voided);
        expect(refuted.failedPremises(both)).toEqual([integrity]);
        expect(refuted.unestablishedPremises(both)).toEqual([retention]);
        expect(refuted.refutationsFor(retention)).toEqual([]);
        expect(refuted.refutationsFor(integrity)).toHaveLength(1);
    });

    test("keeps an observed refutation and a durable one as two records", { tags: "p0" }, () => {
        // A monitor observation and a durable record are deliberately different sources so
        // incident review can tell a recorded fact from an observation. Collapsing them onto
        // one entry — which is what a source-blind refutation key would do — erases which of
        // the two this deployment actually holds.
        const observed = ledger().admitReport(
            report(
                "retention-observed",
                [retention],
                [new MonitorVerdict(retentionLoss, retention)]
            )
        );
        const failure = new DomainEvidenceRef("audit.record", "retention-failure");
        const both = observed.recordDurableRefutation(retentionLoss, failure);

        const sources = both.refutationsFor(retention).map((refutation) => refutation.source.key);
        expect(new Set(sources).size).toBe(2);
        expect(both.standingOf(retention)).toBe(PremiseStanding.refuted);
        expect(both.recordDurableRefutation(retentionLoss, failure)).toBe(both);
    });

    test("refuses a refutation assembled from anything but its own types", { tags: "p1" }, () => {
        // @ts-expect-error A report identity is not the string that spells it.
        expect(() => RefutationSource.observed("report-1")).toThrow(TypeError);
        // @ts-expect-error A durable record reference is not a bare record kind.
        expect(() => RefutationSource.durable("audit.record")).toThrow(TypeError);
        const durable = RefutationSource.durable(evidence);
        expectTypeError(
            // @ts-expect-error A refutation names a fault from the closed vocabulary.
            () => new RuntimeRefutation({ id: retentionLoss.id }, durable),
            /fault must be a RuntimeFault/u
        );
        expect(() => new RuntimeRefutation(retentionLoss, { key: "observed" })).toThrow(TypeError);
    });

    test("refuses a refutation for a fault the model already carries", { tags: "p0" }, () => {
        // A `withinModel` fault has no premise to blame, so a refutation cannot be built from
        // one. That is what stops an observed message duplication from being recorded as
        // evidence that a platform assumption failed.
        expectAgentCoreError(
            () =>
                new RuntimeRefutation(
                    RuntimeFault.messageDuplicated,
                    RefutationSource.durable(evidence)
                ),
            "assurance.observation-refused"
        );
        expect(
            new RuntimeRefutation(deliveryLoss, RefutationSource.durable(evidence)).premise
        ).toBe(delivery);
    });

    test("refuses to derive a ledger from values it cannot account for", { tags: "p1" }, () => {
        // @ts-expect-error A deployment identity arrives from outside and is never inferred.
        expect(() => RuntimeAssuranceLedger.create({ model: digest("a") }, [], [])).toThrow(
            TypeError
        );
        // @ts-expect-error Declarations are the immutable records, not live monitors.
        expect(() => RuntimeAssuranceLedger.create(deployment, [{ id: monitorId }], [])).toThrow(
            TypeError
        );
        expectTypeError(
            // @ts-expect-error Claims are reviewed records, not their identifiers.
            () => RuntimeAssuranceLedger.create(deployment, [], [retentionClaim.id]),
            /claims must hold AssuredClaim values/u
        );
        // @ts-expect-error Durable evidence is a record reference, not a record kind.
        expect(() => ledger().recordDomainEvidence(retention, "audit.record")).toThrow(TypeError);
    });

    test("defends the premise vocabulary at every query", { tags: "p1" }, () => {
        // Premise equality is by id alone, so a decoded look-alike would otherwise be answered
        // about as though it were the premise it names — including by the standing query the
        // claim answers are computed from.
        // @ts-expect-error A premise is one of the closed vocabulary's values.
        const lookalike: RuntimePremise = { id: retention.id, kind: retention.kind };
        const derived = ledger();
        expect(() => derived.evidenceFor(lookalike)).toThrow(TypeError);
        expect(() => derived.standingOf(lookalike)).toThrow(TypeError);
        expect(() => derived.refutationsFor(lookalike)).toThrow(TypeError);
        expect(() => derived.watchingReports(lookalike, 5)).toThrow(TypeError);
        // An observation instant has to be an instant on the model's own clock.
        expect(() => derived.watchingReports(retention, 1.5)).toThrow(TypeError);
        expect(() => derived.compact(Number.NaN)).toThrow(TypeError);
    });

    test(
        "refuses an observation the deployment did not declare or the monitor did not produce",
        { tags: "p0" },
        async () => {
            // Each of these is a way an observation can arrive without the deployment having
            // asked for it. Absorbing any one would let a refutation — or a coverage claim —
            // enter the projection under a monitor identity nobody declared.
            expectAgentCoreError(
                // @ts-expect-error A report crosses a decoded seam; its shape is not assumed.
                () => ledger().admitReport({ id: new MonitorReportId("shapeless") }),
                "assurance.observation-refused"
            );
            await expectAgentCoreRejection(
                // @ts-expect-error An observer is the seam's own type, not a bare callback.
                ledger().observe({ id: monitorId, observe: () => undefined }, 5),
                "assurance.observation-refused"
            );
            await expect(
                ledger().observe(new MemoryRuntimeMonitor(declaration, [undefined]), 1.5)
            ).rejects.toThrow(TypeError);

            // A monitor declared to watch retention cannot widen itself to storage integrity,
            // even while presenting the declared monitor id.
            const widened = new RuntimeMonitorDeclaration(monitorId, [integrity]);
            await expectAgentCoreRejection(
                ledger().observe(new MemoryRuntimeMonitor(widened, [undefined]), 5),
                "assurance.observation-refused"
            );
            await expectAgentCoreRejection(
                ledger().observe(new NonReportingMonitor(declaration), 5),
                "assurance.observation-refused",
                /returned no MonitorReport/u
            );

            // A report is admitted under the monitor that produced it, so an adapter cannot
            // pass along another monitor's observation as its own.
            const borrowed = new MonitorReport(
                new MonitorReportId("borrowed"),
                new RuntimeMonitorId("other-monitor"),
                binding(1, 10),
                [retention],
                [],
                []
            );
            await expectAgentCoreRejection(
                ledger().observe(new BorrowedReportMonitor(declaration, borrowed), 5),
                "assurance.observation-refused",
                /returned another monitor's report/u
            );
        }
    );

    test("keeps a report's identity independent of the order it arrived in", { tags: "p0" }, () => {
        // Report admission is at-least-once idempotent on the full canonical key, so a
        // redelivery whose coverage, verdicts and unmodeled events arrived in another order is
        // the same observation. Refusing it as a substituted identity would turn an ordinary
        // redelivery into an incident, and admitting it twice would double its refutations.
        const first = new MonitorVerdict(retentionLoss, retention);
        const second = new MonitorVerdict(integrityLoss, integrity);
        const original = new MonitorReport(
            new MonitorReportId("reordered-observation"),
            monitorId,
            binding(1, 10),
            [retention, integrity],
            [first, second],
            [3, 7]
        );
        const redelivered = new MonitorReport(
            new MonitorReportId("reordered-observation"),
            monitorId,
            binding(1, 10),
            [integrity, retention],
            [second, first],
            [7, 3]
        );
        expect(redelivered.key).toBe(original.key);

        const admitted = ledger([bothDeclaration]).admitReport(original);
        expect(admitted.admitReport(redelivered)).toBe(admitted);
        expect(admitted.refutationsFor(retention)).toHaveLength(1);
        expect(admitted.refutationsFor(integrity)).toHaveLength(1);
    });

    test(
        "refuses a scripted observation that does not match its declaration",
        { tags: "p0" },
        () => {
            // The memory monitor is the reference observer that contract tests and local model
            // exercises trust. A script holding another monitor's report, a widened one, or a
            // value that is not a report at all would put an observation the ledger's own
            // checks exist to catch behind a seam consumers treat as sound.
            expectTypeError(
                // @ts-expect-error A decoded script may hold anything.
                () => new MemoryRuntimeMonitor(declaration, [{ id: monitorId }]),
                /results must be MonitorReport values or undefined/u
            );
            const foreign = new MonitorReport(
                new MonitorReportId("foreign-scripted"),
                new RuntimeMonitorId("other-monitor"),
                binding(1, 10),
                [retention],
                [],
                []
            );
            expect(() => new MemoryRuntimeMonitor(declaration, [foreign])).toThrow(TypeError);
            expect(
                () =>
                    new MemoryRuntimeMonitor(declaration, [
                        report("widened-scripted", [retention, integrity])
                    ])
            ).toThrow(TypeError);
        }
    );

    test("keeps a memory monitor's script and its instant honest", { tags: "p1" }, async () => {
        // The script is snapshotted at construction: a caller that kept its array could
        // otherwise decide, after the fact, what a monitor already handed the ledger.
        const scripted = report("scripted-observation");
        const script: (MonitorReport | undefined)[] = [scripted];
        const monitor = new MemoryRuntimeMonitor(declaration, script);
        script.length = 0;
        script.push(undefined);

        await expect(monitor.observe(1.5)).rejects.toThrow(TypeError);
        expect(await monitor.observe(5)).toBe(scripted);
        // The script is consumed, and an exhausted monitor reports a missing observation
        // rather than repeating its last word.
        expect(await monitor.observe(5)).toBeUndefined();
    });

    test("refuses an observation window that is not a possible interval", { tags: "p1" }, () => {
        expect(() => new ObservationWindow(1.5, 10)).toThrow(TypeError);
        expect(() => new ObservationWindow(1, Number.NaN)).toThrow(TypeError);
        expect(() => new ObservationWindow(1, 10).covers(Number.POSITIVE_INFINITY)).toThrow(
            TypeError
        );
        // Both ends are inclusive, so an instantaneous window covers its own instant and
        // nothing else. An exclusive end would silently drop the coverage of every window at
        // the instant it closed.
        const instant = new ObservationWindow(4, 4);
        expect([instant.covers(3), instant.covers(4), instant.covers(5)]).toEqual([
            false,
            true,
            false
        ]);
    });

    test("refuses a binding assembled from anything but fingerprints", { tags: "p1" }, () => {
        // A monitor stamps these identities on every report and certifies none of them, so a
        // binding built from a value that is not a Digest would circulate an identity the
        // deployment cannot compare itself against.
        const printed = "a".repeat(64);
        // @ts-expect-error A fingerprint is a Digest, not the string it prints as.
        expect(() => new DeploymentIdentity(printed, digest("b"), digest("c"))).toThrow(TypeError);
        // @ts-expect-error The adapter build is checked the same way.
        expect(() => new DeploymentIdentity(digest("a"), printed, digest("c"))).toThrow(TypeError);
        // @ts-expect-error And so is the runtime.
        expect(() => new DeploymentIdentity(digest("a"), digest("b"), printed)).toThrow(TypeError);
        const parts = { model: digest("a"), adapter: digest("b"), runtime: digest("c") };
        expect(() => new MonitorBinding(parts, new ObservationWindow(1, 2))).toThrow(TypeError);
        // @ts-expect-error A binding's window is the interval type, not a pair of numbers.
        expect(() => new MonitorBinding(deployment, { openedAtMs: 1, closedAtMs: 2 })).toThrow(
            TypeError
        );
        // `matches` is a predicate over a decoded report, so a structural look-alike answers
        // false rather than passing for the deployment it imitates.
        expect(binding(1, 2).matches(parts)).toBe(false);
        expect(binding(1, 2).matches(deployment)).toBe(true);
    });

    test("refuses a verdict, declaration, or coverage set it cannot trust", { tags: "p1" }, () => {
        // @ts-expect-error A verdict names a fault from the closed vocabulary.
        expect(() => new MonitorVerdict({ id: retentionLoss.id }, retention)).toThrow(TypeError);
        // @ts-expect-error A verdict blames a premise, not the name of one.
        expect(() => new MonitorVerdict(retentionLoss, "durable-record-retention")).toThrow(
            TypeError
        );
        // @ts-expect-error A declaration is keyed by the monitor identity type.
        expect(() => new RuntimeMonitorDeclaration("runtime-fault-monitor", [retention])).toThrow(
            TypeError
        );
        expectTypeError(
            // @ts-expect-error Coverage holds premises, not their names.
            () => new RuntimeMonitorDeclaration(monitorId, ["retention"]),
            /coverage must hold RuntimePremise values/u
        );
        // @ts-expect-error The observation seam is implemented against the declaration type.
        expect(() => new NonReportingMonitor({ id: monitorId, covers: [retention] })).toThrow(
            TypeError
        );
    });

    test("keeps declared coverage exact rather than merely the same size", { tags: "p0" }, () => {
        // A monitor built to watch retention must not be able to blame storage integrity by
        // swapping one premise for another, which a size comparison would admit.
        expect(declaration.coversExactly([retention])).toBe(true);
        expect(declaration.coversExactly([integrity])).toBe(false);
        expect(declaration.coversExactly([retention, integrity])).toBe(false);
        // Coverage is a set, so the declared order is not part of the claim.
        expect(bothDeclaration.coversExactly([integrity, retention])).toBe(true);
    });

    test("refuses a report whose parts are not the parts it names", { tags: "p1" }, () => {
        const window = binding(1, 10);
        const id = new MonitorReportId("report-1");
        // @ts-expect-error A report identity is the id type, not the string it prints as.
        expect(() => new MonitorReport("report-1", monitorId, window, [retention], [], [])).toThrow(
            TypeError
        );
        // @ts-expect-error The monitor identity is the id type for the same reason.
        expect(() => new MonitorReport(id, "runtime-fault-monitor", window, [], [], [])).toThrow(
            TypeError
        );
        const parts = { deployment, window: new ObservationWindow(1, 10) };
        // @ts-expect-error A binding is the commitment over those parts, not the parts.
        expect(() => new MonitorReport(id, monitorId, parts, [retention], [], [])).toThrow(
            TypeError
        );
        expectTypeError(
            // @ts-expect-error Violations hold verdicts, not fault identifiers.
            () => new MonitorReport(id, monitorId, window, [retention], [retentionLoss], []),
            /violations must hold MonitorVerdict values/u
        );
        // A repeated verdict would count one refutation twice in the projection.
        const repeated = [
            new MonitorVerdict(retentionLoss, retention),
            new MonitorVerdict(retentionLoss, retention)
        ];
        expectAgentCoreError(
            () => new MonitorReport(id, monitorId, window, [retention], repeated, []),
            "assurance.observation-refused"
        );
    });

    test("refuses an unmodeled event tally that cannot be counted", { tags: "p1" }, () => {
        // The tags are how a monitor reports what it saw and could not describe. A negative or
        // fractional tag names no event, and a repeated one overstates what the monitor could
        // not model — which is the fact that voids its coverage.
        for (const tags of [[-1], [1.5], [Number.NaN]]) {
            expect(() => report("unmodeled-shape", [retention], [], tags), String(tags)).toThrow(
                TypeError
            );
        }
        expectAgentCoreError(
            () => report("unmodeled-repeat", [retention], [], [7, 7]),
            "assurance.observation-refused"
        );
        expect(report("unmodeled-pair", [retention], [], [7, 3]).claimsCoverage()).toBe(false);
        expect(report("unmodeled-none").claimsCoverage()).toBe(true);
    });

    test("answers `watches` false for a value that is not a premise", { tags: "p0" }, () => {
        // Coverage is asked about decoded values and premise equality is by id alone, so a
        // look-alike carrying a covered premise's id would otherwise obtain live coverage from
        // a report that never watched it.
        const watching = report("coverage-observation");
        expect(watching.watches(retention, 5)).toBe(true);
        // @ts-expect-error The predicate's whole job is to reject this value.
        expect(watching.watches({ id: retention.id, kind: retention.kind }, 5)).toBe(false);
        expect(watching.watches(integrity, 5)).toBe(false);
    });
});
