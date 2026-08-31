import { canonicalTupleKey } from "../core";
import { AgentCoreError } from "../errors";
import { AssuredClaim, ClaimStanding } from "./claim";
import { MonitorReportId, RuntimeMonitorId } from "./id";
import {
    DeploymentIdentity,
    MonitorReport,
    RuntimeMonitor,
    RuntimeMonitorDeclaration
} from "./monitor";
import { RuntimeFault } from "./fault";
import { DomainEvidenceRef, PremiseStanding, RuntimePremise } from "./premise";

/** Where one refutation came from. A durable record and a monitor observation both may refute
an assumption. They are deliberately different types, so incident review can distinguish a
recorded fact from an observation without reconstructing it from prose. */
export abstract class RefutationSource {
    public static observed(report: MonitorReportId): RefutationSource {
        return new ObservedRefutationSource(report);
    }
    public static durable(record: DomainEvidenceRef): RefutationSource {
        return new DurableRefutationSource(record);
    }

    public abstract readonly key: string;
}

class ObservedRefutationSource extends RefutationSource {
    public constructor(public readonly report: MonitorReportId) {
        super();
        if (!(report instanceof MonitorReportId)) {
            throw new TypeError("Observed refutation source must name a MonitorReportId");
        }
        Object.freeze(this);
    }

    public get key(): string {
        return canonicalTupleKey("assurance.refutation-source", ["observed", this.report.value]);
    }
}

class DurableRefutationSource extends RefutationSource {
    public constructor(public readonly record: DomainEvidenceRef) {
        super();
        if (!(record instanceof DomainEvidenceRef)) {
            throw new TypeError("Durable refutation source must name a DomainEvidenceRef");
        }
        Object.freeze(this);
    }

    public get key(): string {
        return canonicalTupleKey("assurance.refutation-source", ["durable", this.record.key]);
    }
}

/**
 * One premise refutation. A `withinModel` fault cannot construct this class because it lacks a
 * premise to blame. That stops a real observation of loss, duplication, reordering, or remote
 * acknowledgement ambiguity from being mistaken for evidence that a platform assumption failed.
 */
export class RuntimeRefutation {
    public readonly premise: RuntimePremise;

