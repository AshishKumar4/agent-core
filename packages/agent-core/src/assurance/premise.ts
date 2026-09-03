import { canonicalTupleKey, isJsonString } from "../core";
import { AgentCoreError } from "../errors";
import { RuntimePremiseId } from "./id";

/**
 * Whether a premise underwrites a safety property or only a progress one.
 *
 * The split is not decoration. §14 states that no designated liveness theorem is claimed and
 * that safety rules fail closed without assuming eventual progress. Carrying the distinction
 * on the premise turns that sentence into something the ledger can check: a safety claim
 * whose support names a progress premise is a defect its own support reveals.
 */
export abstract class RuntimePremiseKind {
    public static get safety(): RuntimePremiseKind {
        return safetyKind;
    }
    public static get progress(): RuntimePremiseKind {
        return progressKind;
    }

    public abstract readonly name: string;
    public abstract fold<Result>(cases: RuntimePremiseKindCases<Result>): Result;
}

export interface RuntimePremiseKindCases<Result> {
    readonly safety: () => Result;
    readonly progress: () => Result;
}

class SafetyPremiseKind extends RuntimePremiseKind {
    public readonly name = "safety";
    public fold<Result>(cases: RuntimePremiseKindCases<Result>): Result {
        return cases.safety();
    }
}

class ProgressPremiseKind extends RuntimePremiseKind {
    public readonly name = "progress";
    public fold<Result>(cases: RuntimePremiseKindCases<Result>): Result {
        return cases.progress();
    }
}

const safetyKind = Object.freeze(new SafetyPremiseKind());
const progressKind = Object.freeze(new ProgressPremiseKind());

/**
 * A durable domain record that establishes a premise.
 *
 * `recordKind` is a registered record kind from `artifacts/records/` — a vocabulary this
 * context reads and does not own. The reference is deliberately opaque: which Receipt or
 * AuditRecord establishes which premise is a `C13-*` conformance question, and a module that
 * answered it here would be a second source of truth for record semantics.
 *
 * Being a distinct type from anything a monitor produces is what closes the discharge
 * channel. A monitor observation cannot be passed where this is expected, so "a monitor never
 * substitutes for durable domain evidence" is enforced by the compiler rather than reviewed at
 * each call site.
 */
/** The longest a domain evidence record name may be; see `MAX_TEXT_VALUE_LENGTH` in core. */
const MAX_RECORD_NAME_LENGTH = 256;

export class DomainEvidenceRef {
    public constructor(
        public readonly recordKind: string,
        public readonly recordName: string
    ) {
        if (!isJsonString(recordKind) || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(recordKind)) {
            throw new TypeError("Domain evidence record kind must be a dotted lowercase kind");
        }
        if (
            !isJsonString(recordName) ||
            recordName.length === 0 ||
            recordName.length > MAX_RECORD_NAME_LENGTH
        ) {
            throw new TypeError(
                `Domain evidence record name must contain 1 to ${MAX_RECORD_NAME_LENGTH} characters`
            );
        }
        Object.freeze(this);
    }

    /** An injective key over the pair, for ledger lookups and incident reports. */
    public get key(): string {
        return canonicalTupleKey("assurance.domain-evidence", [this.recordKind, this.recordName]);
    }
}

/**
 * One premise of the runtime plane: a fact about the deployed world the model assumes and
 * does not prove.
 *
 * Absent on purpose: message loss, duplication, reordering, and remote acknowledgement loss.
 * `AC-COMPOSED-001` carries a lossy, duplicating, reordering transport inside the modeled
 * relation, and `AC-EFFECT-001` models the indeterminate attempt and its single supersession.
 * Those are adversary powers the theorems survive, not premises they need, and a premise for
 * any of them would claim the model is weaker than it is.
 */
