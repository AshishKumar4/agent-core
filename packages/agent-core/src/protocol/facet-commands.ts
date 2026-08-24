import type { ActorRef } from "../actors";
import { AgentCoreError } from "../errors";
import {
    Revision,
    decodeBase64,
    decodeCanonicalJson,
    encodeBase64,
    encodeCanonicalJson,
    hasExactJsonKeys,
    isObjectRecord
} from "../core";
import {
    canonicalFacetData,
    ContributionAttribution,
    InstalledSlot,
    isFacetData,
    PackageInstallationRef,
    SlotDeclaration,
    SlotEntry,
    SlotName,
    type FacetData,
    type SlotWithdrawalSet
} from "../facets";
import type { CurrentLease, ProtocolCommand } from "./dispatcher";
import type { CommandCaller, CommandEnvelope } from "./envelope";
import type { CommandPayloadCodec } from "./payload";
import { CommandCallerPolicy } from "./policy";
import type { ProtocolCommandExecution, ProtocolValueCodec } from "./registration";
import { requireNonnegativeInteger, requireObject, requireStringValue } from "./codec";

export const FACET_SLOT_COMMANDS = Object.freeze({
    install: "facet.slot.install",
    contribute: "facet.slot.contribute",
    withdraw: "facet.slot.withdraw"
});

export interface FacetSlotCommandBackend<Transaction, Read, Stamp extends WeakKey = WeakKey> {
    currentRevision(read: Read): Revision;
    permitsInstall(read: Read, slot: InstalledSlot): boolean;
    prepareContribution(
        read: Read,
        envelope: CommandEnvelope
    ): { readonly reference: PackageInstallationRef; readonly stamp: Stamp } | undefined;
    applyInstall(
        transaction: Transaction,
        envelope: CommandEnvelope,
        stamp: Stamp,
        slot: InstalledSlot
    ): boolean;
    applyContribution(
        transaction: Transaction,
        envelope: CommandEnvelope,
        stamp: Stamp,
        entry: SlotEntry
    ): boolean;
    permitsContribution(read: Read, entry: SlotEntry): boolean;
    permitsWithdrawal(read: Read, attribution: ContributionAttribution): boolean;
    withdrawalSet(read: Read, attribution: ContributionAttribution): SlotWithdrawalSet;
    applyWithdrawal(transaction: Transaction, attribution: ContributionAttribution): boolean;
    slot(read: Read, name: SlotName): InstalledSlot | undefined;
    advanceRevision(transaction: Transaction, expected: Revision): Revision;
}

export interface SlotContributionRequest {
    readonly slot: SlotName;
    readonly ordinal: number;
    readonly value: FacetData;
}

export interface FacetSlotCommandReply {
    readonly revision: Revision;
}

export class FacetSlotInstallCommand<
    Transaction,
    Read,
    Stamp extends WeakKey = WeakKey
> implements ProtocolCommand<
    Transaction,
    Read,
    SlotDeclaration,
    FacetSlotCommandReply,
    InstalledSlot
> {
    readonly #prepared = new WeakMap<CommandEnvelope, PreparedSlotInstall<Stamp>>();
    public readonly command = FACET_SLOT_COMMANDS.install;
    public readonly caller: CommandCallerPolicy;
    public readonly expectedRevision = "required" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload: CommandPayloadCodec<SlotDeclaration> = new SlotInstallPayloadCodec();
    public readonly replyCodec = facetSlotReplyCodec;
    public readonly observationCodec: ProtocolValueCodec<InstalledSlot> = {
        encode: InstalledSlot.encode,
        decode: InstalledSlot.decode
    };

    public constructor(
        private readonly backend: FacetSlotCommandBackend<Transaction, Read, Stamp>,
        private readonly target: ActorRef
    ) {
        requireWorkspace(target);
        this.caller = new ExactActorCallerPolicy(target);
    }

    public authorize(read: Read, envelope: CommandEnvelope, payload: SlotDeclaration): boolean {
        const declaration = requireDeclaration(payload);
        this.#prepared.delete(envelope);
        if (!callerIsTarget(envelope.caller, this.target)) return false;
        // §4.2 totality: a Slot the host cannot attribute is refused here rather than
        // installed unattributed, so every installed Slot names a withdrawable Facet.
        const provenance = this.backend.prepareContribution(read, envelope);
        if (provenance === undefined) return false;
        const slot = new InstalledSlot(declaration, provenance.reference.attribution);
        if (!this.backend.permitsInstall(read, slot)) return false;
        this.#prepared.set(envelope, Object.freeze({ slot, stamp: provenance.stamp }));
        return true;
    }

    public permitsLifecycle(
        _read: Read,
        envelope: CommandEnvelope,
        payload: SlotDeclaration
    ): boolean {
        const declaration = requireDeclaration(payload);
        const prepared = this.#prepared.get(envelope);
        return prepared !== undefined && declarationMatchesSlot(declaration, prepared.slot);
    }

    public currentRevision(
        read: Read,
        _envelope: CommandEnvelope,
        _payload: SlotDeclaration
    ): Revision {
        return this.backend.currentRevision(read);
    }

    public currentLease(
        _read: Read,
        _envelope: CommandEnvelope,
        _payload: SlotDeclaration,
        _at: Date
    ): CurrentLease | undefined {
        return undefined;
    }

    public execute(
        transaction: Transaction,
        envelope: CommandEnvelope,
        payload: SlotDeclaration,
        _at: Date
    ): ProtocolCommandExecution<FacetSlotCommandReply, InstalledSlot> {
        const declaration = requireDeclaration(payload);
        const prepared = this.#prepared.get(envelope);
        this.#prepared.delete(envelope);
        if (prepared === undefined || !declarationMatchesSlot(declaration, prepared.slot)) {
            throw new AgentCoreError(
                "authority.denied",
                "Slot install authorization is unavailable or substituted"
            );
        }
        const expected = requireExpectedRevision(envelope);
        const changed = this.backend.applyInstall(
            transaction,
            envelope,
            prepared.stamp,
            prepared.slot
        );
        const revision = changed ? this.backend.advanceRevision(transaction, expected) : expected;
        const execution: ProtocolCommandExecution<FacetSlotCommandReply, InstalledSlot> = {
            outcome: "committed",
            reply: Object.freeze({ revision })
        };
        return changed ? { ...execution, observation: prepared.slot } : execution;
    }
}

