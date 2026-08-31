import { AgentCoreError } from "../errors";
import { RuntimeFaultId } from "./id";
import { RuntimePremise } from "./premise";

/**
 * What a fault does to the premise plane. Two explicit shapes rather than an unstructured
 * label keep a fault the model already carries distinct from one that refutes a premise.
 *
 * `withinModel` is the load-bearing case: message loss, duplication, reordering, remote
 * acknowledgement loss, volatile state lost at restart, and a caller submitting over-bound
 * payloads are all inside what the model already carries — `AC-COMPOSED-001`'s transport,
 * `AC-EFFECT-001`'s indeterminate attempt, §5.3's lease epoch fencing, §10.4's pre-transaction
 * refusal. They happen, are survived by construction, and refute nothing. Observing one must
 * not move a single claim.
 */
export abstract class FaultConsequence {
    public static get withinModel(): FaultConsequence {
        return withinModelConsequence;
    }
    public static refutes(premise: RuntimePremise): FaultConsequence {
        return new RefutesConsequence(premise);
    }

    public abstract readonly refutes: boolean;
    public abstract readonly premise: RuntimePremise | undefined;
}

class WithinModelConsequence extends FaultConsequence {
    public readonly refutes = false;
    public readonly premise = undefined;
}

class RefutesConsequence extends FaultConsequence {
    public readonly refutes = true;

    public constructor(public readonly premise: RuntimePremise) {
        super();
        if (!(premise instanceof RuntimePremise)) {
            throw new TypeError("Refuted premise must be a RuntimePremise");
        }
        Object.freeze(this);
    }
}

const withinModelConsequence = Object.freeze(new WithinModelConsequence());

/**
 * The closed fault vocabulary of the runtime plane: clocks, process reset, storage integrity
 * and retention, declared bounds, the execution budget, the transport, external-service
 * protocol behavior, and the language runtime's own semantics.
 *
 * Every premise has exactly one fault that refutes it, so no premise in
 * `RuntimePremise.all` is unfalsifiable by construction.
 */
export abstract class RuntimeFault {
    public static get clockWentBackward(): RuntimeFault {
        return clockWentBackwardFault;
    }
    public static get clockOffsetBeyondBound(): RuntimeFault {
        return clockOffsetBeyondBoundFault;
    }
    public static get restartAttachedToDifferentState(): RuntimeFault {
        return restartAttachedToDifferentStateFault;
    }
    public static get restartLostVolatileState(): RuntimeFault {
        return restartLostVolatileStateFault;
    }
    public static get restartObservedPartialCommit(): RuntimeFault {
        return restartObservedPartialCommitFault;
    }
    public static get storedRecordReadBackDifferent(): RuntimeFault {
        return storedRecordReadBackDifferentFault;
    }
    public static get storedRecordAbsentAfterCommit(): RuntimeFault {
        return storedRecordAbsentAfterCommitFault;
    }
    public static get platformRefusedDeclaredPayloadSize(): RuntimeFault {
        return platformRefusedDeclaredPayloadSizeFault;
    }
    public static get callerSubmittedOverBoundPayload(): RuntimeFault {
        return callerSubmittedOverBoundPayloadFault;
    }
    public static get memoryBudgetExhaustedMidSpan(): RuntimeFault {
        return memoryBudgetExhaustedMidSpanFault;
    }
    public static get cpuBudgetExhaustedMidSpan(): RuntimeFault {
        return cpuBudgetExhaustedMidSpanFault;
    }
    public static get messageLost(): RuntimeFault {
        return messageLostFault;
    }
    public static get messageDuplicated(): RuntimeFault {
        return messageDuplicatedFault;
    }
    public static get messageReordered(): RuntimeFault {
        return messageReorderedFault;
    }
    public static get messageForged(): RuntimeFault {
        return messageForgedFault;
    }
    public static get deliveryExceededDeclaredBound(): RuntimeFault {
        return deliveryExceededDeclaredBoundFault;
    }
    public static get wakeupNeverRan(): RuntimeFault {
        return wakeupNeverRanFault;
    }
    public static get providerAppliedOneKeyTwice(): RuntimeFault {
        return providerAppliedOneKeyTwiceFault;
    }
    public static get remoteAcknowledgementLost(): RuntimeFault {
        return remoteAcknowledgementLostFault;
    }
    public static get remoteDeniedAnAppliedEffect(): RuntimeFault {
        return remoteDeniedAnAppliedEffectFault;
    }
    public static get engineRenderedTwoValuesAlike(): RuntimeFault {
        return engineRenderedTwoValuesAlikeFault;
    }
    public static get engineInterleavedGuardedSpan(): RuntimeFault {
        return engineInterleavedGuardedSpanFault;
    }