export abstract class RuntimePremise {
    public static get monotonicTime(): RuntimePremise {
        return monotonicTimePremise;
    }
    public static get boundedClockOffset(): RuntimePremise {
        return boundedClockOffsetPremise;
    }
    public static get restartResumesDurableState(): RuntimePremise {
        return restartResumesDurableStatePremise;
    }
    public static get localTransactionAtomicity(): RuntimePremise {
        return localTransactionAtomicityPremise;
    }
    public static get durableRecordIntegrity(): RuntimePremise {
        return durableRecordIntegrityPremise;
    }
    public static get durableRecordRetention(): RuntimePremise {
        return durableRecordRetentionPremise;
    }
    public static get declaredStorageBoundAccepted(): RuntimePremise {
        return declaredStorageBoundAcceptedPremise;
    }
    public static get sufficientMemoryBudget(): RuntimePremise {
        return sufficientMemoryBudgetPremise;
    }
    public static get sufficientCpuBudget(): RuntimePremise {
        return sufficientCpuBudgetPremise;
    }
    public static get transportAuthenticity(): RuntimePremise {
        return transportAuthenticityPremise;
    }
    public static get providerIdempotency(): RuntimePremise {
        return providerIdempotencyPremise;
    }
    public static get providerQueryTruthful(): RuntimePremise {
        return providerQueryTruthfulPremise;
    }
    public static get engineSemanticsMatchModel(): RuntimePremise {
        return engineSemanticsMatchModelPremise;
    }
    public static get engineSynchronousSpan(): RuntimePremise {
        return engineSynchronousSpanPremise;
    }
    public static get eventualDelivery(): RuntimePremise {
        return eventualDeliveryPremise;
    }
    public static get eventualScheduling(): RuntimePremise {
        return eventualSchedulingPremise;
    }
    /** Every premise, in declaration order. */
    public static get all(): readonly RuntimePremise[] {
        return allPremises;
    }

    /** Fails closed: an unrecognized premise is a missing fact, not a default. */
    public static named(id: RuntimePremiseId): RuntimePremise {
        for (const premise of allPremises) {
            if (premise.id.equals(id)) return premise;
        }
        throw new AgentCoreError(
            "assurance.unknown-premise",
            `Runtime premise ${id.value} is not in the premise vocabulary`
        );
    }

    public abstract readonly id: RuntimePremiseId;
    public abstract readonly kind: RuntimePremiseKind;
    public abstract readonly statement: string;

    public equals(other: RuntimePremise): boolean {
        return this.id.equals(other.id);
    }
}

class MonotonicTime extends RuntimePremise {
    public readonly id = new RuntimePremiseId("monotonic-time");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "Time as the deployment reads it never moves backwards, so lease expiry and immutable resolution deadlines mean what §3.4 says.";
}
class BoundedClockOffset extends RuntimePremise {
    public readonly id = new RuntimePremiseId("bounded-clock-offset");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "Two hosts comparing one deadline read clocks within the offset the deployment declares.";
}
class RestartResumesDurableState extends RuntimePremise {
    public readonly id = new RuntimePremiseId("restart-resumes-durable-state");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "A restarted Actor attaches to the durable state its predecessor committed, so §10.4's rebuild-from-the-outbox recovery reaches the same records.";
}
class LocalTransactionAtomicity extends RuntimePremise {
    public readonly id = new RuntimePremiseId("local-transaction-atomicity");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "One Actor's guarded transaction applies all or nothing, and a commit whose outcome the caller never learns is observed as the base state or the complete after-state, never a mixture.";
}
class DurableRecordIntegrity extends RuntimePremise {
    public readonly id = new RuntimePremiseId("durable-record-integrity");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement = "A durable record reads back as the bytes that were written.";
}
class DurableRecordRetention extends RuntimePremise {
    public readonly id = new RuntimePremiseId("durable-record-retention");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "A committed append-only record is still present when it is next read.";
}
class DeclaredStorageBoundAccepted extends RuntimePremise {
    public readonly id = new RuntimePremiseId("declared-storage-bound-accepted");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "The deployed platform accepts every payload within the bound the profile declares, so §10.4's pre-transaction refusal is the only size refusal a caller meets.";
}
class SufficientMemoryBudget extends RuntimePremise {
    public readonly id = new RuntimePremiseId("sufficient-memory-budget");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "Memory budget suffices to finish a guarded span once it has started.";
}
class SufficientCpuBudget extends RuntimePremise {
    public readonly id = new RuntimePremiseId("sufficient-cpu-budget");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "Processor budget suffices to finish a guarded span once it has started.";
}
class TransportAuthenticity extends RuntimePremise {
    public readonly id = new RuntimePremiseId("transport-authenticity");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "A message the transport delivers was sent by the source it names, so an authenticated projection is what §6.1 assumes it is.";
}
class ProviderIdempotency extends RuntimePremise {
    public readonly id = new RuntimePremiseId("provider-idempotency");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "An external service applies one idempotency key at most once, so a retried EffectAttempt reaches one effect.";
}
class ProviderQueryTruthful extends RuntimePremise {
    public readonly id = new RuntimePremiseId("provider-query-truthful");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "An external service answers truthfully about whether it applied an effect, so §7.4 reconciliation settles an indeterminate attempt on fact.";
}
class EngineSemanticsMatchModel extends RuntimePremise {
    public readonly id = new RuntimePremiseId("engine-semantics-match-model");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "The language runtime renders distinct values distinctly where the modeled encoder assumes it, which is what ASM-CANONICAL-KEY-INJECTIVE rests on.";
}
class EngineSynchronousSpan extends RuntimePremise {
    public readonly id = new RuntimePremiseId("engine-synchronous-span");
    public readonly kind = RuntimePremiseKind.safety;
    public readonly statement =
        "A span the model requires to be one synchronous read and write is not interleaved by the runtime, so §8.5's isolated gate read and guarded mutation stay one span.";
}
class EventualDelivery extends RuntimePremise {
    public readonly id = new RuntimePremiseId("eventual-delivery");
    public readonly kind = RuntimePremiseKind.progress;
    public readonly statement =
        "A message the transport accepted is eventually delivered. Progress only: no designated safety result rests on it.";
}
class EventualScheduling extends RuntimePremise {
    public readonly id = new RuntimePremiseId("eventual-scheduling");
    public readonly kind = RuntimePremiseKind.progress;
    public readonly statement =
        "A due wakeup eventually runs, so the §7.4 reconciliation driver makes progress. Progress only.";
}