interface PreparedSlotInstall<Stamp> {
    readonly slot: InstalledSlot;
    readonly stamp: Stamp;
}

/**
 * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the `administer`-impact retirement of one
 * contribution's records in a single control transaction of the owning Actor. The set is
 * computed by querying attribution, so this command carries only the withdrawing
 * `ContributionAttribution` — the exact FacetRef and PackagePin pair — and never an inverse
 * the Facet supplied.
 */
export class FacetSlotWithdrawCommand<Transaction, Read> implements ProtocolCommand<
    Transaction,
    Read,
    ContributionAttribution,
    FacetSlotCommandReply
> {
    public readonly command = FACET_SLOT_COMMANDS.withdraw;
    public readonly caller: CommandCallerPolicy;
    public readonly expectedRevision = "required" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = new SlotWithdrawalPayloadCodec();
    public readonly replyCodec = facetSlotReplyCodec;

    public constructor(
        private readonly backend: FacetSlotCommandBackend<Transaction, Read>,
        private readonly target: ActorRef
    ) {
        requireWorkspace(target);
        this.caller = new ExactActorCallerPolicy(target);
    }

    public authorize(
        read: Read,
        envelope: CommandEnvelope,
        payload: ContributionAttribution
    ): boolean {
        const attribution = requireAttribution(payload);
        return (
            callerIsTarget(envelope.caller, this.target) &&
            this.backend.permitsWithdrawal(read, attribution)
        );
    }

    public permitsLifecycle(
        read: Read,
        _envelope: CommandEnvelope,
        payload: ContributionAttribution
    ): boolean {
        // The set must be computable before the transaction begins; a host that cannot
        // compute it refuses the withdrawal rather than performing a partial one.
        this.backend.withdrawalSet(read, requireAttribution(payload));
        return true;
    }

    public currentRevision(
        read: Read,
        _envelope: CommandEnvelope,
        _payload: ContributionAttribution
    ): Revision {
        return this.backend.currentRevision(read);
    }

    public currentLease(
        _read: Read,
        _envelope: CommandEnvelope,
        _payload: ContributionAttribution,
        _at: Date
    ): CurrentLease | undefined {
        return undefined;
    }

    public execute(
        transaction: Transaction,
        envelope: CommandEnvelope,
        payload: ContributionAttribution,
        _at: Date
    ): ProtocolCommandExecution<FacetSlotCommandReply, never> {
        const attribution = requireAttribution(payload);
        const expected = requireExpectedRevision(envelope);
        const changed = this.backend.applyWithdrawal(transaction, attribution);
        const revision = changed ? this.backend.advanceRevision(transaction, expected) : expected;
        return { outcome: "committed", reply: Object.freeze({ revision }) };
    }
}

export class FacetSlotContributeCommand<
    Transaction,
    Read,
    Stamp extends WeakKey = WeakKey
> implements ProtocolCommand<
    Transaction,
    Read,
    SlotContributionRequest,
    FacetSlotCommandReply,
    SlotEntry