    /** Every fault, in declaration order. */
    public static get all(): readonly RuntimeFault[] {
        return allFaults;
    }

    /** The faults that refute nothing, because the model already carries them. */
    public static get withinModelFaults(): readonly RuntimeFault[] {
        return withinModelFaults;
    }

    /** Fails closed: a fault name outside the vocabulary is a missing fact, not a default. */
    public static named(id: RuntimeFaultId): RuntimeFault {
        for (const fault of allFaults) {
            if (fault.id.equals(id)) return fault;
        }
        throw new AgentCoreError(
            "assurance.unknown-fault",
            `Runtime fault ${id.value} is not in the fault vocabulary`
        );
    }

    public abstract readonly id: RuntimeFaultId;
    public abstract readonly statement: string;
    public abstract readonly consequence: FaultConsequence;

    public equals(other: RuntimeFault): boolean {
        return this.id.equals(other.id);
    }
}

class ClockWentBackward extends RuntimeFault {
    public readonly id = new RuntimeFaultId("clock-went-backward");
    public readonly statement = "The clock the deployment reads moved backwards.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.monotonicTime);
}
class ClockOffsetBeyondBound extends RuntimeFault {
    public readonly id = new RuntimeFaultId("clock-offset-beyond-bound");
    public readonly statement =
        "Two hosts comparing one deadline read clocks further apart than the deployment declared.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.boundedClockOffset);
}
class RestartAttachedToDifferentState extends RuntimeFault {
    public readonly id = new RuntimeFaultId("restart-attached-to-different-state");
    public readonly statement =
        "A restarted Actor resumed against durable state its predecessor never committed.";
    public readonly consequence = FaultConsequence.refutes(
        RuntimePremise.restartResumesDurableState
    );
}
class RestartLostVolatileState extends RuntimeFault {
    public readonly id = new RuntimeFaultId("restart-lost-volatile-state");
    public readonly statement =
        "A restart discarded state that was never durable, which §5.3's lease epoch already fences.";
    public readonly consequence = FaultConsequence.withinModel;
}
class RestartObservedPartialCommit extends RuntimeFault {
    public readonly id = new RuntimeFaultId("restart-observed-partial-commit");
    public readonly statement =
        "A restarted process observed a transaction neither fully applied nor fully absent.";
    public readonly consequence = FaultConsequence.refutes(
        RuntimePremise.localTransactionAtomicity
    );
}
class StoredRecordReadBackDifferent extends RuntimeFault {
    public readonly id = new RuntimeFaultId("stored-record-read-back-different");
    public readonly statement = "A durable record read back as bytes other than those written.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.durableRecordIntegrity);
}
class StoredRecordAbsentAfterCommit extends RuntimeFault {
    public readonly id = new RuntimeFaultId("stored-record-absent-after-commit");
    public readonly statement =
        "A committed append-only record was gone when next read, so ASM-TRANSITION-ATOMICITY's trusted base eroded.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.durableRecordRetention);
}
class PlatformRefusedDeclaredPayloadSize extends RuntimeFault {
    public readonly id = new RuntimeFaultId("platform-refused-declared-payload-size");
    public readonly statement =
        "The platform refused a payload inside the bound the profile declares, so §10.4's pre-transaction refusal no longer covers every size refusal.";
    public readonly consequence = FaultConsequence.refutes(
        RuntimePremise.declaredStorageBoundAccepted
    );
}
class CallerSubmittedOverBoundPayload extends RuntimeFault {
    public readonly id = new RuntimeFaultId("caller-submitted-over-bound-payload");
    public readonly statement =
        "A caller submitted beyond the declared bound, which the write seam refuses before any transaction opens.";
    public readonly consequence = FaultConsequence.withinModel;
}
class MemoryBudgetExhaustedMidSpan extends RuntimeFault {
    public readonly id = new RuntimeFaultId("memory-budget-exhausted-mid-span");
    public readonly statement = "Memory budget ran out partway through a guarded span.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.sufficientMemoryBudget);
}
class CpuBudgetExhaustedMidSpan extends RuntimeFault {
    public readonly id = new RuntimeFaultId("cpu-budget-exhausted-mid-span");
    public readonly statement = "Processor budget ran out partway through a guarded span.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.sufficientCpuBudget);
}
class MessageLost extends RuntimeFault {
    public readonly id = new RuntimeFaultId("message-lost");
    public readonly statement =
        "The transport lost a message, which AC-COMPOSED-001 models as an adversary power.";
    public readonly consequence = FaultConsequence.withinModel;
}
class MessageDuplicated extends RuntimeFault {
    public readonly id = new RuntimeFaultId("message-duplicated");
    public readonly statement =
        "The transport duplicated a message, which at-least-once delivery with idempotency keys already absorbs.";
    public readonly consequence = FaultConsequence.withinModel;
}
class MessageReordered extends RuntimeFault {
    public readonly id = new RuntimeFaultId("message-reordered");
    public readonly statement =
        "The transport reordered messages, which AC-COMPOSED-001's relation tolerates by construction.";
    public readonly consequence = FaultConsequence.withinModel;
}
class MessageForged extends RuntimeFault {
    public readonly id = new RuntimeFaultId("message-forged");
    public readonly statement =
        "A delivered message was not sent by the source it names, so an authenticated projection was not one.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.transportAuthenticity);
}
class DeliveryExceededDeclaredBound extends RuntimeFault {
    public readonly id = new RuntimeFaultId("delivery-exceeded-declared-bound");
    public readonly statement =
        "Delivery latency passed the bound under which eventual delivery was assumed. Progress only.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.eventualDelivery);
}
class WakeupNeverRan extends RuntimeFault {
    public readonly id = new RuntimeFaultId("wakeup-never-ran");
    public readonly statement =
        "A due wakeup never executed, so the reconciliation driver stopped making progress. Progress only.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.eventualScheduling);
}
class ProviderAppliedOneKeyTwice extends RuntimeFault {
    public readonly id = new RuntimeFaultId("provider-applied-one-key-twice");
    public readonly statement =
        "An external service applied one idempotency key more than once, reaching two effects for one attempt key.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.providerIdempotency);
}
class RemoteAcknowledgementLost extends RuntimeFault {
    public readonly id = new RuntimeFaultId("remote-acknowledgement-lost");
    public readonly statement =
        "A remote acknowledgement was lost after the effect applied, which AC-EFFECT-001's indeterminate attempt and single supersession already cover.";
    public readonly consequence = FaultConsequence.withinModel;
}
class RemoteDeniedAnAppliedEffect extends RuntimeFault {
    public readonly id = new RuntimeFaultId("remote-denied-an-applied-effect");
    public readonly statement =
        "An external service denied having applied an effect it did apply, so §7.4 reconciliation settles on a lie.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.providerQueryTruthful);
}
class EngineRenderedTwoValuesAlike extends RuntimeFault {
    public readonly id = new RuntimeFaultId("engine-rendered-two-values-alike");
    public readonly statement =
        "The language runtime rendered two distinct values to one canonical form, breaking ASM-CANONICAL-KEY-INJECTIVE.";
    public readonly consequence = FaultConsequence.refutes(
        RuntimePremise.engineSemanticsMatchModel
    );
}
class EngineInterleavedGuardedSpan extends RuntimeFault {
    public readonly id = new RuntimeFaultId("engine-interleaved-guarded-span");
    public readonly statement =
        "The runtime interleaved work into a span the model requires to be one synchronous read and write.";
    public readonly consequence = FaultConsequence.refutes(RuntimePremise.engineSynchronousSpan);
}

