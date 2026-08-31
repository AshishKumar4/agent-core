import { Digest, canonicalTupleKey, encodeCanonicalJson } from "../core";
import { AgentCoreError } from "../errors";
import { MonitorReportId, RuntimeMonitorId } from "./id";
import { RuntimeFault } from "./fault";
import { RuntimePremise } from "./premise";

/**
 * The interval a report observed over.
 *
 * Both ends are instants on the model's own clock. A window that closes before it opens is
 * refused at construction, so every binding in circulation describes a possible interval.
 */
export class ObservationWindow {
    public constructor(
        public readonly openedAtMs: number,
        public readonly closedAtMs: number
    ) {
        requireSafeInteger(openedAtMs, "Observation window open");
        requireSafeInteger(closedAtMs, "Observation window close");
        if (closedAtMs < openedAtMs) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                "Observation window closes before it opens"
            );
        }
        Object.freeze(this);
    }

    public covers(instantMs: number): boolean {
        requireSafeInteger(instantMs, "Observed instant");
        return this.openedAtMs <= instantMs && instantMs <= this.closedAtMs;
    }
}

/**
 * What the ledger believes about its own deployment.
 *
 * A monitor is handed these fingerprints when it is built and stamps them on every report; it
 * does not certify them. A monitor that attested the identity of the thing it watches could
 * not detect that the thing changed, so the model never computes one of these — they arrive
 * from outside, and acceptance is exact comparison against what the deployment says it is.
 */
export class DeploymentIdentity {
    public constructor(
        public readonly model: Digest,
        public readonly adapter: Digest,
        public readonly runtime: Digest
    ) {
        requireDigest(model, "Deployment model");
        requireDigest(adapter, "Deployment adapter");
        requireDigest(runtime, "Deployment runtime");
        Object.freeze(this);
    }
}

/** Where a report claims to come from: model, adapter, runtime, and observation window. */
export class MonitorBinding {
    /** SHA-256 commitment to every identity and both window endpoints. */
    public readonly digest: Digest;

    public constructor(
        public readonly deployment: DeploymentIdentity,
        public readonly window: ObservationWindow
    ) {
        if (!(deployment instanceof DeploymentIdentity)) {
            throw new TypeError("Monitor binding deployment must be a DeploymentIdentity");
        }
        if (!(window instanceof ObservationWindow)) {
            throw new TypeError("Monitor binding window must be an ObservationWindow");
        }
        this.digest = Digest.sha256(
            encodeCanonicalJson([
                deployment.model.value,
                deployment.adapter.value,
                deployment.runtime.value,
                window.openedAtMs,
                window.closedAtMs
            ])
        );
        Object.freeze(this);
    }

    /**
     * Exact match against what this deployment says it is. Any drift — another model, another
     * adapter build, another runtime — refuses the report, because an observation cannot be
     * substituted across a boundary where its meaning changed.
     */
    public matches(deployment: DeploymentIdentity): boolean {
        return (
            deployment instanceof DeploymentIdentity &&
            this.deployment.model.equals(deployment.model) &&
            this.deployment.adapter.equals(deployment.adapter) &&
            this.deployment.runtime.equals(deployment.runtime)
        );
    }

    /** The binding digest is its canonical identity in reports and duplicate checks. */
    public get key(): string {
        return this.digest.value;
    }
}

/** One fault a monitor saw, with the premise the monitor blames for it. */
export class MonitorVerdict {
    public constructor(
        public readonly fault: RuntimeFault,
        public readonly blamed: RuntimePremise
    ) {
        if (!(fault instanceof RuntimeFault)) {
            throw new TypeError("Monitor verdict fault must be a RuntimeFault");
        }
        if (!(blamed instanceof RuntimePremise)) {
            throw new TypeError("Monitor verdict blame must be a RuntimePremise");
        }
        Object.freeze(this);
    }

    public get key(): string {
        return canonicalTupleKey("assurance.verdict", [this.fault.id.value, this.blamed.id.value]);
    }
}

