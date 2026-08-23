import type { SynchronousResultGuard, TransactionOperation } from "../actors";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import { ContributionAttribution } from "./attribution";
import { equalBytes } from "./record-map";
import { Prompt } from "./prompt";
import {
    PromptSection,
    PromptSectionContributionOrigin
} from "./prompt-section";
import type { FacetRef, PromptSectionId } from "./id";

/**
 * The records one Workspace Actor retires for a withdrawing Facet (SPEC §4.1,
 * C13-FACET-WITHDRAWAL-EXACT: the withdrawal set names exactly the Facet's own prompt
 * sections). It is produced by querying attribution and never by running an inverse the
 * Facet supplied, so it names exactly the withdrawing Facet's own sections and a section it
 * does not name is unchanged by the withdrawal.
 */
export class PromptWithdrawalSet {
    public readonly sections: readonly PromptSectionId[];

    public constructor(
        public readonly contributor: FacetRef,
        sections: readonly PromptSectionId[]
    ) {
        this.sections = Object.freeze([...sections]);
        Object.freeze(this);
    }
}

/**
 * SPEC §4.2 materializes a `prompt` contribution into attributed prompt-assembly sections.
 * There is no unattributed path on purpose: a materialized record carrying no attribution is
 * invalid rather than unattributed, so every write takes a `ContributionAttribution`, and
 * the trusted package-installation provenance seam (the Workspace prompt materializer) is
 * where that attribution comes from in production.
 */
export abstract class WorkspacePromptSectionStore<Transaction> {
    public constructor(public readonly owner: WorkspaceId) {}

    public abstract transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;

    public abstract loadRevision(transaction: Transaction): Revision;
    public abstract saveRevision(transaction: Transaction, revision: Revision): void;
    public abstract loadSection(
        transaction: Transaction,
        id: PromptSectionId
    ): PromptSection | undefined;
    /**
     * The section occupying a contribution's §4.2 position, or none. It is a separate lookup
     * from `loadSection` because the two answer different questions: an id answers whether a
     * particular record is stored, an origin answers what a new contribution supersedes.
     */
    public abstract loadSectionAt(
        transaction: Transaction,
        origin: PromptSectionContributionOrigin
    ): PromptSection | undefined;
    /** Every stored section in storage order — contributor, then declared position. */
    public abstract listSections(transaction: Transaction): readonly PromptSection[];
    public abstract insertSection(transaction: Transaction, section: PromptSection): void;
    public abstract retireSection(transaction: Transaction, id: PromptSectionId): void;

    public revision(): Revision {
        return this.transaction((transaction) => this.loadRevision(transaction));
    }

    /**
     * The stored sections in assembly order: the deterministic read a host composes a model
     * prompt from. Declared priority leads, ties break through the declared text and then
     * the origin, so two stores of the same records list them identically.
     */
    public assembledSections(): readonly PromptSection[] {
        return this.transaction((transaction) =>
            [...this.listSections(transaction)].sort(PromptSection.compare)
        );
    }

    public sectionsOf(contributor: FacetRef): readonly PromptSection[] {
        return this.transaction((transaction) =>
            this.listSections(transaction).filter((section) =>
                section.attribution.contributor.equals(contributor)
            )
        );
    }

    /**
     * SPEC §4.2: a contribution holds at most one section per contributor per position, and
     * re-materializing the same contribution from the same release is the same records and
     * changes nothing. Because a section's id digests its declared fields plus attribution,
     * a changed contribution or a later release supersedes its predecessor inside this one
     * transaction rather than accreting beside it — including when the new set is shorter,
     * where supersession is what retires the tail the predecessor left behind.
     */
    public contribute(attribution: ContributionAttribution, declaration: readonly Prompt[]): Revision {
        return this.transaction((transaction) => {
            const next = declaration.map(
                (prompt, position) =>
                    new PromptSection(prompt.title, prompt.body, prompt.priority, attribution, position)
            );
            const current = this.listSections(transaction).filter((section) =>
                section.attribution.contributor.equals(attribution.contributor)
            );
            if (
                current.length === next.length &&
                current.every((section, index) =>
                    equalBytes(PromptSection.encode(section), PromptSection.encode(next[index]!))
                )
            ) {
                return this.loadRevision(transaction);
            }
            for (const section of current) this.retireSection(transaction, section.id);
            for (const section of next) this.insertSection(transaction, section);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    /**
     * Computes the withdrawal set by querying attribution. Decoding every stored section is
     * the query: a section whose attribution the store cannot read makes the set
     * incomputable, and the caller refuses the withdrawal rather than performing a partial
     * one.
     */
    public withdrawalSet(
        transaction: Transaction,
        contributor: FacetRef
    ): PromptWithdrawalSet {
        return new PromptWithdrawalSet(
            contributor,
            this.listSections(transaction)
                .filter((section) => section.attribution.contributor.equals(contributor))
                .map((section) => section.id)
        );
    }

    /**
     * Retires the withdrawing Facet's sections inside the caller's control transaction and
     * reports whether any record changed.
     */
    public retireWithdrawalSet(transaction: Transaction, contributor: FacetRef): boolean {
        const set = this.withdrawalSet(transaction, contributor);
        if (set.sections.length === 0) return false;
        for (const id of set.sections) this.retireSection(transaction, id);
        return true;
    }

    public withdraw(contributor: FacetRef): Revision {
        return this.transaction((transaction) => {
            if (!this.retireWithdrawalSet(transaction, contributor)) {
                return this.loadRevision(transaction);
            }
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    /**
     * The origin exclusivity §4.2 requires, enforced where both implementations share it. A
     * storage primitive that admitted a second section at one origin would make supersession
     * unobservable, so the refusal belongs to the seam rather than to each store.
     */
    protected requireFreeOrigin(transaction: Transaction, section: PromptSection): void {
        const occupant = this.loadSectionAt(transaction, section.origin);
        if (occupant !== undefined && !occupant.id.equals(section.id)) {
            throw occupiedOrigin(section.origin, occupant);
        }
    }
}

function occupiedOrigin(
    origin: PromptSectionContributionOrigin,
    occupant: PromptSection
): AgentCoreError {
    return new AgentCoreError(
        "protocol.invalid-state",
        `Prompt section ${occupant.id.value} already occupies ${origin.contributor.value} at position ${origin.position}`
    );
}
