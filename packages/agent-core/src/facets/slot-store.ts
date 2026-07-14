import type { SynchronousResultGuard, TransactionOperation } from "../actors";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import { SlotDeclaration } from "./slot";
import { SlotEntry } from "./slot-entry";
import type { SlotName } from "./id";

export abstract class WorkspaceSlotStore<Transaction> {
    public constructor(public readonly owner: WorkspaceId) {}

    public abstract transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;

    public abstract loadRevision(transaction: Transaction): Revision;
    public abstract saveRevision(transaction: Transaction, revision: Revision): void;
    public abstract loadSlot(transaction: Transaction, name: SlotName): SlotDeclaration | undefined;
    public abstract insertSlot(transaction: Transaction, declaration: SlotDeclaration): void;
    public abstract loadEntry(transaction: Transaction, id: SlotEntry["id"]): SlotEntry | undefined;
    public abstract listEntries(transaction: Transaction, slot: SlotName): readonly SlotEntry[];
    public abstract insertEntry(transaction: Transaction, entry: SlotEntry): void;

    public revision(): Revision {
        return this.transaction((transaction) => this.loadRevision(transaction));
    }

    public slot(name: SlotName): SlotDeclaration | undefined {
        return this.transaction((transaction) => this.loadSlot(transaction, name));
    }

    public entries(name: SlotName): readonly SlotEntry[] {
        return this.transaction((transaction) => this.listEntries(transaction, name));
    }

    public install(declaration: SlotDeclaration): Revision {
        return this.transaction((transaction) => {
            const existing = this.loadSlot(transaction, declaration.name);
            if (
                existing !== undefined &&
                equalBytes(SlotDeclaration.encode(existing), SlotDeclaration.encode(declaration))
            )
                return this.loadRevision(transaction);
            this.insertSlot(transaction, declaration);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    public contribute(entry: SlotEntry): Revision {
        return this.transaction((transaction) => {
            const declaration = this.loadSlot(transaction, entry.slot);
            if (declaration === undefined) throw inactiveSlot(entry.slot.value);
            if (!declaration.entrySchema.accepts(entry.value)) {
                throw invalidEntry(entry.id.value);
            }
            const existing = this.loadEntry(transaction, entry.id);
            if (
                existing !== undefined &&
                equalBytes(SlotEntry.encode(existing), SlotEntry.encode(entry))
            )
                return this.loadRevision(transaction);
            this.insertEntry(transaction, entry);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

export interface SlotQueryAuthorityPort<Viewer> {
    workspace(viewer: Viewer): WorkspaceId | undefined;
    canViewSlot(viewer: Viewer, declaration: SlotDeclaration): Promise<boolean>;
    canViewEntry(viewer: Viewer, declaration: SlotDeclaration, entry: SlotEntry): Promise<boolean>;
}

export abstract class SlotCatalog {
    public abstract query(slot: SlotName): Promise<readonly SlotEntry[]>;
}

export class WorkspaceSlotCatalog<Viewer, Transaction> extends SlotCatalog {
    public constructor(
        private readonly store: WorkspaceSlotStore<Transaction>,
        private readonly viewer: Viewer,
        private readonly authority: SlotQueryAuthorityPort<Viewer>
    ) {
        super();
        const workspace = authority.workspace(viewer);
        if (workspace === undefined || !workspace.equals(store.owner)) {
            throw new AgentCoreError(
                "authority.denied",
                "SlotCatalog requires an authenticated viewer for its Workspace"
            );
        }
    }

    public async query(slot: SlotName): Promise<readonly SlotEntry[]> {
        const workspace = this.authority.workspace(this.viewer);
        if (workspace === undefined || !workspace.equals(this.store.owner)) {
            return Object.freeze([]);
        }
        const snapshot = this.store.transaction((transaction) => {
            const declaration = this.store.loadSlot(transaction, slot);
            const entries =
                declaration === undefined ? [] : this.store.listEntries(transaction, slot);
            return { declaration, entries };
        });
        if (
            snapshot.declaration === undefined ||
            !(await this.authority.canViewSlot(this.viewer, snapshot.declaration))
        ) {
            return Object.freeze([]);
        }
        const visible: SlotEntry[] = [];
        for (const entry of snapshot.entries) {
            if (await this.authority.canViewEntry(this.viewer, snapshot.declaration, entry)) {
                visible.push(entry);
            }
        }
        return Object.freeze(visible);
    }
}

function inactiveSlot(slot: string): AgentCoreError {
    return new AgentCoreError("facet.inactive", `Slot ${slot} is not installed`);
}

function invalidEntry(id: string): AgentCoreError {
    return new AgentCoreError(
        "operation.invalid-input",
        `Slot entry ${id} does not match the entry schema`
    );
}