> {
    readonly #prepared = new WeakMap<CommandEnvelope, PreparedSlotContribution<Stamp>>();
    public readonly command = FACET_SLOT_COMMANDS.contribute;
    public readonly caller: CommandCallerPolicy;
    public readonly expectedRevision = "required" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload: CommandPayloadCodec<SlotContributionRequest> =
        new SlotContributionPayloadCodec();
    public readonly replyCodec = facetSlotReplyCodec;
    public readonly observationCodec: ProtocolValueCodec<SlotEntry> = {
        encode: SlotEntry.encode,
        decode: SlotEntry.decode
    };

    public constructor(
        private readonly backend: FacetSlotCommandBackend<Transaction, Read, Stamp>,
        private readonly target: ActorRef
    ) {
        requireWorkspace(target);
        this.caller = new ExactActorCallerPolicy(target);
    }

    public authorize(
        read: Read,
        envelope: CommandEnvelope,
        payload: SlotContributionRequest
    ): boolean {
        const request = requireContributionRequest(payload);
        this.#prepared.delete(envelope);
        if (!callerIsTarget(envelope.caller, this.target)) return false;
        const provenance = this.backend.prepareContribution(read, envelope);
        if (provenance === undefined) return false;
        const entry = new SlotEntry(
            request.slot,
            provenance.reference.attribution,
            request.ordinal,
            request.value
        );
        if (!this.backend.permitsContribution(read, entry)) return false;
        this.#prepared.set(envelope, Object.freeze({ entry, stamp: provenance.stamp }));
        return true;
    }

    public permitsLifecycle(
        read: Read,
        envelope: CommandEnvelope,
        payload: SlotContributionRequest
    ): boolean {
        const request = requireContributionRequest(payload);
        const prepared = this.#prepared.get(envelope);
        if (prepared === undefined || !requestMatchesEntry(request, prepared.entry)) return false;
        const installed = this.backend.slot(read, prepared.entry.slot);
        return (
            installed !== undefined &&
            installed.declaration.entrySchema.accepts(prepared.entry.value)
        );
    }

    public currentRevision(
        read: Read,
        _envelope: CommandEnvelope,
        _payload: SlotContributionRequest
    ): Revision {
        return this.backend.currentRevision(read);
    }

    public currentLease(
        _read: Read,
        _envelope: CommandEnvelope,
        _payload: SlotContributionRequest,
        _at: Date
    ): CurrentLease | undefined {
        return undefined;
    }

    public execute(
        transaction: Transaction,
        envelope: CommandEnvelope,
        payload: SlotContributionRequest,
        _at: Date
    ): ProtocolCommandExecution<FacetSlotCommandReply, SlotEntry> {
        const request = requireContributionRequest(payload);
        const prepared = this.#prepared.get(envelope);
        this.#prepared.delete(envelope);
        if (prepared === undefined || !requestMatchesEntry(request, prepared.entry)) {
            throw new AgentCoreError(
                "authority.denied",
                "Slot contribution authorization is unavailable or substituted"
            );
        }
        const expected = requireExpectedRevision(envelope);
        const changed = this.backend.applyContribution(
            transaction,
            envelope,
            prepared.stamp,
            prepared.entry
        );
        const revision = changed ? this.backend.advanceRevision(transaction, expected) : expected;
        const execution: ProtocolCommandExecution<FacetSlotCommandReply, SlotEntry> = {
            outcome: "committed",
            reply: Object.freeze({ revision })
        };
        return changed ? { ...execution, observation: prepared.entry } : execution;
    }
}

interface PreparedSlotContribution<Stamp> {
    readonly entry: SlotEntry;
    readonly stamp: Stamp;
}

export const FacetSlotCommandPayload = Object.freeze({
    install(declaration: SlotDeclaration): Uint8Array {
        return encodeCanonicalJson({ record: encodeBase64(SlotDeclaration.encode(declaration)) });
    },
    withdraw(attribution: ContributionAttribution): Uint8Array {
        return encodeCanonicalJson(attribution.encodeFields());
    },
    contribute(request: SlotContributionRequest): Uint8Array {
        if (!Number.isSafeInteger(request.ordinal) || request.ordinal < 0) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Slot contribution ordinal must be a non-negative safe integer"
            );
        }
        return encodeCanonicalJson({
            ordinal: request.ordinal,
            slot: request.slot.value,
            value: canonicalFacetData(request.value)
        });
    }
});

class FacetSlotReplyCodec implements ProtocolValueCodec<FacetSlotCommandReply> {
    public encode(reply: FacetSlotCommandReply): Uint8Array {
        return encodeCanonicalJson({ revision: reply.revision.value });
    }