const clockWentBackwardFault = Object.freeze(new ClockWentBackward());
const clockOffsetBeyondBoundFault = Object.freeze(new ClockOffsetBeyondBound());
const restartAttachedToDifferentStateFault = Object.freeze(new RestartAttachedToDifferentState());
const restartLostVolatileStateFault = Object.freeze(new RestartLostVolatileState());
const restartObservedPartialCommitFault = Object.freeze(new RestartObservedPartialCommit());
const storedRecordReadBackDifferentFault = Object.freeze(new StoredRecordReadBackDifferent());
const storedRecordAbsentAfterCommitFault = Object.freeze(new StoredRecordAbsentAfterCommit());
const platformRefusedDeclaredPayloadSizeFault = Object.freeze(
    new PlatformRefusedDeclaredPayloadSize()
);
const callerSubmittedOverBoundPayloadFault = Object.freeze(new CallerSubmittedOverBoundPayload());
const memoryBudgetExhaustedMidSpanFault = Object.freeze(new MemoryBudgetExhaustedMidSpan());
const cpuBudgetExhaustedMidSpanFault = Object.freeze(new CpuBudgetExhaustedMidSpan());
const messageLostFault = Object.freeze(new MessageLost());
const messageDuplicatedFault = Object.freeze(new MessageDuplicated());
const messageReorderedFault = Object.freeze(new MessageReordered());
const messageForgedFault = Object.freeze(new MessageForged());
const deliveryExceededDeclaredBoundFault = Object.freeze(new DeliveryExceededDeclaredBound());
const wakeupNeverRanFault = Object.freeze(new WakeupNeverRan());
const providerAppliedOneKeyTwiceFault = Object.freeze(new ProviderAppliedOneKeyTwice());
const remoteAcknowledgementLostFault = Object.freeze(new RemoteAcknowledgementLost());
const remoteDeniedAnAppliedEffectFault = Object.freeze(new RemoteDeniedAnAppliedEffect());
const engineRenderedTwoValuesAlikeFault = Object.freeze(new EngineRenderedTwoValuesAlike());
const engineInterleavedGuardedSpanFault = Object.freeze(new EngineInterleavedGuardedSpan());