    public constructor(
        public readonly fault: RuntimeFault,
        public readonly source: RefutationSource
    ) {
        if (!(fault instanceof RuntimeFault)) {
            throw new TypeError("Runtime refutation fault must be a RuntimeFault");
        }
        if (!(source instanceof RefutationSource)) {
            throw new TypeError("Runtime refutation source must be a RefutationSource");
        }
        const premise = fault.consequence.premise;
        if (premise === undefined) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Fault ${fault.id.value} is inside the model and refutes no premise`
            );
        }
        this.premise = premise;
        Object.freeze(this);
    }

    /** An injective identity over fault and source. Repeating it is an idempotent no-op. */
    public get key(): string {
        return canonicalTupleKey("assurance.refutation", [this.fault.id.value, this.source.key]);
    }
}

/**
 * A derived, disposable projection of runtime evidence.
 *
 * The ledger owns no durable domain state. `recordDomainEvidence` receives an already-durable
 * reference and `recordDurableRefutation` does the same. Admitted monitor reports are
 * observation evidence. A caller can rebuild the whole projection from those sources after a
 * process reset, so this is not a second durable copy of a Receipt, AuditRecord, WriteRecord,
 * Event, or platform observation.
 *
 * The resolution order is fixed and fail closed:
 *
 * 1. a refutation makes its premise `refuted`, even if older durable evidence exists;
 * 2. otherwise a durable domain record makes it `discharged`;
 * 3. otherwise it stays `conditional`.
 *
 * Reports can add the first kind and monitoring coverage. They never write the second kind.
 * Thus a missing report leaves a premise conditional, a stale report loses coverage but keeps a
 * past violation, and a clean report can never turn a premise into discharged.
 *
 * Observation retention is bounded rather than perpetual: `compact` drops reports that closed
 * with no violation to report, which is exactly the set that can affect neither a standing nor
 * any live coverage.
 */
export class RuntimeAssuranceLedger {
    readonly #declarationById: ReadonlyMap<string, RuntimeMonitorDeclaration>;
    readonly #claimById: ReadonlyMap<string, AssuredClaim>;
    readonly #evidenceByPremise: ReadonlyMap<string, DomainEvidenceRef>;
    readonly #reportById: ReadonlyMap<string, MonitorReport>;

    private constructor(
        public readonly deployment: DeploymentIdentity,
        public readonly declarations: readonly RuntimeMonitorDeclaration[],
        declarationById: ReadonlyMap<string, RuntimeMonitorDeclaration>,
        public readonly claims: readonly AssuredClaim[],
        claimById: ReadonlyMap<string, AssuredClaim>,
        evidenceByPremise: ReadonlyMap<string, DomainEvidenceRef>,
        public readonly refutations: readonly RuntimeRefutation[],
        public readonly reports: readonly MonitorReport[],
        reportById: ReadonlyMap<string, MonitorReport>
    ) {
        this.#declarationById = declarationById;
        this.#claimById = claimById;
        this.#evidenceByPremise = evidenceByPremise;
        this.#reportById = reportById;
        Object.freeze(this);
    }

    /** Creates an empty, derived ledger for one exact deployment. */
    public static create(
        deployment: DeploymentIdentity,
        declarations: readonly RuntimeMonitorDeclaration[],
        claims: readonly AssuredClaim[]
    ): RuntimeAssuranceLedger {
        requireDeploymentIdentity(deployment);
        const monitorState = requireMonitorDeclarations(declarations);
        const claimState = requireClaims(claims);
        const refutations: readonly RuntimeRefutation[] = Object.freeze([]);
        const reports: readonly MonitorReport[] = Object.freeze([]);
        return new RuntimeAssuranceLedger(
            deployment,
            monitorState.declarations,
            monitorState.byId,
            claimState.claims,
            claimState.byId,
            new Map<string, DomainEvidenceRef>(),
            refutations,
            reports,
            new Map<string, MonitorReport>()
        );
    }

    /** The durable record that discharges this premise, if one exists. */
    public evidenceFor(premise: RuntimePremise): DomainEvidenceRef | undefined {
        requirePremise(premise);
        return this.#evidenceByPremise.get(premise.id.value);
    }

    /**
     * The premise standing. Reports never appear in the discharge branch: a monitor can refute
     * a premise and it can provide time-bounded coverage, but it cannot establish it.
     */
    public standingOf(premise: RuntimePremise): PremiseStanding {
        requirePremise(premise);
        for (const refutation of this.refutations) {
            if (refutation.premise.equals(premise)) return PremiseStanding.refuted;
        }
        return this.#evidenceByPremise.has(premise.id.value)
            ? PremiseStanding.discharged
            : PremiseStanding.conditional;
    }

    /** Every recorded source that refutes this premise. */
    public refutationsFor(premise: RuntimePremise): readonly RuntimeRefutation[] {
        requirePremise(premise);
        const matching: RuntimeRefutation[] = [];
        for (const refutation of this.refutations) {
            if (refutation.premise.equals(premise)) matching.push(refutation);
        }
        return Object.freeze(matching);
    }

    /** Reports that currently watch this premise. An empty result covers missing, stale, and
    outside-model observations without pretending any of them passed. */
    public watchingReports(premise: RuntimePremise, nowMs: number): readonly MonitorReport[] {
        requirePremise(premise);
        requireSafeInteger(nowMs, "Observation instant");
        const watching: MonitorReport[] = [];
        for (const report of this.reports) {
            if (report.watches(premise, nowMs)) watching.push(report);
        }
        return Object.freeze(watching);
    }

    /** Registers durable evidence once. A replay of the exact same record is idempotent; a
    different record for one premise is refused rather than silently replacing evidence. */
    public recordDomainEvidence(
        premise: RuntimePremise,
        evidence: DomainEvidenceRef
    ): RuntimeAssuranceLedger {
        requirePremise(premise);
        requireDomainEvidenceRef(evidence);
        const existing = this.#evidenceByPremise.get(premise.id.value);
        if (existing !== undefined) {
            if (existing.key === evidence.key) return this;
            throw new AgentCoreError(
                "assurance.duplicate-evidence",
                `Premise ${premise.id.value} already names durable evidence ${existing.key}`
            );
        }
        const evidenceByPremise = new Map(this.#evidenceByPremise);
        evidenceByPremise.set(premise.id.value, evidence);
        return this.transition(evidenceByPremise, this.refutations, this.reports, this.#reportById);
    }

    /** Records a refutation whose source is already durable. Faults the model already carries
    are refused: no platform fact gets elevated into a premise merely because it was seen. */
    public recordDurableRefutation(
        fault: RuntimeFault,
        evidence: DomainEvidenceRef
    ): RuntimeAssuranceLedger {
        const refutation = new RuntimeRefutation(fault, RefutationSource.durable(evidence));
        for (const existing of this.refutations) {
            if (existing.key === refutation.key) return this;
        }
        return this.transition(
            this.#evidenceByPremise,
            Object.freeze([...this.refutations, refutation]),
            this.reports,
            this.#reportById
        );
    }

    /**
     * Admits a report only if it binds to this exact deployment, its monitor was declared at
     * deployment time, and it carries exactly that monitor's declared coverage. A report id is
     * at-least-once idempotent only when its full canonical key matches the first one; reuse of
     * an id for different content is a substituted observation and is refused.
     */
    public admitReport(report: MonitorReport): RuntimeAssuranceLedger {
        if (!(report instanceof MonitorReport)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                "Runtime monitor report must be a MonitorReport"
            );
        }
        if (!report.boundTo(this.deployment)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Monitor report ${report.id.value} does not bind to this deployment`
            );
        }
        const declaration = this.declaredMonitor(report.monitor);
        if (!declaration.coversExactly(report.covers)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Monitor report ${report.id.value} substitutes its declared coverage`
            );
        }
        const existing = this.#reportById.get(report.id.value);
        if (existing !== undefined) {
            if (existing.key === report.key) return this;
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Monitor report ${report.id.value} reuses an existing report identity`
            );
        }
        const refutations = [...this.refutations];
        for (const verdict of report.violations) {
            refutations.push(
                new RuntimeRefutation(verdict.fault, RefutationSource.observed(report.id))
            );
        }
        const reportById = new Map(this.#reportById);
        reportById.set(report.id.value, report);
        return this.transition(
            this.#evidenceByPremise,
            Object.freeze(refutations),
            Object.freeze([...this.reports, report]),
            reportById
        );
    }

    /**
     * Drops clean reports whose observation windows have closed.
     *
     * A report with no violations contributes no refutation, and a report whose window closed
     * before this instant watches nothing at this instant or any later one, so retaining it
     * changes neither a premise standing nor any live coverage. Dropping it bounds retention:
     * dead silent evidence does not accumulate forever.
     *
     * Two kinds are never dropped. A report carrying a verdict is a fact about a past instant.
     * A report whose window has not closed still supplies coverage, including one whose window
     * has not opened yet — that report will watch later, so discarding it would throw away
     * coverage rather than dead weight. This is exactly `RuntimeAssurance.Report.dead`.
     */
    public compact(nowMs: number): RuntimeAssuranceLedger {
        requireSafeInteger(nowMs, "Observation instant");
        const retained: MonitorReport[] = [];
        const reportById = new Map<string, MonitorReport>();
        for (const report of this.reports) {
            if (report.violations.length > 0 || nowMs <= report.binding.window.closedAtMs) {
                retained.push(report);
                reportById.set(report.id.value, report);
            }
        }
        return this.transition(
            this.#evidenceByPremise,
            this.refutations,
            Object.freeze(retained),
            reportById
        );
    }

    /** Runs one registered monitor. An absent result is a missing observation and leaves this
    ledger unchanged, which means it cannot discharge a premise or create coverage. */
    public async observe(monitor: RuntimeMonitor, nowMs: number): Promise<RuntimeAssuranceLedger> {
        if (!(monitor instanceof RuntimeMonitor)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                "Runtime observer must be a RuntimeMonitor"
            );
        }
        requireSafeInteger(nowMs, "Observation instant");
        const declaration = this.declaredMonitor(monitor.id);
        if (!declaration.coversExactly(monitor.covers)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Runtime monitor ${monitor.id.value} substitutes its declaration`
            );
        }
        const report = await monitor.observe(nowMs);
        if (report === undefined) return this;
        if (!(report instanceof MonitorReport)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Runtime monitor ${monitor.id.value} returned no MonitorReport`
            );
        }
        if (!report.monitor.equals(monitor.id)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Runtime monitor ${monitor.id.value} returned another monitor's report`
            );
        }
        return this.admitReport(report);
    }

    /** Computes a registered claim's deployed standing. A caller cannot supply a new empty
    claim to obtain a fabricated residual result: the claim id and full support must match the
    reviewed declaration registered in this ledger. */
    public standingOfClaim(claim: AssuredClaim): ClaimStanding {
        const registered = this.registeredClaim(claim);
        let conditional = false;
        for (const premise of registered.support) {
            const standing = this.standingOf(premise);
            if (standing === PremiseStanding.refuted) return ClaimStanding.voided;
            if (standing !== PremiseStanding.discharged) conditional = true;
        }
        return conditional ? ClaimStanding.conditional : ClaimStanding.residual;
    }

    /** The exact premises that void a registered claim. */
    public failedPremises(claim: AssuredClaim): readonly RuntimePremise[] {
        const registered = this.registeredClaim(claim);
        const failed: RuntimePremise[] = [];
        for (const premise of registered.support) {
            if (this.standingOf(premise) === PremiseStanding.refuted) failed.push(premise);
        }
        return Object.freeze(failed);
    }

    /** The exact premises that keep a non-void claim conditional. */
    public unestablishedPremises(claim: AssuredClaim): readonly RuntimePremise[] {
        const registered = this.registeredClaim(claim);
        const open: RuntimePremise[] = [];
        for (const premise of registered.support) {
            if (this.standingOf(premise) === PremiseStanding.conditional) open.push(premise);
        }
        return Object.freeze(open);
    }

    /** Claims whose complete support has durable evidence and no refutation. */
    public residualClaims(): readonly AssuredClaim[] {
        return this.claimsWithStanding(ClaimStanding.residual);
    }

    /** Claims with no failed premise and at least one premise not discharged. */
    public conditionalClaims(): readonly AssuredClaim[] {
        return this.claimsWithStanding(ClaimStanding.conditional);
    }

    /** Claims whose support names one or more refuted premises. */
    public voidedClaims(): readonly AssuredClaim[] {
        return this.claimsWithStanding(ClaimStanding.voided);
    }

    private declaredMonitor(id: RuntimeMonitorId): RuntimeMonitorDeclaration {
        const declaration = this.#declarationById.get(id.value);
        if (declaration === undefined) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Runtime monitor ${id.value} was not declared for this deployment`
            );
        }
        return declaration;
    }

    private registeredClaim(claim: AssuredClaim): AssuredClaim {
        if (!(claim instanceof AssuredClaim)) {
            throw new AgentCoreError("assurance.invalid-claim", "Value is not an AssuredClaim");
        }
        const registered = this.#claimById.get(claim.id.value);
        if (registered === undefined || registered.key !== claim.key) {
            throw new AgentCoreError(
                "assurance.invalid-claim",
                `Assured claim ${claim.id.value} is not registered with this ledger`
            );
        }
        return registered;
    }

    private claimsWithStanding(standing: ClaimStanding): readonly AssuredClaim[] {
        const matching: AssuredClaim[] = [];
        for (const claim of this.claims) {
            if (this.standingOfClaim(claim) === standing) matching.push(claim);
        }
        return Object.freeze(matching);
    }

    private transition(
        evidenceByPremise: ReadonlyMap<string, DomainEvidenceRef>,
        refutations: readonly RuntimeRefutation[],
        reports: readonly MonitorReport[],
        reportById: ReadonlyMap<string, MonitorReport>
    ): RuntimeAssuranceLedger {
        return new RuntimeAssuranceLedger(
            this.deployment,
            this.declarations,
            this.#declarationById,
            this.claims,
            this.#claimById,
            evidenceByPremise,
            refutations,
            reports,
            reportById
        );
    }
}

function requireMonitorDeclarations(declarations: readonly RuntimeMonitorDeclaration[]) {
    const byId = new Map<string, RuntimeMonitorDeclaration>();
    const snapshot: RuntimeMonitorDeclaration[] = [];
    for (const declaration of declarations) {
        if (!(declaration instanceof RuntimeMonitorDeclaration)) {
            throw new TypeError(
                "Runtime assurance declarations must hold RuntimeMonitorDeclaration values"
            );
        }
        if (byId.has(declaration.id.value)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Runtime monitor declaration repeats ${declaration.id.value}`
            );
        }
        byId.set(declaration.id.value, declaration);
        snapshot.push(declaration);
    }
    return { declarations: Object.freeze(snapshot), byId };
}

