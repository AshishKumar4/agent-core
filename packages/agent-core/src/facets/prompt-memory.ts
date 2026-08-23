import { type TransactionOperation, type SynchronousResultGuard } from "../actors";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import type { PromptSectionId } from "./id";
import {
    cloneRecordMap,
    insertImmutable,
    orderedRecords,
    requireSynchronousRecordResult,
    sameRecordMaps,
    type RecordMap
} from "./record-map";
import {
    PromptSection,
    PromptSectionContributionOrigin
} from "./prompt-section";
import { WorkspacePromptSectionStore } from "./prompt-store";

interface MemoryPromptState {
    revision: number;
    sections: RecordMap;
}

export class MemoryWorkspacePromptSectionStore extends WorkspacePromptSectionStore<MemoryPromptState> {
    #state: MemoryPromptState;
    #active: MemoryPromptState | undefined;

    public constructor(owner: WorkspaceId) {
        super(owner);
        this.#state = { revision: 0, sections: new Map() };
    }

    public transaction<Result>(
        operation: TransactionOperation<MemoryPromptState, Result>,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active !== undefined) {
            throw invalidState("Nested prompt section transactions are not supported");
        }
        const draft = cloneState(this.#state);
        this.#active = draft;
        try {
            const result = requireSynchronousRecordResult(operation(draft), "Prompt section");
            validateState(draft);
            validateCommit(this.#state, draft);
            this.#state = cloneState(draft);
            return result;
        } finally {
            this.#active = undefined;
        }
    }

    public loadRevision(transaction: MemoryPromptState): Revision {
        this.requireActive(transaction);
        return new Revision(transaction.revision);
    }

    public saveRevision(transaction: MemoryPromptState, revision: Revision): void {
        this.requireActive(transaction);
        if (revision.value !== transaction.revision + 1) {
            throw new AgentCoreError(
                "protocol.revision-conflict",
                "Workspace prompt section revision must advance exactly once"
            );
        }
        transaction.revision = revision.value;
    }

    public loadSection(
        transaction: MemoryPromptState,
        id: PromptSectionId
    ): PromptSection | undefined {
        this.requireActive(transaction);
        const bytes = transaction.sections.get(id.value);
        return bytes === undefined ? undefined : decodeSection(bytes, id.value);
    }

    /**
     * A position lookup, not an assertion about the store's key discipline: `validateState`
     * owns that at every commit, so decoding here does not restate it.
     */
    public loadSectionAt(
        transaction: MemoryPromptState,
        origin: PromptSectionContributionOrigin
    ): PromptSection | undefined {
        this.requireActive(transaction);
        return [...transaction.sections.values()]
            .map((bytes) => PromptSection.decode(bytes))
            .find((section) => section.origin.equals(origin));
    }

    public listSections(transaction: MemoryPromptState): readonly PromptSection[] {
        this.requireActive(transaction);
        return Object.freeze(
            orderedRecords(transaction.sections).map(([key, bytes]) => decodeSection(bytes, key))
        );
    }

    public insertSection(transaction: MemoryPromptState, section: PromptSection): void {
        this.requireActive(transaction);
        this.requireFreeOrigin(transaction, section);
        insertImmutable(
            transaction.sections,
            section.id.value,
            PromptSection.encode(section),
            "Prompt section"
        );
    }

    public retireSection(transaction: MemoryPromptState, id: PromptSectionId): void {
        this.requireActive(transaction);
        if (!transaction.sections.delete(id.value)) {
            throw invalidState(`Prompt section ${id.value} is not contributed`);
        }
    }

    private requireActive(transaction: MemoryPromptState): void {
        if (transaction !== this.#active) {
            throw invalidState("Workspace prompt section access requires its active transaction");
        }
    }
}

function cloneState(state: MemoryPromptState): MemoryPromptState {
    return { revision: state.revision, sections: cloneRecordMap(state.sections) };
}

function decodeSection(bytes: Uint8Array, key: string): PromptSection {
    const value = PromptSection.decode(bytes);
    if (value.id.value !== key) {
        throw corrupt("Stored prompt section key does not match codec bytes");
    }
    return value;
}

function validateState(state: MemoryPromptState): void {
    for (const [key, bytes] of state.sections) decodeSection(bytes, key);
}

/**
 * The revision counts committed write transactions exactly: a transaction that changed the
 * record set advances it once, and one that changed nothing leaves it alone. Comparing the
 * draft against the state it forked from catches a fabricated contribution, a fabricated
 * retirement, and a revision bump over an unchanged store.
 */
function validateCommit(before: MemoryPromptState, after: MemoryPromptState): void {
    const changed = !sameRecordMaps(before.sections, after.sections);
    if (after.revision - before.revision !== (changed ? 1 : 0)) {
        throw corrupt("Memory Workspace prompt section revision does not match its records");
    }
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}
