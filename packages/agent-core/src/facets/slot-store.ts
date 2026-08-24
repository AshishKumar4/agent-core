import type { SynchronousResultGuard, TransactionOperation } from "../actors";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import { ContributionAttribution } from "./attribution";
import { equalBytes } from "./record-map";
import { InstalledSlot } from "./slot";
import { SlotEntry, type SlotContributionOrigin } from "./slot-entry";
import type { SlotEntryId, SlotName } from "./id";

/**
 * The records one Workspace Slot Actor retires for one withdrawing contribution (SPEC
 * §4.1, C13-FACET-WITHDRAWAL-EXACT). It is produced by querying the whole attribution —
 * the exact FacetRef and PackagePin pair — and never by running an inverse the Facet
 * supplied, so it names exactly that release's own records and a record it does not name
 * is unchanged by the withdrawal. Another release of the same Facet is a different
 * contribution with a different set.
 */
export class SlotWithdrawalSet {
    public readonly slots: readonly SlotName[];
    public readonly entries: readonly SlotEntryId[];

    public constructor(
        public readonly attribution: ContributionAttribution,
        slots: readonly SlotName[],
        entries: readonly SlotEntryId[]
    ) {
        if (!(attribution instanceof ContributionAttribution)) {
            throw new TypeError("Slot withdrawal set requires contribution attribution");
        }
        this.slots = Object.freeze([...slots]);
        this.entries = Object.freeze([...entries]);
        Object.freeze(this);
    }
}

export abstract class WorkspaceSlotStore<Transaction> {
    public constructor(public readonly owner: WorkspaceId) {}

    public abstract transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;

    public abstract loadRevision(transaction: Transaction): Revision;
    public abstract saveRevision(transaction: Transaction, revision: Revision): void;
    public abstract loadSlot(transaction: Transaction, name: SlotName): InstalledSlot | undefined;
    public abstract insertSlot(transaction: Transaction, slot: InstalledSlot): void;
    public abstract retireSlot(transaction: Transaction, name: SlotName): void;
    public abstract listSlots(transaction: Transaction): readonly InstalledSlot[];
    public abstract loadEntry(transaction: Transaction, id: SlotEntryId): SlotEntry | undefined;
    /**
     * The entry occupying a contribution's §4.2 position, or none. It is a separate lookup
     * from `loadEntry` because the two answer different questions: an id answers whether a
     * particular record is stored, an origin answers what a new contribution supersedes.
     */
    public abstract loadEntryAt(
        transaction: Transaction,
        origin: SlotContributionOrigin
    ): SlotEntry | undefined;
    public abstract listEntries(transaction: Transaction, slot: SlotName): readonly SlotEntry[];
    public abstract listAllEntries(transaction: Transaction): readonly SlotEntry[];
    public abstract insertEntry(transaction: Transaction, entry: SlotEntry): void;
    public abstract retireEntry(transaction: Transaction, id: SlotEntryId): void;

    public revision(): Revision {
        return this.transaction((transaction) => this.loadRevision(transaction));
    }

    public slot(name: SlotName): InstalledSlot | undefined {
        return this.transaction((transaction) => this.loadSlot(transaction, name));
    }

    public entries(name: SlotName): readonly SlotEntry[] {
        return this.transaction((transaction) => this.listEntries(transaction, name));
    }