function requireClaims(claims: readonly AssuredClaim[]) {
    const byId = new Map<string, AssuredClaim>();
    const snapshot: AssuredClaim[] = [];
    for (const claim of claims) {
        if (!(claim instanceof AssuredClaim)) {
            throw new TypeError("Runtime assurance claims must hold AssuredClaim values");
        }
        if (byId.has(claim.id.value)) {
            throw new AgentCoreError(
                "assurance.invalid-claim",
                `Runtime assurance claims repeat ${claim.id.value}`
            );
        }
        byId.set(claim.id.value, claim);
        snapshot.push(claim);
    }
    return { claims: Object.freeze(snapshot), byId };
}

function requirePremise(premise: RuntimePremise): void {
    if (!(premise instanceof RuntimePremise)) {
        throw new TypeError("Runtime assurance premise must be a RuntimePremise");
    }
}

function requireDeploymentIdentity(deployment: DeploymentIdentity): void {
    if (!(deployment instanceof DeploymentIdentity)) {
        throw new TypeError("Runtime assurance deployment must be a DeploymentIdentity");
    }
}

function requireDomainEvidenceRef(evidence: DomainEvidenceRef): void {
    if (!(evidence instanceof DomainEvidenceRef)) {
        throw new TypeError("Runtime domain evidence must be a DomainEvidenceRef");
    }
}

function requireSafeInteger(value: number, subject: string): void {
    if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${subject} must be a safe integer`);
    }
}
