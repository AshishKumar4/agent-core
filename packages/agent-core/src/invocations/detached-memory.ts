import { compareCanonicalText } from "../core";
import { AgentCoreError } from "../errors";
import {
    DetachedEffectExecution,
    type DetachedEffectExecutionPersistence
} from "./detached-execution";
import type { EffectAttemptId } from "./id";

export interface DetachedEffectExecutionMemoryState {
    readonly detachedExecutions: Map<string, Uint8Array>;
}

export function createDetachedEffectExecutionMemoryState(): DetachedEffectExecutionMemoryState {
    return { detachedExecutions: new Map() };
}

export function cloneDetachedEffectExecutionMemoryState(
    state: DetachedEffectExecutionMemoryState
): DetachedEffectExecutionMemoryState {
    return {
        detachedExecutions: new Map(
            [...state.detachedExecutions].map(([key, bytes]) => [key, bytes.slice()])
        )
    };
}

/**
 * The in-memory reference store for detached execution records (§8.4's memory implementation
 * of one substrate seam). Records are held as codec bytes, so a suite that clones the state
 * gets the same snapshot-and-restart behavior a substrate gives and cannot share a live object
 * across the boundary.
 */
export class MemoryDetachedEffectExecutionPersistence implements DetachedEffectExecutionPersistence<DetachedEffectExecutionMemoryState> {
    public detachedExecution(
        transaction: DetachedEffectExecutionMemoryState,
        attempt: EffectAttemptId
    ): DetachedEffectExecution | undefined {
        const bytes = transaction.detachedExecutions.get(attempt.value);
        if (bytes === undefined) return undefined;
        const record = DetachedEffectExecution.decode(bytes.slice());
        if (!record.attempt.equals(attempt)) {
            throw new AgentCoreError(
                "codec.invalid",
                "Detached execution index does not match codec bytes"
            );
        }
        return record;
    }

    public releasedDetachedExecutions(
        transaction: DetachedEffectExecutionMemoryState,
        limit: number
    ): readonly DetachedEffectExecution[] {
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Released detached execution query requires a positive limit"
            );
        }
        return Object.freeze(
            [...transaction.detachedExecutions.values()]
                .map((bytes) => DetachedEffectExecution.decode(bytes.slice()))
                .filter((record) => record.state.executable)
                // The EffectAttempt is the page key, because it is the one the substrate index
                // orders on. A driver's batch limit decides which released items this sweep
                // runs, so a second order here would hand the same durable set to two hosts as
                // two different pages.
                .sort((left, right) =>
                    compareCanonicalText(left.attempt.value, right.attempt.value)
                )
                .slice(0, limit)
        );
    }

    public appendDetachedExecution(
        transaction: DetachedEffectExecutionMemoryState,
        record: DetachedEffectExecution
    ): void {
        const current = this.detachedExecution(transaction, record.attempt);
        if (
            (current === undefined && record.revision.value !== 0) ||
            (current !== undefined && !record.follows(current))
        ) {
            throw new AgentCoreError(
                "invocation.invalid",
                "Detached execution revision is not the next transition"
            );
        }
        transaction.detachedExecutions.set(
            record.attempt.value,
            DetachedEffectExecution.encode(record)
        );
    }
}