    public install(slot: InstalledSlot): Revision {
        return this.transaction((transaction) => {
            const existing = this.loadSlot(transaction, slot.declaration.name);
            if (
                existing !== undefined &&
                equalBytes(InstalledSlot.encode(existing), InstalledSlot.encode(slot))
            )
                return this.loadRevision(transaction);
            this.insertSlot(transaction, slot);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    /**
     * SPEC §4.2: a slot holds at most one entry per contributor per ordinal. Because the
     * entry id digests exactly the declared fields, re-materializing the same contribution
     * from the same release is the same record and changes nothing, while a contribution
     * whose value or source release changed supersedes its predecessor inside this one
     * transaction rather than accreting beside it.
     */
    public contribute(entry: SlotEntry): Revision {
        return this.transaction((transaction) => {
            const installed = this.loadSlot(transaction, entry.slot);
            if (installed === undefined) throw inactiveSlot(entry.slot.value);
            if (!installed.declaration.entrySchema.accepts(entry.value)) {
                throw invalidEntry(entry.id.value);
            }
            const superseded = this.loadEntryAt(transaction, entry.origin);
            if (superseded !== undefined) {
                if (superseded.id.equals(entry.id)) return this.loadRevision(transaction);
                this.retireEntry(transaction, superseded.id);
            }
            this.insertEntry(transaction, entry);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    /**
     * The origin exclusivity §4.2 requires, enforced where both implementations share it. A
     * storage primitive that admitted a second entry at one origin would make supersession
     * unobservable, so the refusal belongs to the seam rather than to each store.
     */
    protected requireFreeOrigin(transaction: Transaction, entry: SlotEntry): void {
        const occupant = this.loadEntryAt(transaction, entry.origin);
        if (occupant !== undefined && !occupant.id.equals(entry.id)) {
            throw occupiedOrigin(entry.origin, occupant);
        }
    }

    /**
     * Computes the withdrawal set by querying attribution. Decoding every stored record is
     * the query: a record whose attribution the store cannot read makes the set
     * incomputable, and the caller refuses the withdrawal rather than performing a partial
     * one.
     */
    public withdrawalSet(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): SlotWithdrawalSet {
        const slots = this.listSlots(transaction)
            .filter((installed) => installed.attribution.equals(attribution))
            .map((installed) => installed.declaration.name);
        const entries = this.listAllEntries(transaction)
            .filter((entry) => entry.attribution.equals(attribution))
            .map((entry) => entry.id);
        return new SlotWithdrawalSet(attribution, slots, entries);
    }

    /**
     * Refuses a set that holds a Slot declaration still carrying an entry attributed to a
     * Facet the same reconciliation retains. That is a refusal and never a deferral: the
     * retained contribution would name a Slot the resulting composition does not declare,
     * and that obligation has no discharging condition.
     */
    public requireWithdrawable(transaction: Transaction, set: SlotWithdrawalSet): void {
        const withdrawn = new Set(set.entries.map((id) => id.value));
        for (const name of set.slots) {
            const blocking = this.listEntries(transaction, name).find(
                (entry) => !withdrawn.has(entry.id.value)
            );
            if (blocking !== undefined) {
                throw retainedContribution(name.value, blocking.attribution);
            }
        }
    }

    /**
     * Retires the named contribution's records inside the caller's control transaction and
     * reports whether any record changed.
     */
    public retireWithdrawalSet(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): boolean {
        const set = this.withdrawalSet(transaction, attribution);
        this.requireWithdrawable(transaction, set);
        if (set.slots.length === 0 && set.entries.length === 0) return false;
        for (const id of set.entries) this.retireEntry(transaction, id);
        for (const name of set.slots) this.retireSlot(transaction, name);
        return true;
    }

    public withdraw(attribution: ContributionAttribution): Revision {
        return this.transaction((transaction) => {
            if (!this.retireWithdrawalSet(transaction, attribution)) {
                return this.loadRevision(transaction);
            }
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }
}

export interface SlotQueryAuthorityPort<Viewer> {
    workspace(viewer: Viewer): WorkspaceId | undefined;
    canViewSlot(viewer: Viewer, slot: InstalledSlot): Promise<boolean>;
    canViewEntry(viewer: Viewer, slot: InstalledSlot, entry: SlotEntry): Promise<boolean>;
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
            const installed = this.store.loadSlot(transaction, slot);
            const entries =
                installed === undefined ? [] : this.store.listEntries(transaction, slot);
            return { installed, entries };
        });
        if (
            snapshot.installed === undefined ||
            !(await this.authority.canViewSlot(this.viewer, snapshot.installed))
        ) {
            return Object.freeze([]);
        }
        const visible: SlotEntry[] = [];
        for (const entry of snapshot.entries) {
            if (await this.authority.canViewEntry(this.viewer, snapshot.installed, entry)) {
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

function retainedContribution(slot: string, retained: ContributionAttribution): AgentCoreError {
    return new AgentCoreError(
        "protocol.invalid-state",
        `Withdrawal would retire Slot ${slot} while ${retained.contributor.value} still contributes to it`
    );
}

function occupiedOrigin(origin: SlotContributionOrigin, occupant: SlotEntry): AgentCoreError {
    return new AgentCoreError(
        "protocol.invalid-state",
        `Slot entry ${occupant.id.value} already occupies ${origin.contributor.value} at ordinal ${origin.ordinal} of slot ${origin.slot.value}`
    );
}
