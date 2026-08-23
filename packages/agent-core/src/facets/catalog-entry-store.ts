import type { SynchronousResultGuard, TransactionOperation } from "../actors";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import { CatalogEntry, type CatalogOrigin } from "./catalog-entry";
import type { ContributionAttribution } from "./attribution";
import type { CatalogEntryId } from "./id";

/**
 * The catalog entries one Workspace Actor retires for one withdrawing contribution
 * (SPEC §4.1 and §4.2). The set matches the complete immutable attribution pair, so
 * another release of the same Facet is a different contribution and remains live.
 * A direct host declaration carries no attribution and never enters the set.
 */
export class CatalogWithdrawalSet {
    public readonly entries: readonly CatalogEntryId[];

    public constructor(
        public readonly attribution: ContributionAttribution,
        entries: readonly CatalogEntryId[]
    ) {
        this.entries = Object.freeze([...entries]);
        Object.freeze(this);
    }
}

/** The declared coordinates of a direct host declaration. */
export interface CatalogDeclarationInit {
    readonly kind: CatalogEntry["kind"];
    readonly name: string;
    readonly declaration: CatalogEntry["declaration"];
}

export abstract class WorkspaceCatalogStore<Transaction> {
    public constructor(public readonly owner: WorkspaceId) {}

    public abstract transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;

    public abstract loadRevision(transaction: Transaction): Revision;
    public abstract saveRevision(transaction: Transaction, revision: Revision): void;
    public abstract loadEntry(
        transaction: Transaction,
        id: CatalogEntryId
    ): CatalogEntry | undefined;
    /**
     * The entry occupying a contribution's §4.2 position, or none. It is a separate lookup
     * from `loadEntry` because the two answer different questions: an id answers whether a
     * particular record is stored, an origin answers what a new contribution supersedes.
     */
    public abstract loadEntryAt(
        transaction: Transaction,
        origin: CatalogOrigin
    ): CatalogEntry | undefined;
    public abstract insertEntry(transaction: Transaction, entry: CatalogEntry): void;
    public abstract retireEntry(transaction: Transaction, id: CatalogEntryId): void;
    public abstract listEntries(transaction: Transaction): readonly CatalogEntry[];

    public revision(): Revision {
        return this.transaction((transaction) => this.loadRevision(transaction));
    }

    public entry(id: CatalogEntryId): CatalogEntry | undefined {
        return this.transaction((transaction) => this.loadEntry(transaction, id));
    }

    public entries(): readonly CatalogEntry[] {
        return this.transaction((transaction) => this.listEntries(transaction));
    }

    /**
     * The imperative path a host offers operations through (§4.2 materializes every
     * contribution through these same paths). A direct declaration carries no attribution,
     * and a record claiming authenticated provenance is refused here rather than stored:
     * only the trusted package-installation seam may attribute a record.
     */
    public declare(init: CatalogDeclarationInit): Revision {
        return this.place(new CatalogEntry(init.kind, init.name, init.declaration, undefined));
    }

    /** Writes a fully formed attributed entry; see {@link place} for its discipline. */
    public contribute(entry: CatalogEntry): Revision {
        if (entry.attribution === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "A contribution-materialized catalog entry requires its authenticated attribution"
            );
        }
        return this.place(entry);
    }

    /**
     * SPEC §4.2: attribution is written in the same transaction as the record it
     * attributes and is immutable for that record's lifetime. Re-materializing the same
     * contribution from the same release is the same record — the id digests exactly the
     * declared fields — and changes nothing; a changed declaration or a later release
     * supersedes its predecessor inside this one transaction rather than accreting beside
     * it; and an origin another owner holds is refused rather than re-attributed, so
     * supersession never launders one contributor's record under another's name.
     */
    private place(entry: CatalogEntry): Revision {
        return this.transaction((transaction) => {
            const held = this.loadEntryAt(transaction, entry.origin);
            if (held !== undefined) {
                // The id digests exactly the declared fields, so an id-equal held entry is
                // the byte-identical replay of one materialization and nothing else.
                if (held.id.equals(entry.id)) return this.loadRevision(transaction);
                requireSameOwner(held, entry);
                this.retireEntry(transaction, held.id);
            }
            this.insertEntry(transaction, entry);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    /**
     * Computes the withdrawal set from the complete immutable attribution. Decoding every
     * stored entry is the query: unreadable attribution makes the set incomputable, so the
     * caller refuses rather than withdrawing a partial result.
     */
    public withdrawalSet(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): CatalogWithdrawalSet {
        return new CatalogWithdrawalSet(
            attribution,
            this.listEntries(transaction)
                .filter((entry) => entry.attribution?.equals(attribution) === true)
                .map((entry) => entry.id)
        );
    }

    /** Retires one release's catalog entries inside the caller's control transaction. */
    public retireWithdrawalSet(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): boolean {
        const set = this.withdrawalSet(transaction, attribution);
        if (set.entries.length === 0) return false;
        for (const id of set.entries) this.retireEntry(transaction, id);
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

    /**
     * The exclusivity every store shares: one origin has one responsible owner. A storage
     * primitive that admitted a second owner's entry at an occupied origin would make "who
     * contributed this operation" unanswerable from records, so the refusal belongs to the
     * seam rather than to each store.
     */
    protected requireUnclaimedOrigin(transaction: Transaction, entry: CatalogEntry): void {
        const occupant = this.loadEntryAt(transaction, entry.origin);
        if (occupant !== undefined && !occupant.id.equals(entry.id)) {
            throw occupiedOrigin(occupant.origin, holderName(occupant));
        }
    }
}

function requireSameOwner(held: CatalogEntry, candidate: CatalogEntry): void {
    if (!sameOwner(held.attribution, candidate.attribution)) {
        throw occupiedOrigin(held.origin, holderName(held));
    }
}

function sameOwner(
    held: ContributionAttribution | undefined,
    candidate: ContributionAttribution | undefined
): boolean {
    if (held === undefined || candidate === undefined) return held === candidate;
    return held.contributor.equals(candidate.contributor);
}

function holderName(held: CatalogEntry): string {
    return held.attribution?.contributor.value ?? "the host's direct declaration";
}

function occupiedOrigin(origin: CatalogOrigin, holder: string): AgentCoreError {
    return new AgentCoreError(
        "protocol.invalid-state",
        `Catalog ${origin.kind} ${origin.name} is already held by ${holder}`
    );
}