    public decode(bytes: Uint8Array): FacetSlotCommandReply {
        const payload = requireObject(decodeCanonicalJson(bytes), "Facet Slot command reply");
        if (!hasExactJsonKeys(payload, ["revision"])) {
            throw new TypeError("Facet Slot command reply contains missing or unknown fields");
        }
        try {
            return Object.freeze({
                revision: new Revision(
                    requireNonnegativeInteger(
                        payload["revision"],
                        "Facet Slot command reply revision"
                    )
                )
            });
        } catch {
            throw new TypeError("Facet Slot command reply revision is invalid");
        }
    }
}

const facetSlotReplyCodec = new FacetSlotReplyCodec();

class ExactActorCallerPolicy extends CommandCallerPolicy {
    public constructor(private readonly target: ActorRef) {
        super();
    }

    public admits(caller: CommandCaller): boolean {
        return callerIsTarget(caller, this.target);
    }
}

class SlotInstallPayloadCodec implements CommandPayloadCodec<SlotDeclaration> {
    public decode(bytes: Uint8Array): SlotDeclaration {
        const payload = requireObject(decodeCanonicalJson(bytes), "Slot install payload");
        if (!hasExactJsonKeys(payload, ["record"])) {
            throw new TypeError("Slot install payload contains missing or unknown fields");
        }
        return SlotDeclaration.decode(
            decodeBase64(requireStringValue(payload["record"], "Slot declaration record"))
        );
    }
}

class SlotWithdrawalPayloadCodec implements CommandPayloadCodec<ContributionAttribution> {
    public decode(bytes: Uint8Array): ContributionAttribution {
        const payload = requireObject(decodeCanonicalJson(bytes), "Slot withdrawal payload");
        if (!hasExactJsonKeys(payload, ["contributor", "package"])) {
            throw new TypeError("Slot withdrawal payload contains missing or unknown fields");
        }
        return ContributionAttribution.decodeFields(payload, "Slot withdrawal");
    }
}

class SlotContributionPayloadCodec implements CommandPayloadCodec<SlotContributionRequest> {
    public decode(bytes: Uint8Array): SlotContributionRequest {
        const payload = requireObject(decodeCanonicalJson(bytes), "Slot contribution payload");
        if (!hasExactJsonKeys(payload, ["ordinal", "slot", "value"])) {
            throw new TypeError("Slot contribution payload contains missing or unknown fields");
        }
        const ordinal = requireNonnegativeInteger(payload["ordinal"], "Slot contribution ordinal");
        return Object.freeze({
            slot: new SlotName(requireStringValue(payload["slot"], "Slot contribution slot")),
            ordinal,
            value: canonicalFacetData(payload["value"])
        });
    }
}

function requireDeclaration(payload: SlotDeclaration): SlotDeclaration {
    if (!(payload instanceof SlotDeclaration)) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Slot declaration payload was not decoded"
        );
    }
    return payload;
}

function requireAttribution(payload: ContributionAttribution): ContributionAttribution {
    if (!(payload instanceof ContributionAttribution)) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Slot withdrawal payload was not decoded"
        );
    }
    return payload;
}

function declarationMatchesSlot(declaration: SlotDeclaration, slot: InstalledSlot): boolean {
    const expected = SlotDeclaration.encode(slot.declaration);
    const actual = SlotDeclaration.encode(declaration);
    return (
        expected.byteLength === actual.byteLength &&
        expected.every((value, index) => value === actual[index])
    );
}

function requireContributionRequest(payload: SlotContributionRequest): SlotContributionRequest {
    if (
        !isObjectRecord(payload) ||
        !(payload.slot instanceof SlotName) ||
        !Number.isSafeInteger(payload.ordinal) ||
        payload.ordinal < 0 ||
        !isFacetData(payload.value)
    ) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Slot contribution payload was not decoded"
        );
    }
    return Object.freeze({
        slot: new SlotName(payload.slot.value),
        ordinal: payload.ordinal,
        value: canonicalFacetData(payload.value)
    });
}

function requireExpectedRevision(envelope: CommandEnvelope): Revision {
    if (envelope.expectedRevision === undefined) {
        throw new AgentCoreError(
            "protocol.revision-conflict",
            "Facet Slot commands require an expected revision"
        );
    }
    return envelope.expectedRevision;
}

function requireWorkspace(target: ActorRef): void {
    if (target.kind !== "workspace")
        throw new TypeError("Facet Slot commands require a Workspace Actor");
}

function callerIsTarget(caller: CommandCaller, target: ActorRef): boolean {
    return caller.kind === "actor" && caller.actor.equals(target);
}

function requestMatchesEntry(request: SlotContributionRequest, entry: SlotEntry): boolean {
    const candidate = new SlotEntry(
        request.slot,
        entry.attribution,
        request.ordinal,
        request.value
    );
    const expected = SlotEntry.encode(entry);
    const actual = SlotEntry.encode(candidate);
    return (
        expected.byteLength === actual.byteLength &&
        expected.every((value, index) => value === actual[index])
    );
}
