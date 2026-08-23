import type { SynchronousResultGuard, TransactionOperation } from "../actors";
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import type { WorkspaceId } from "../identity";
import type { ContributionAttribution } from "./attribution";
import type { SurfaceId } from "./id";
import { equalBytes } from "./record-map";
import { SurfaceRegistration } from "./surface";

/**
 * The Surface registrations one Workspace Actor retires for one withdrawing contribution
 * (SPEC §4.1 and §6.3: withdrawing a contribution retires its Surfaces). It is produced by
 * querying the whole attribution — the exact FacetRef and PackagePin pair — and never by
 * running an inverse the Facet supplied, so it names exactly that release's own
 * registrations and a registration it does not name is unchanged by the withdrawal.
 */
export class SurfaceWithdrawalSet {
    public readonly surfaces: readonly SurfaceId[];

    public constructor(
        public readonly attribution: ContributionAttribution,
        surfaces: readonly SurfaceId[]
    ) {
        this.surfaces = Object.freeze([...surfaces]);
        Object.freeze(this);
    }
}

export abstract class WorkspaceSurfaceStore<Transaction> {
    public constructor(public readonly owner: WorkspaceId) {}

    public abstract transaction<Result>(
        operation: TransactionOperation<Transaction, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result;

    public abstract loadRevision(transaction: Transaction): Revision;
    public abstract saveRevision(transaction: Transaction, revision: Revision): void;
    public abstract loadRegistration(
        transaction: Transaction,
        surface: SurfaceId
    ): SurfaceRegistration | undefined;
    public abstract insertRegistration(
        transaction: Transaction,
        registration: SurfaceRegistration
    ): void;
    public abstract retireRegistration(transaction: Transaction, surface: SurfaceId): void;
    public abstract listRegistrations(transaction: Transaction): readonly SurfaceRegistration[];

    public revision(): Revision {
        return this.transaction((transaction) => this.loadRevision(transaction));
    }

    public registration(surface: SurfaceId): SurfaceRegistration | undefined {
        return this.transaction((transaction) => this.loadRegistration(transaction, surface));
    }

    public registrations(): readonly SurfaceRegistration[] {
        return this.transaction((transaction) => this.listRegistrations(transaction));
    }

    /**
     * SPEC §4.2: the registration and its attribution are written in one transaction, so
     * there is no reachable state in which a Surface is registered unattributed. A Surface
     * is registered at most once, and the SurfaceId is that position: re-materializing the
     * same contribution from the same release is the same record and changes nothing, a
     * changed declaration or a later release supersedes its predecessor inside this one
     * transaction rather than accreting beside it, and a Surface another Facet registered is
     * refused rather than re-attributed.
     */
    public register(registration: SurfaceRegistration): Revision {
        return this.transaction((transaction) => {
            const surface = registration.descriptor.id;
            const held = this.loadRegistration(transaction, surface);
            if (held !== undefined) {
                requireOwnRegistration(held, registration);
                if (
                    equalBytes(
                        SurfaceRegistration.encode(held),
                        SurfaceRegistration.encode(registration)
                    )
                ) {
                    return this.loadRevision(transaction);
                }
                this.retireRegistration(transaction, surface);
            }
            this.insertRegistration(transaction, registration);
            const revision = this.loadRevision(transaction).next();
            this.saveRevision(transaction, revision);
            return revision;
        });
    }

    /**
     * The §6.3 exclusivity every store shares: one Surface has one responsible Facet. A
     * storage primitive that admitted a second Facet's registration at a registered
     * SurfaceId would make "which Facet is responsible for this Surface" unanswerable from
     * records, so the refusal belongs to the seam rather than to each store.
     */
    protected requireUnclaimedSurface(
        transaction: Transaction,
        registration: SurfaceRegistration
    ): void {
        const held = this.loadRegistration(transaction, registration.descriptor.id);
        if (held !== undefined) requireOwnRegistration(held, registration);
    }

    /**
     * Computes the withdrawal set by querying attribution. Decoding every stored
     * registration is the query: a registration whose attribution the store cannot read
     * makes the set incomputable, and the caller refuses the withdrawal rather than
     * performing a partial one.
     */
    public withdrawalSet(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): SurfaceWithdrawalSet {
        return new SurfaceWithdrawalSet(
            attribution,
            this.listRegistrations(transaction)
                .filter((registration) => registration.attribution.equals(attribution))
                .map((registration) => registration.descriptor.id)
        );
    }

    /**
     * Retires the named contribution's registrations inside the caller's control
     * transaction and reports whether any record changed.
     */
    public retireWithdrawalSet(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): boolean {
        const set = this.withdrawalSet(transaction, attribution);
        if (set.surfaces.length === 0) return false;
        for (const surface of set.surfaces) this.retireRegistration(transaction, surface);
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

function requireOwnRegistration(
    held: SurfaceRegistration,
    candidate: SurfaceRegistration
): void {
    if (!held.attribution.contributor.equals(candidate.attribution.contributor)) {
        throw claimedSurface(held.descriptor.id.value, held.attribution);
    }
}

function claimedSurface(surface: string, held: ContributionAttribution): AgentCoreError {
    return new AgentCoreError(
        "protocol.invalid-state",
        `Surface ${surface} is registered by ${held.contributor.value}`
    );
}
