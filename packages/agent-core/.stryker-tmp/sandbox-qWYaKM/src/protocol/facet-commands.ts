// @ts-nocheck
import type { ActorRef } from "../actors";
import { AgentCoreError } from "../errors";
import {
    Revision,
    decodeBase64,
    decodeCanonicalJson,
    encodeBase64,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";
import {
    canonicalFacetData,
    isFacetData,
    PackageInstallationRef,
    SlotDeclaration,
    SlotEntry,
    SlotName,
    type FacetData
} from "../facets";
import type { CurrentLease, ProtocolCommand } from "./dispatcher";
import type { CommandCaller, CommandEnvelope } from "./envelope";
import type { CommandPayloadCodec } from "./payload";
import { CommandCallerPolicy } from "./policy";
import type { ProtocolCommandExecution, ProtocolValueCodec } from "./registration";

export const FACET_SLOT_COMMANDS = Object.freeze({
    install: "facet.slot.install",
    contribute: "facet.slot.contribute"
});

export interface FacetSlotCommandBackend<Transaction, Read> {
    currentRevision(read: Read): Revision;
    permitsInstall(read: Read, declaration: SlotDeclaration): boolean;
    prepareContribution(
        read: Read,
        envelope: CommandEnvelope
    ): { readonly reference: PackageInstallationRef; readonly stamp: object } | undefined;
    applyContribution(
        transaction: Transaction,
        envelope: CommandEnvelope,
        stamp: object,
        entry: SlotEntry
    ): boolean;
    permitsContribution(read: Read, entry: SlotEntry): boolean;
    slot(read: Read, name: SlotName): SlotDeclaration | undefined;
    install(transaction: Transaction, declaration: SlotDeclaration): boolean;
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

export class FacetSlotInstallCommand<Transaction, Read> implements ProtocolCommand<
    Transaction,
    Read,
    SlotDeclaration,
    FacetSlotCommandReply,
    SlotDeclaration
> {
    public readonly command = FACET_SLOT_COMMANDS.install;
    public readonly caller: CommandCallerPolicy;
    public readonly expectedRevision = "required" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload: CommandPayloadCodec<SlotDeclaration> = new SlotInstallPayloadCodec();
    public readonly replyCodec = facetSlotReplyCodec;
    public readonly observationCodec: ProtocolValueCodec<SlotDeclaration> = {
        encode: SlotDeclaration.encode,
        decode: SlotDeclaration.decode
    };

    public constructor(
        private readonly backend: FacetSlotCommandBackend<Transaction, Read>,
        private readonly target: ActorRef
    ) {
        requireWorkspace(target);
        this.caller = new ExactActorCallerPolicy(target);
    }

    public authorize(read: Read, envelope: CommandEnvelope, payload: SlotDeclaration): boolean {
        const declaration = requireDeclaration(payload);
        return (
            callerIsTarget(envelope.caller, this.target) &&
            this.backend.permitsInstall(read, declaration)
        );
    }

    public permitsLifecycle(
        _read: Read,
        _envelope: CommandEnvelope,
        _payload: SlotDeclaration
    ): boolean {
        return true;
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
    ): ProtocolCommandExecution<FacetSlotCommandReply, SlotDeclaration> {
        const declaration = requireDeclaration(payload);
        const expected = requireExpectedRevision(envelope);
        const changed = this.backend.install(transaction, declaration);
        const revision = changed ? this.backend.advanceRevision(transaction, expected) : expected;
        return {
            reply: Object.freeze({ revision }),
            ...(changed ? { observation: declaration } : {})
        };
    }
}

export class FacetSlotContributeCommand<Transaction, Read> implements ProtocolCommand<
    Transaction,
    Read,
    SlotContributionRequest,
    FacetSlotCommandReply,
    SlotEntry
> {
    readonly #prepared = new WeakMap<CommandEnvelope, PreparedSlotContribution>();
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
        private readonly backend: FacetSlotCommandBackend<Transaction, Read>,
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
            provenance.reference.facet,
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
        const declaration = this.backend.slot(read, prepared.entry.slot);
        return declaration !== undefined && declaration.entrySchema.accepts(prepared.entry.value);
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
        return {
            reply: Object.freeze({ revision }),
            ...(changed ? { observation: prepared.entry } : {})
        };
    }
}

interface PreparedSlotContribution {
    readonly entry: SlotEntry;
    readonly stamp: object;
}

export const FacetSlotCommandPayload = Object.freeze({
    install(declaration: SlotDeclaration): Uint8Array {
        return encodeCanonicalJson({ record: encodeBase64(SlotDeclaration.encode(declaration)) });
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
        const revision = payload["revision"];
        if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
            throw new TypeError("Facet Slot command reply revision is invalid");
        }
        return Object.freeze({ revision: new Revision(revision) });
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

class SlotInstallPayloadCodec implements CommandPayloadCodec {
    public decode(bytes: Uint8Array): SlotDeclaration {
        const payload = requireObject(decodeCanonicalJson(bytes), "Slot install payload");
        if (!hasExactJsonKeys(payload, ["record"])) {
            throw new TypeError("Slot install payload contains missing or unknown fields");
        }
        return SlotDeclaration.decode(
            decodeBase64(requireString(payload["record"], "Slot declaration record"))
        );
    }
}

class SlotContributionPayloadCodec implements CommandPayloadCodec {
    public decode(bytes: Uint8Array): SlotContributionRequest {
        const payload = requireObject(decodeCanonicalJson(bytes), "Slot contribution payload");
        if (!hasExactJsonKeys(payload, ["ordinal", "slot", "value"])) {
            throw new TypeError("Slot contribution payload contains missing or unknown fields");
        }
        const ordinal = payload["ordinal"];
        if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0) {
            throw new TypeError("Slot contribution ordinal must be a non-negative safe integer");
        }
        return Object.freeze({
            slot: new SlotName(requireString(payload["slot"], "Slot contribution slot")),
            ordinal,
            value: canonicalFacetData(payload["value"]!)
        });
    }
}

function requireDeclaration(payload: unknown): SlotDeclaration {
    if (!(payload instanceof SlotDeclaration)) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Slot declaration payload was not decoded"
        );
    }
    return payload;
}

function requireContributionRequest(payload: unknown): SlotContributionRequest {
    if (!isContributionRequest(payload)) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Slot contribution payload was not decoded"
        );
    }
    return payload;
}

function isContributionRequest(payload: unknown): payload is SlotContributionRequest {
    return (
        payload !== null &&
        typeof payload === "object" &&
        (payload as { readonly slot?: unknown }).slot instanceof SlotName &&
        Number.isSafeInteger((payload as { readonly ordinal?: unknown }).ordinal) &&
        (payload as { readonly ordinal: number }).ordinal >= 0 &&
        isFacetData((payload as { readonly value?: unknown }).value)
    );
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
        entry.contributor,
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

function requireObject(value: JsonValue, subject: string): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as { readonly [key: string]: JsonValue };
}

function requireString(value: JsonValue | undefined, subject: string): string {
    if (typeof value !== "string") throw new TypeError(`${subject} must be a string`);
    return value;
}