const monotonicTimePremise = Object.freeze(new MonotonicTime());
const boundedClockOffsetPremise = Object.freeze(new BoundedClockOffset());
const restartResumesDurableStatePremise = Object.freeze(new RestartResumesDurableState());
const localTransactionAtomicityPremise = Object.freeze(new LocalTransactionAtomicity());
const durableRecordIntegrityPremise = Object.freeze(new DurableRecordIntegrity());
const durableRecordRetentionPremise = Object.freeze(new DurableRecordRetention());
const declaredStorageBoundAcceptedPremise = Object.freeze(new DeclaredStorageBoundAccepted());
const sufficientMemoryBudgetPremise = Object.freeze(new SufficientMemoryBudget());
const sufficientCpuBudgetPremise = Object.freeze(new SufficientCpuBudget());
const transportAuthenticityPremise = Object.freeze(new TransportAuthenticity());
const providerIdempotencyPremise = Object.freeze(new ProviderIdempotency());
const providerQueryTruthfulPremise = Object.freeze(new ProviderQueryTruthful());
const engineSemanticsMatchModelPremise = Object.freeze(new EngineSemanticsMatchModel());
const engineSynchronousSpanPremise = Object.freeze(new EngineSynchronousSpan());
const eventualDeliveryPremise = Object.freeze(new EventualDelivery());
const eventualSchedulingPremise = Object.freeze(new EventualScheduling());

const allPremises: readonly RuntimePremise[] = Object.freeze([
    RuntimePremise.monotonicTime,
    RuntimePremise.boundedClockOffset,
    RuntimePremise.restartResumesDurableState,
    RuntimePremise.localTransactionAtomicity,
    RuntimePremise.durableRecordIntegrity,
    RuntimePremise.durableRecordRetention,
    RuntimePremise.declaredStorageBoundAccepted,
    RuntimePremise.sufficientMemoryBudget,
    RuntimePremise.sufficientCpuBudget,
    RuntimePremise.transportAuthenticity,
    RuntimePremise.providerIdempotency,
    RuntimePremise.providerQueryTruthful,
    RuntimePremise.engineSemanticsMatchModel,
    RuntimePremise.engineSynchronousSpan,
    RuntimePremise.eventualDelivery,
    RuntimePremise.eventualScheduling
]);

/**
 * What is known about one premise.
 *
 * `conditional` is the honest default: assumed and not established. `refuted` outranks
 * `discharged`, because a discharge is evidence over a window that has closed and a refutation
 * says the premise is false.
 */
export abstract class PremiseStanding {
    public static get conditional(): PremiseStanding {
        return conditionalStanding;
    }
    public static get discharged(): PremiseStanding {
        return dischargedStanding;
    }
    public static get refuted(): PremiseStanding {
        return refutedStanding;
    }

    public abstract readonly name: string;
}

class ConditionalStanding extends PremiseStanding {
    public readonly name = "conditional";
}

class DischargedStanding extends PremiseStanding {
    public readonly name = "discharged";
}

class RefutedStanding extends PremiseStanding {
    public readonly name = "refuted";
}

const conditionalStanding = Object.freeze(new ConditionalStanding());
const dischargedStanding = Object.freeze(new DischargedStanding());
const refutedStanding = Object.freeze(new RefutedStanding());
