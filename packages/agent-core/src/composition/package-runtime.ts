import type { Revision } from "../core";
import {
    BlueprintLoader,
    PackageInstallationProvenancePort,
    type Blueprint,
    type LoadedBlueprint,
    type LoadedPackageModule
} from "../definition";
import { AgentCoreError } from "../errors";
import {
    InstalledSlot,
    SlotEntry,
    type Facet,
    type FacetRef,
    type SlotName,
    type SlotWithdrawalSet,
    type WorkspaceSlotStore
} from "../facets";
import { FacetRuntimeHost } from "../operations/internal";
import type { CommandEnvelope, FacetSlotCommandBackend } from "../protocol";

export interface PackageFacetRoots<Loaded> {
    roots(modules: readonly LoadedPackageModule<Loaded>[]): readonly Facet[];
}

export class PackageFacetRuntime<Loaded> implements AsyncDisposable {
    #loaded: LoadedBlueprint<Loaded> | undefined;
    #host: FacetRuntimeHost | undefined;

    public constructor(
        private readonly loader: BlueprintLoader<Loaded>,
        private readonly facets: PackageFacetRoots<Loaded>
    ) {}

    public get host(): FacetRuntimeHost | undefined {
        return this.#host;
    }

    public async activate(blueprint: Blueprint): Promise<FacetRuntimeHost> {
        if (this.#loaded !== undefined) {
            throw new AgentCoreError("facet.inactive", "Package Facet runtime is already active");
        }
        const loaded = await this.loader.load(blueprint);
        const manifests = loaded.validated.releases.flatMap((release) => release.manifests);
        const host = new FacetRuntimeHost(manifests, this.facets.roots(loaded.modules));
        try {
            await host.activate();
        } catch (error) {
            await loaded.dispose();
            throw error;
        }
        this.#loaded = loaded;
        this.#host = host;
        return host;
    }

    public async dispose(): Promise<void> {
        const host = this.#host;
        const loaded = this.#loaded;
        this.#host = undefined;
        this.#loaded = undefined;
        let failure: unknown;
        try {
            await host?.dispose();
        } catch (error) {
            failure = error;
        }
        try {
            await loaded?.dispose();
        } catch (error) {
            failure ??= error;
        }
        if (failure !== undefined) throw failure;
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }
}

export interface FacetSlotAuthorityPort<Read, Transaction = Read> {
    permitsInstall(state: Read | Transaction, slot: InstalledSlot): boolean;
    permitsContribution(state: Read | Transaction, entry: SlotEntry): boolean;
    permitsWithdrawal(state: Read | Transaction, contributor: FacetRef): boolean;
}

export interface FacetSlotReadPort<Read> {
    revision(read: Read): Revision;
    slot(read: Read, name: SlotName): InstalledSlot | undefined;
}

export class ProvenanceFacetSlotBackend<Transaction, Read> implements FacetSlotCommandBackend<
    Transaction,
    Read