/**
 * The immutable declaration for one monitor at deployment time.
 *
 * The ledger registers declarations, not mutable monitor instances. It then requires every
 * report to carry exactly this coverage set. That prevents an adapter built to watch clocks
 * from widening itself later to blame storage, even if it stamps a correct deployment binding.
 */
export class RuntimeMonitorDeclaration {
    public readonly id: RuntimeMonitorId;
    public readonly covers: readonly RuntimePremise[];

    public constructor(id: RuntimeMonitorId, covers: readonly RuntimePremise[]) {
        if (!(id instanceof RuntimeMonitorId)) {
            throw new TypeError("Runtime monitor declaration id must be a RuntimeMonitorId");
        }
        this.id = id;
        this.covers = requirePremises(covers);
        Object.freeze(this);
    }

    public coversExactly(covers: readonly RuntimePremise[]): boolean {
        return (
            covers.length === this.covers.length &&
            covers.every((premise) => this.covers.some((declared) => declared.equals(premise)))
        );
    }
}

/**
 * One monitor report.
 *
 * Three things make its word usable and each is checked separately by the ledger:
 *
 * **Identity** — `binding.matches` against the deployment's own fingerprints.
 * **Attribution** — every verdict names a fault that refutes a premise in `covers`. A monitor
 * cannot blame a premise it was not built to observe, and a verdict about a fault that
 * refutes nothing has no place to go: the ledger refuses it rather than absorbing it.
 * **Honesty** — `unmodeledEvents` carries what the monitor saw and could not describe. Its
 * presence voids the report's coverage claim, so silence over that window stops reassuring
 * anyone; the report's modeled verdicts still stand, so injecting an outside-model event
 * cannot suppress a genuine refutation.
 */
export class MonitorReport {
    public readonly id: MonitorReportId;
    public readonly monitor: RuntimeMonitorId;
    public readonly binding: MonitorBinding;
    public readonly covers: readonly RuntimePremise[];
    public readonly violations: readonly MonitorVerdict[];
    public readonly unmodeledEventTags: readonly number[];

    public constructor(
        id: MonitorReportId,
        monitor: RuntimeMonitorId,
        binding: MonitorBinding,
        covers: readonly RuntimePremise[],
        violations: readonly MonitorVerdict[],
        unmodeledEventTags: readonly number[]
    ) {
        if (!(id instanceof MonitorReportId)) {
            throw new TypeError("Monitor report id must be a MonitorReportId");
        }
        if (!(monitor instanceof RuntimeMonitorId)) {
            throw new TypeError("Monitor report monitor must be a RuntimeMonitorId");
        }
        if (!(binding instanceof MonitorBinding)) {
            throw new TypeError("Monitor report binding must be a MonitorBinding");
        }
        this.id = id;
        this.monitor = monitor;
        this.binding = binding;
        this.covers = requirePremises(covers);
        this.violations = requireVerdicts(violations);
        this.unmodeledEventTags = requireUnmodeledEventTags(unmodeledEventTags);
        Object.freeze(this);
    }

    /** Every verdict names a fault that refutes a premise this report declares coverage of. */
    public attributesWithinCoverage(): boolean {
        return this.violations.every((verdict) => {
            const refuted = verdict.fault.consequence.premise;
            return (
                refuted !== undefined &&
                refuted.equals(verdict.blamed) &&
                this.covers.some((premise) => premise.equals(verdict.blamed))
            );
        });
    }

    /** The report saw nothing outside its model. Coverage expires with the window. */
    public claimsCoverage(): boolean {
        return this.unmodeledEventTags.length === 0;
    }

    /**
     * Whether this report is usable against a deployment right now, as a bound observation.
     * Freshness is deliberately absent: a violation is a fact about a past instant and
     * premises are not re-established by time passing, so staleness gates coverage elsewhere
     * and never gates a refutation.
     */
    public boundTo(deployment: DeploymentIdentity): boolean {
        return this.binding.matches(deployment) && this.attributesWithinCoverage();
    }