const allFaults: readonly RuntimeFault[] = Object.freeze([
    RuntimeFault.clockWentBackward,
    RuntimeFault.clockOffsetBeyondBound,
    RuntimeFault.restartAttachedToDifferentState,
    RuntimeFault.restartLostVolatileState,
    RuntimeFault.restartObservedPartialCommit,
    RuntimeFault.storedRecordReadBackDifferent,
    RuntimeFault.storedRecordAbsentAfterCommit,
    RuntimeFault.platformRefusedDeclaredPayloadSize,
    RuntimeFault.callerSubmittedOverBoundPayload,
    RuntimeFault.memoryBudgetExhaustedMidSpan,
    RuntimeFault.cpuBudgetExhaustedMidSpan,
    RuntimeFault.messageLost,
    RuntimeFault.messageDuplicated,
    RuntimeFault.messageReordered,
    RuntimeFault.messageForged,
    RuntimeFault.deliveryExceededDeclaredBound,
    RuntimeFault.wakeupNeverRan,
    RuntimeFault.providerAppliedOneKeyTwice,
    RuntimeFault.remoteAcknowledgementLost,
    RuntimeFault.remoteDeniedAnAppliedEffect,
    RuntimeFault.engineRenderedTwoValuesAlike,
    RuntimeFault.engineInterleavedGuardedSpan
]);

const withinModelFaults: readonly RuntimeFault[] = Object.freeze([
    restartLostVolatileStateFault,
    callerSubmittedOverBoundPayloadFault,
    messageLostFault,
    messageDuplicatedFault,
    messageReorderedFault,
    remoteAcknowledgementLostFault
]);