> {
    public constructor(
        private readonly slots: WorkspaceSlotStore<Transaction>,
        private readonly provenance: PackageInstallationProvenancePort<
            Read | Transaction,
            CommandEnvelope
        >,
        private readonly authority: FacetSlotAuthorityPort<Read, Transaction>,
        private readonly reads: FacetSlotReadPort<Read>
    ) {}

    public currentRevision(read: Read): Revision {
        return this.reads.revision(read);
    }

    public permitsInstall(read: Read, slot: InstalledSlot): boolean {
        return this.authority.permitsInstall(read, slot);
    }

    public prepareContribution(read: Read, envelope: CommandEnvelope) {
        return this.provenance.prepareContribution(read, envelope);
    }

    public applyContribution(
        transaction: Transaction,
        envelope: CommandEnvelope,
        stamp: Parameters<
            PackageInstallationProvenancePort<
                Read | Transaction,
                CommandEnvelope
            >["resolveContributionForApply"]
        >[2],
        entry: SlotEntry
    ): boolean {
        const installation = this.provenance.resolveContributionForApply(
            transaction,
            envelope,
            stamp
        );
        if (installation === undefined || !installation.attribution.equals(entry.attribution)) {
            throw new AgentCoreError(
                "authority.denied",
                "Slot contributor installation provenance changed before apply"
            );
        }
        if (!this.authority.permitsContribution(transaction, entry)) {
            throw new AgentCoreError(
                "authority.denied",
                "Current authority does not admit the Slot contributor"
            );
        }
        const installed = this.slots.loadSlot(transaction, entry.slot);
        if (installed === undefined) {
            throw new AgentCoreError("facet.inactive", `Slot ${entry.slot.value} is not installed`);
        }
        if (!installed.declaration.entrySchema.accepts(entry.value)) {
            throw new AgentCoreError(
                "operation.invalid-input",
                `Slot entry ${entry.id.value} does not match the entry schema`
            );
        }
        return this.contribute(transaction, entry);
    }

    public permitsContribution(read: Read, entry: SlotEntry): boolean {
        return this.authority.permitsContribution(read, entry);
    }

    public slot(read: Read, name: SlotName): InstalledSlot | undefined {
        return this.reads.slot(read, name);
    }

    public applyInstall(
        transaction: Transaction,
        envelope: CommandEnvelope,
        stamp: Parameters<
            PackageInstallationProvenancePort<
                Read | Transaction,
                CommandEnvelope
            >["resolveContributionForApply"]
        >[2],
        slot: InstalledSlot
    ): boolean {
        const installation = this.provenance.resolveContributionForApply(
            transaction,
            envelope,
            stamp
        );
        if (installation === undefined || !installation.attribution.equals(slot.attribution)) {
            throw new AgentCoreError(
                "authority.denied",
                "Slot declarer installation provenance changed before apply"
            );
        }
        if (!this.authority.permitsInstall(transaction, slot)) {
            throw new AgentCoreError(
                "authority.denied",
                "Current authority does not admit the Slot declarer"
            );
        }
        const existing = this.slots.loadSlot(transaction, slot.declaration.name);
        if (existing !== undefined) {
            if (!sameBytes(InstalledSlot.encode(existing), InstalledSlot.encode(slot))) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Slot declaration conflicts with installed provenance"
                );
            }
            return false;
        }
        this.slots.insertSlot(transaction, slot);
        return true;
    }

    public permitsWithdrawal(read: Read, contributor: FacetRef): boolean {
        return this.authority.permitsWithdrawal(read, contributor);
    }

    public withdrawalSet(_read: Read, contributor: FacetRef): SlotWithdrawalSet {
        return this.slots.transaction((transaction) =>
            this.slots.withdrawalSet(transaction, contributor)
        );
    }

    public applyWithdrawal(transaction: Transaction, contributor: FacetRef): boolean {
        if (!this.authority.permitsWithdrawal(transaction, contributor)) {
            throw new AgentCoreError(
                "authority.denied",
                "Current authority does not admit the Facet withdrawal"
            );
        }
        return this.slots.retireWithdrawalSet(transaction, contributor);
    }

    public contribute(transaction: Transaction, entry: SlotEntry): boolean {
        const existing = this.slots.loadEntry(transaction, entry.id);
        if (existing !== undefined) {
            if (!sameBytes(SlotEntry.encode(existing), SlotEntry.encode(entry))) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Slot contribution conflicts with authenticated installation provenance"
                );
            }
            return false;
        }
        this.slots.insertEntry(transaction, entry);
        return true;
    }

    public advanceRevision(transaction: Transaction, expected: Revision): Revision {
        const current = this.slots.loadRevision(transaction);
        if (!current.equals(expected)) {
            throw new AgentCoreError("protocol.revision-conflict", "Slot revision changed");
        }
        const next = current.next();
        this.slots.saveRevision(transaction, next);
        return next;
    }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}