    /** Whether this report watches one premise at one instant: declared coverage, nothing
     * unmodeled seen, and a window still covering now. */
    public watches(premise: RuntimePremise, nowMs: number): boolean {
        return (
            premise instanceof RuntimePremise &&
            this.covers.some((covered) => covered.equals(premise)) &&
            this.claimsCoverage() &&
            this.binding.window.covers(nowMs)
        );
    }

    /** An injective key over the whole report content, for duplicate detection. */
    public get key(): string {
        return canonicalTupleKey("assurance.report", [
            this.id.value,
            this.monitor.value,
            this.binding.key,
            [...this.covers].map((premise) => premise.id.value).sort(),
            [...this.violations].map((verdict) => verdict.key).sort(),
            [...this.unmodeledEventTags].sort((left, right) => left - right)
        ]);
    }
}

/**
 * The seam a real observer implements.
 *
 * This is the new real boundary: an adapter watching a platform — clock skew, storage
 * health, budget pressure, transport behavior — produces a report here and hands it to the
 * ledger. The interface promises only that a report carries the identities it was built
 * against; everything about whether its word counts happens in `RuntimeAssuranceLedger`.
 */
export abstract class RuntimeMonitor {
    public readonly id: RuntimeMonitorId;
    public readonly covers: readonly RuntimePremise[];

    public constructor(public readonly declaration: RuntimeMonitorDeclaration) {
        if (!(declaration instanceof RuntimeMonitorDeclaration)) {
            throw new TypeError("Runtime monitor declaration must be a RuntimeMonitorDeclaration");
        }
        this.id = declaration.id;
        this.covers = declaration.covers;
    }

    /**
     * Observe once. `undefined` is an honest missing observation; it can never discharge a
     * premise and the ledger's watching query returns nothing for it.
     */
    public abstract observe(nowMs: number): Promise<MonitorReport | undefined>;
}

function requireSafeInteger(value: number, subject: string): void {
    if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${subject} must be a safe integer`);
    }
}

function requireDigest(value: Digest, subject: string): void {
    if (!(value instanceof Digest)) {
        throw new TypeError(`${subject} must be a Digest`);
    }
}

function requirePremises(covers: readonly RuntimePremise[]): readonly RuntimePremise[] {
    const seen = new Set<string>();
    const snapshot: RuntimePremise[] = [];
    for (const premise of covers) {
        if (!(premise instanceof RuntimePremise)) {
            throw new TypeError("Monitor coverage must hold RuntimePremise values");
        }
        if (seen.has(premise.id.value)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Monitor coverage declares ${premise.id.value} twice`
            );
        }
        seen.add(premise.id.value);
        snapshot.push(premise);
    }
    return Object.freeze(snapshot);
}

function requireVerdicts(violations: readonly MonitorVerdict[]): readonly MonitorVerdict[] {
    const seen = new Set<string>();
    const snapshot: MonitorVerdict[] = [];
    for (const verdict of violations) {
        if (!(verdict instanceof MonitorVerdict)) {
            throw new TypeError("Monitor violations must hold MonitorVerdict values");
        }
        if (seen.has(verdict.key)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Monitor report repeats verdict ${verdict.key}`
            );
        }
        seen.add(verdict.key);
        snapshot.push(verdict);
    }
    return Object.freeze(snapshot);
}

function requireUnmodeledEventTags(tags: readonly number[]): readonly number[] {
    const seen = new Set<number>();
    const snapshot: number[] = [];
    for (const tag of tags) {
        requireSafeInteger(tag, "Unmodeled event tag");
        if (tag < 0) {
            throw new TypeError("Unmodeled event tag must be non-negative");
        }
        if (seen.has(tag)) {
            throw new AgentCoreError(
                "assurance.observation-refused",
                `Monitor report repeats unmodeled event ${tag}`
            );
        }
        seen.add(tag);
        snapshot.push(tag);
    }
    return Object.freeze(snapshot);
}
