import type { ContentPutResult } from "../../content";
import { ContentStore, type ContentStat, type MediaHint } from "../../content";
import {
    ContentRef,
    Digest,
    RecordCodec,
    TextId,
    decodeBase64,
    encodeBase64,
    encodeCanonicalJson,
    type JsonValue
} from "../../core";
import { RunCommitId } from "../../execution-references";
import { AgentCoreError } from "../../errors";
import {
    BindingName,
    FacetPackageId,
    FacetRef,
    OperationDescriptor,
    OperationRef,
    canonicalFacetData,
    type FacetData
} from "../../facets";
import { OperationGateway, type OperationRequestKey, type ResolvedFacet } from "../../operations";
import { InvocationId } from "../../interaction-references";
import { ReceiptId } from "../../invocation-references";
import { RunCommit } from "./commit";
import { TurnInboxEntryId } from "./id";
import type { TurnAdmissionHandle, TurnAdmissionVerifier } from "./handle";
import { leaseTokensEqual, type LeaseToken } from "./lease";
import type { TurnPlacementSnapshot } from "./placement";
import {
    CodecRecord,
    bytesEqual,
    requireArray,
    requireExactFields,
    requireInteger,
    requireObject,
    requireString
} from "../record-data";
import type { RunBranch } from "./run";
import { RunRuntime } from "./runtime";
import { RunRepository } from "./store";
import { effectiveCommitOf, effectiveTranscript } from "./transcript";
import { RunCheckpoint, Turn, TurnInboxEntry } from "./turn";

export class TurnBoundOperation {
    public constructor(
        public readonly binding: BindingName,
        public readonly facet: FacetRef,
        public readonly operation: OperationRef,
        public readonly descriptor: OperationDescriptor
    ) {
        const separator = facet.value.indexOf(":");
        const facetPackage = new FacetPackageId(facet.value.slice(0, separator));
        if (!operation.facet.equals(facetPackage) || !operation.operation.equals(descriptor.name)) {
            throw new TypeError(
                "A bound Operation Facet, reference, and descriptor must identify one operation"
            );
        }
        Object.freeze(this);
    }
}

export interface TurnExecutionScope {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly effectiveCommit: RunCommit;
    readonly placement: TurnPlacementSnapshot;
    readonly resumeCheckpoint: RunCheckpoint | undefined;
}

export abstract class TurnOperationSource {
    public abstract resolve(scope: TurnExecutionScope): Promise<readonly TurnBoundOperation[]>;
}

export interface TurnPromptAssembly extends TurnExecutionScope {
    readonly operations: readonly TurnBoundOperation[];
}

export abstract class TurnPromptAssembler {
    public abstract assemble(request: TurnPromptAssembly): Promise<ContentRef>;
}

export interface TurnInvocationRequest {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly operation: TurnBoundOperation;
    readonly requestKey: OperationRequestKey;
    readonly input: FacetData;
    readonly signal: AbortSignal;
}

/**
 * Which enforcement tier served the call (§7.2). Only `mediated` carries evidence: a
 * direct call performs its authority, lease, watermark, PathEpochEvidence, and deadline
 * checks in memory and writes nothing durable, so there is no Invocation for it to name.
 * The tier is on the result rather than the request because policy, not the executor,
 * decides it — the agent loop that §1.1 motivates the direct tier for makes an ordinary
 * `observe` call and is served by whichever tier the resolved authority admits.
 */
export type TurnInvocationResult =
    | { readonly tier: "direct"; readonly output: FacetData }
    | {
          readonly tier: "mediated";
          readonly output: FacetData;
          readonly evidence: FacetData;
          /**
           * The verified admission identity of this call, which an executor MAY hand the
           * model in place of the output (SPEC §5.6). It is built from the Invocation,
           * EffectAttempt and Receipt this dispatch already produced, so offering it changes
           * nothing about admission.
           */
          readonly admission: TurnAdmissionHandle;
      };

export abstract class TurnInvocationPort {
    public abstract invoke(request: TurnInvocationRequest): Promise<TurnInvocationResult>;
}

export interface TurnGatewayScope {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly signal: AbortSignal;
}

export abstract class TurnGatewaySource {
    public abstract open(scope: TurnGatewayScope): Promise<OperationGateway>;
}

export class GatewayTurnInvocationPort extends TurnInvocationPort {
    public constructor(
        private readonly gateways: TurnGatewaySource,
        private readonly admissions: TurnAdmissionVerifier
    ) {
        super();
    }

    public async invoke(request: TurnInvocationRequest): Promise<TurnInvocationResult> {
        requireNotCancelled(request.signal);
        const gateway = await this.gateways.open(
            Object.freeze({
                turn: request.turn,
                token: request.token,
                signal: request.signal
            })
        );
        requireNotCancelled(request.signal);
        let resolved: ResolvedFacet | undefined;
        const releaseOnAbort = () => resolved?.[Symbol.dispose]();
        request.signal.addEventListener("abort", releaseOnAbort, { once: true });
        try {
            resolved = await gateway.resolve(request.operation.binding);
            requireNotCancelled(request.signal);
            const descriptor = resolved.descriptor(request.operation.descriptor.name);
            if (
                !resolved.facet.equals(request.operation.facet) ||
                !resolved.package.equals(request.operation.operation.facet) ||
                descriptor === undefined ||
                !bytesEqual(
                    OperationDescriptor.encode(descriptor),
                    OperationDescriptor.encode(request.operation.descriptor)
                )
            ) {
                throw new AgentCoreError(
                    "binding.invalid",
                    "Resolved operation does not match the exact bound Turn Operation"
                );
            }
            requireNotCancelled(request.signal);
            const result = await resolved.dispatch({
                requestKey: request.requestKey,
                operation: descriptor.name,
                payload: { kind: "single", input: canonicalFacetData(request.input) }
            });
            requireNotCancelled(request.signal);
            if (result.kind !== "mediated") {
                return canonicalInvocationResult({ tier: "direct", output: result.output });
            }
            const evidence = canonicalFacetData(result.evidence);
            const named = admittedIdentity(evidence);
            return canonicalInvocationResult({
                tier: "mediated",
                output: result.output,
                evidence,
                admission: await this.admissions.verify({
                    run: request.turn.run,
                    turn: request.turn.id,
                    token: request.token,
                    impact: descriptor.impact,
                    invocation: named.invocation,
                    receipts: named.receipts
                })
            });
        } finally {
            request.signal.removeEventListener("abort", releaseOnAbort);
            resolved?.[Symbol.dispose]();
        }
    }
}

export interface TurnModelUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}

/**
 * One prompt section's name, so a request records the order it was assembled in as
 * nameable parts rather than as one opaque blob.
 */
export class TurnPromptSectionName extends TextId {
    public constructor(value: string) {
        super(value, "Prompt section name");
    }
}

/**
 * How much of a value the model was NOT shown, as metadata about the bytes it WAS shown
 * (SPEC §5.6). `none` withholds nothing, `exact` states a positive withheld amount, and
 * `unknown` is the honest case for a host that bounded a stream it never read to the end.
 * A two-case shape would force that host to report a guess as exact, and `exact` refuses
 * a zero so the absence of an omission stays distinguishable from one that withheld
 * nothing. An omission is always a budget decision about a value recorded whole
 * elsewhere, never a report that its source had less to give (§7.4).
 */
export class TurnOmission {
    public static readonly none = new TurnOmission("none", undefined);
    public static readonly unknown = new TurnOmission("unknown", undefined);

    public static exact(withheldBytes: number): TurnOmission {
        return new TurnOmission("exact", withheldBytes);
    }

    private constructor(
        public readonly kind: "none" | "exact" | "unknown",
        public readonly withheldBytes: number | undefined
    ) {
        if (kind === "exact") {
            if (
                withheldBytes === undefined ||
                !Number.isSafeInteger(withheldBytes) ||
                withheldBytes <= 0
            ) {
                throw new TypeError(
                    "An exact omission withholds at least one byte; withholding nothing is TurnOmission.none"
                );
            }
        } else if (withheldBytes !== undefined) {
            throw new TypeError("Only an exact omission states a withheld amount");
        }
        Object.freeze(this);
    }

    public equals(other: TurnOmission): boolean {
        return this.kind === other.kind && this.withheldBytes === other.withheldBytes;
    }

    public toData(): JsonValue {
        return this.withheldBytes === undefined
            ? { kind: this.kind }
            : { kind: this.kind, withheldBytes: this.withheldBytes };
    }

    public static fromData(value: JsonValue): TurnOmission {
        const object = requireObject(value, "Turn omission");
        requireExactFields(object, ["kind"], ["withheldBytes"], "Turn omission");
        const kind = requireString(object["kind"], "Turn omission kind");
        if (kind === "exact") {
            return TurnOmission.exact(
                requireInteger(object["withheldBytes"], "Turn omission withheld amount")
            );
        }
        if (object["withheldBytes"] !== undefined) {
            throw new TypeError("Only an exact omission states a withheld amount");
        }
        if (kind === "none") return TurnOmission.none;
        if (kind === "unknown") return TurnOmission.unknown;
        throw new TypeError("Turn omission kind is unknown");
    }
}

/**
 * The bytes the model observed, held inline or by a `ContentRef` that resolves to exactly
 * them. Never by a digest of them: a digest proves what a value was while only a
 * reference retrieves it (SPEC §1.4), and never as a derivation over some larger value,
 * because ending retention of that value would leave the observed form unrebuildable.
 */
export class TurnShownContent {
    readonly #bytes: Uint8Array | undefined;

    public static inline(bytes: Uint8Array): TurnShownContent {
        return new TurnShownContent(bytes, undefined);
    }

    public static reference(ref: ContentRef): TurnShownContent {
        return new TurnShownContent(undefined, ref);
    }

    private constructor(
        bytes: Uint8Array | undefined,
        public readonly ref: ContentRef | undefined
    ) {
        if ((bytes === undefined) === (ref === undefined)) {
            throw new TypeError("Shown content is held either inline or by one reference");
        }
        if (bytes !== undefined && !(bytes instanceof Uint8Array)) {
            throw new TypeError("Inline shown content must be a Uint8Array");
        }
        if (ref !== undefined && !(ref instanceof ContentRef)) {
            throw new TypeError("Shown content reference must be a ContentRef");
        }
        this.#bytes = bytes?.slice();
        Object.freeze(this);
    }

    /** The inline bytes, copied, or nothing when this content is held by reference. */
    public inlineBytes(): Uint8Array | undefined {
        return this.#bytes?.slice();
    }

    public toData(): JsonValue {
        return this.#bytes === undefined
            ? { ref: required(this.ref, "Shown content requires bytes or a reference").value }
            : { inline: encodeBase64(this.#bytes) };
    }

    public static fromData(value: JsonValue): TurnShownContent {
        const object = requireObject(value, "Shown content");
        requireExactFields(object, [], ["inline", "ref"], "Shown content");
        const inline = object["inline"];
        const ref = object["ref"];
        if ((inline === undefined) === (ref === undefined)) {
            throw new TypeError("Shown content is held either inline or by one reference");
        }
        return inline === undefined
            ? TurnShownContent.reference(
                  new ContentRef(requireString(ref, "Shown content reference"))
              )
            : TurnShownContent.inline(decodeBase64(requireString(inline, "Inline shown content")));
    }
}

/** One assembled prompt section as the model observed it, in the request's final order. */
export class TurnPromptSection {
    public constructor(
        public readonly name: TurnPromptSectionName,
        public readonly shown: TurnShownContent,
        public readonly omission: TurnOmission = TurnOmission.none
    ) {
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            name: this.name.value,
            omission: this.omission.toData(),
            shown: this.shown.toData()
        };
    }

    public static fromData(value: JsonValue): TurnPromptSection {
        const object = requireObject(value, "Prompt section");
        requireExactFields(object, ["name", "omission", "shown"], [], "Prompt section");
        return new TurnPromptSection(
            new TurnPromptSectionName(requireString(object["name"], "Prompt section name")),
            TurnShownContent.fromData(requireShown(object["shown"])),
            TurnOmission.fromData(requireShown(object["omission"]))
        );
    }
}

/**
 * An inbox Event the call admitted. The request names the Event's content directly, so a
 * reconstruction depends on the undeletable RunCommit that carries it rather than on the
 * Event record, which SPEC §6.1 declares immutable and never undeletable. Events the cut
 * covered but the call did not admit are absent, and so stay releasable.
 */
export class TurnAdmittedEvent {
    public constructor(
        public readonly entry: TurnInboxEntryId,
        public readonly sequence: number,
        public readonly event: string,
        public readonly content: ContentRef
    ) {
        if (!Number.isSafeInteger(sequence) || sequence < 0) {
            throw new TypeError("Admitted Event sequence must be a non-negative safe integer");
        }
        if (event.length === 0) throw new TypeError("Admitted Event kind is required");
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            content: this.content.value,
            entry: this.entry.value,
            event: this.event,
            sequence: this.sequence
        };
    }

    public static fromData(value: JsonValue): TurnAdmittedEvent {
        const object = requireObject(value, "Admitted Event");
        requireExactFields(object, ["content", "entry", "event", "sequence"], [], "Admitted Event");
        return new TurnAdmittedEvent(
            new TurnInboxEntryId(requireString(object["entry"], "Admitted Event entry")),
            requireInteger(object["sequence"], "Admitted Event sequence"),
            requireString(object["event"], "Admitted Event kind"),
            new ContentRef(requireString(object["content"], "Admitted Event content"))
        );
    }
}

export interface TurnModelInputInit {
    readonly sections: readonly TurnPromptSection[];
    readonly catalog: readonly TurnBoundOperation[];
    readonly admitted: readonly TurnAdmittedEvent[];
    readonly admissionCut: number;
    readonly covers: readonly RunCommitId[];
}

/**
 * The complete model input one call issued, as the model observed it: the assembled
 * sections in their final order, the operation catalog as offered, and the inbox
 * admission cut. It is the content of a `modelInput` RunCommit, whose parent is the exact
 * commit the call read, so the base of any derivation over history is fixed by ancestry
 * rather than by when a reconstruction happens to run.
 *
 * `covers` names the transcript commits the assembled sections carry, in the order they
 * carry them. It lifts that fact out of the section bytes for the same reason SPEC §5.2
 * puts a message's `requests` in the graph rather than in its content: prose cannot be
 * asked which commits it renders, so a claim inside it is unreadable by any check.
 */
export class TurnModelInput extends CodecRecord {
    public static get codec(): RecordCodec<TurnModelInput> {
        return TurnModelInputCodec;
    }
    public readonly sections: readonly TurnPromptSection[];
    public readonly catalog: readonly TurnBoundOperation[];
    public readonly admitted: readonly TurnAdmittedEvent[];
    public readonly admissionCut: number;
    public readonly covers: readonly RunCommitId[];

    public constructor(init: TurnModelInputInit) {
        super();
        if (init.sections.length === 0) {
            throw new TypeError("A model input records at least one prompt section");
        }
        if (!Number.isSafeInteger(init.admissionCut) || init.admissionCut < 0) {
            throw new TypeError("An inbox admission cut is a non-negative safe integer");
        }
        let previous = -1;
        for (const admitted of init.admitted) {
            if (admitted.sequence <= previous || admitted.sequence >= init.admissionCut) {
                throw new TypeError(
                    "Admitted Events must ascend by sequence and fall inside the admission cut"
                );
            }
            previous = admitted.sequence;
        }
        if (new Set(init.covers.map((commit) => commit.value)).size !== init.covers.length) {
            throw new TypeError("One surface carries a transcript commit at most once");
        }
        this.sections = Object.freeze([...init.sections]);
        this.catalog = Object.freeze(validateOfferedCatalog(init.catalog));
        this.admitted = Object.freeze([...init.admitted]);
        this.admissionCut = init.admissionCut;
        this.covers = Object.freeze([...init.covers]);
        Object.freeze(this);
    }

    public toData(): JsonValue {
        return {
            admissionCut: this.admissionCut,
            admitted: this.admitted.map((admitted) => admitted.toData()),
            catalog: this.catalog.map(boundOperationData),
            covers: this.covers.map((commit) => commit.value),
            sections: this.sections.map((section) => section.toData())
        };
    }

    public static fromData(value: JsonValue): TurnModelInput {
        const object = requireObject(value, "Model input");
        requireExactFields(
            object,
            ["admissionCut", "admitted", "catalog", "covers", "sections"],
            [],
            "Model input"
        );
        return new TurnModelInput({
            sections: requireArray(object["sections"], "Model input sections").map(
                TurnPromptSection.fromData
            ),
            catalog: requireArray(object["catalog"], "Model input catalog").map(
                boundOperationFromData
            ),
            admitted: requireArray(object["admitted"], "Model input admitted Events").map(
                TurnAdmittedEvent.fromData
            ),
            admissionCut: requireInteger(object["admissionCut"], "Model input admission cut"),
            covers: requireArray(object["covers"], "Model input coverage").map(
                (commit) => new RunCommitId(requireString(commit, "Covered commit"))
            )
        });
    }
}

class ModelInputCodec extends RecordCodec<TurnModelInput> {
    public constructor() {
        super(
            [
                TurnModelInput,
                TurnPromptSection,
                TurnPromptSectionName,
                TurnBoundOperation,
                TurnAdmittedEvent,
                RunCommitId
            ],
            "turn.model-input",
            { major: 1, minor: 0 }
        );
    }

    protected encodePayload(value: TurnModelInput): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): TurnModelInput {
        return TurnModelInput.fromData(value);
    }
}

export const TurnModelInputCodec: RecordCodec<TurnModelInput> = new ModelInputCodec();

/** One section's observed bytes, with the omission fact that accompanies them. */
export interface TurnShownSection {
    readonly name: TurnPromptSectionName;
    readonly bytes: Uint8Array;
    readonly omission: TurnOmission;
}

/** One admitted Event's observed payload, resolved from the content the request names. */
export interface TurnAdmittedContent {
    readonly entry: TurnInboxEntryId;
    readonly sequence: number;
    readonly event: string;
    readonly content: ContentRef;
    readonly bytes: Uint8Array;
}

/**
 * The complete request as the model observed it, reconstructed from committed records
 * alone. A model call issues this value rather than a separately assembled one, so the
 * request and its record cannot drift.
 */
export interface TurnModelRequest {
    readonly input: RunCommitId;
    readonly baseCommit: RunCommitId;
    readonly sections: readonly TurnShownSection[];
    readonly catalog: readonly TurnBoundOperation[];
    readonly admitted: readonly TurnAdmittedContent[];
    readonly admissionCut: number;
    readonly covers: readonly RunCommitId[];
}

export interface TurnModelCall extends TurnModelRequest {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly signal: AbortSignal;
}

export interface TurnModelResult {
    readonly output: ContentRef;
    readonly usage: TurnModelUsage;
}

export abstract class TurnModelPort {
    public abstract call(request: TurnModelCall): Promise<TurnModelResult>;
}

/** The canonical bytes of a request, so a replay compares byte for byte against what was sent. */
export function turnModelRequestBytes(request: TurnModelRequest): Uint8Array {
    return encodeCanonicalJson({
        admissionCut: request.admissionCut,
        admitted: request.admitted.map((admitted) => ({
            bytes: encodeBase64(admitted.bytes),
            content: admitted.content.value,
            entry: admitted.entry.value,
            event: admitted.event,
            sequence: admitted.sequence
        })),
        baseCommit: request.baseCommit.value,
        catalog: request.catalog.map(boundOperationData),
        covers: request.covers.map((commit) => commit.value),
        input: request.input.value,
        sections: request.sections.map((section) => ({
            bytes: encodeBase64(section.bytes),
            name: section.name.value,
            omission: section.omission.toData()
        }))
    });
}

export interface TurnModelInputRecords<Transaction> {
    readonly repository: RunRepository<Transaction>;
    readonly content: ContentStore;
}

/**
 * The records-only reconstruction SPEC §5.6 requires. It reads a Turn's committed records
 * alone — a `modelInput` RunCommit, the content that commit names, and nothing from
 * executor memory — and yields the exact request the model received, which is why it
 * survives a restart that discards the executor process. Content a request names that is
 * no longer retained fails typed and names what is missing; it never yields a shorter
 * prefix, a partial request, or a best-effort approximation.
 */
export class TurnModelInputReplay<Transaction> {
    public constructor(private readonly records: TurnModelInputRecords<Transaction>) {}

    public async reconstruct(input: RunCommitId): Promise<TurnModelRequest> {
        const commit = this.records.repository.transaction((transaction) =>
            this.records.repository.loadCommit(transaction, input)
        );
        if (commit === undefined || commit.kind !== "modelInput") {
            throw unrebuildable(`no model input commit ${input.value}`);
        }
        const document = required(commit.content, "Model input commit requires content");
        const baseCommit = required(commit.parents[0], "Model input commit requires one parent");
        const record = TurnModelInput.decode(
            await this.resolve(document, `model input ${input.value}`)
        );
        this.requireAccounted(input, baseCommit, record);
        const sections: TurnShownSection[] = [];
        for (const section of record.sections) {
            sections.push(
                Object.freeze({
                    name: section.name,
                    bytes: await this.shown(section),
                    omission: section.omission
                })
            );
        }
        const admitted: TurnAdmittedContent[] = [];
        for (const event of record.admitted) {
            admitted.push(
                Object.freeze({
                    entry: event.entry,
                    sequence: event.sequence,
                    event: event.event,
                    content: event.content,
                    bytes: await this.resolve(event.content, `admitted Event ${event.entry.value}`)
                })
            );
        }
        return Object.freeze({
            input,
            baseCommit,
            sections: Object.freeze(sections),
            catalog: record.catalog,
            admitted: Object.freeze(admitted),
            admissionCut: record.admissionCut,
            covers: record.covers
        });
    }

    private async shown(section: TurnPromptSection): Promise<Uint8Array> {
        const inline = section.shown.inlineBytes();
        return inline === undefined
            ? this.resolve(
                  required(section.shown.ref, "Shown content requires bytes or a reference"),
                  `prompt section ${section.name.value}`
              )
            : inline;
    }

    /**
     * The transcript commits a surface assembled at `base` must account for, in the order it
     * must carry them. A host reads this to know what it owes the record; the check below
     * reads the same derivation, so what a host is told and what it is held to cannot differ.
     */
    public accountable(base: RunCommitId): readonly RunCommitId[] {
        return this.records.repository.transaction((transaction) => {
            const load = (id: RunCommitId): RunCommit | undefined =>
                this.records.repository.loadCommit(transaction, id);
            return Object.freeze(
                accountableTranscript(
                    effectiveTranscript(effectiveCommitOf(load, base), load)
                ).map((commit) => commit.id)
            );
        });
    }

    /**
     * Refuses a surface whose coverage is not exactly the transcript it was assembled over.
     * The comparison is a sequence equality against the effective transcript at `base`
     * restricted to the commits a surface can carry, so the only conforming way to put less
     * history in front of the model is a `rewrite` that shadows it — a reduction the host
     * kept in its own memory leaves commits this derivation still reaches and no section
     * claims. It guards both boundaries: the seam calls it before the record is appended, and
     * every reconstruction calls it again, so a surface written by any other writer is
     * refused on the way out even though nothing refused it on the way in.
     */
    public requireAccounted(
        input: RunCommitId,
        base: RunCommitId,
        record: TurnModelInput
    ): void {
        const accountable = this.accountable(base);
        const covered = record.covers;
        if (covered.length !== accountable.length) {
            throw unaccounted(
                input,
                `it carries ${covered.length} of the ${accountable.length} commits the transcript at ${base.value} holds`
            );
        }
        for (const [position, commit] of accountable.entries()) {
            const claimed = covered[position];
            if (claimed === undefined || !claimed.equals(commit)) {
                throw unaccounted(
                    input,
                    `position ${position} carries ${claimed?.value ?? "nothing"} where the transcript at ${base.value} holds ${commit.value}`
                );
            }
        }
    }

    private async resolve(ref: ContentRef, subject: string): Promise<Uint8Array> {
        try {
            return (await this.records.content.get(ref)).slice();
        } catch {
            // Retention is legitimately finite (SPEC §8.2), so unresolvable content is a
            // reportable outcome rather than an internal failure. Losing content is
            // allowed; losing it silently is what this rule forbids.
            throw unrebuildable(`${subject} names unretained content ${ref.value}`);
        }
    }
}

export type TurnStreamEvent =
    | { readonly kind: "content"; readonly bytes: Uint8Array }
    | { readonly kind: "usage"; readonly usage: TurnModelUsage };

export interface TurnStreamPublication {
    readonly turn: Turn;
    readonly token: LeaseToken;
    readonly event: TurnStreamEvent;
}

export abstract class TurnStreamPort {
    public abstract publish(publication: TurnStreamPublication): Promise<void>;
}

export type TurnOutcome =
    | {
          readonly kind: "succeeded";
          readonly result: ContentRef;
          readonly commit: RunCommitId;
      }
    | { readonly kind: "failed"; readonly result: ContentRef; readonly commit: RunCommitId }
    | {
          readonly kind: "suspended";
          readonly checkpoint: RunCheckpoint;
          readonly commit: RunCommitId;
      }
    | {
          readonly kind: "cancelled";
          readonly result?: ContentRef;
          readonly commit?: RunCommitId;
      };

export abstract class TurnContentHandle {
    public abstract put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult>;
    public abstract get(ref: ContentRef): Promise<Uint8Array>;
    public abstract stat(ref: ContentRef): Promise<ContentStat | undefined>;
}

/**
 * What an executor assembles to put in front of the model. It is not yet the request: the
 * host records it, then issues the reconstruction of what it recorded.
 */
export interface TurnModelInputAssembly {
    readonly sections: readonly TurnPromptSection[];
    readonly catalog: readonly TurnBoundOperation[];
    readonly admitted: readonly TurnInboxEntry[];
    /** The transcript commits these sections carry, which `TurnModelInputHandle` supplies. */
    readonly covers: readonly RunCommitId[];
}

/** One model exchange: the durable record its request was issued from, and the response. */
export interface TurnModelExchange {
    readonly input: RunCommitId;
    readonly output: ContentRef;
    readonly usage: TurnModelUsage;
}

export abstract class TurnModelHandle {
    public abstract call(assembly: TurnModelInputAssembly): Promise<TurnModelExchange>;
}

export abstract class TurnModelInputHandle {
    public abstract reconstruct(input: RunCommitId): Promise<TurnModelRequest>;
    /**
     * The transcript commits the next call's surface must account for, at the branch head
     * this Turn stands on now. A host that means to put less history in front of the model
     * appends a `rewrite` first and reads this again; there is no other conforming reduction.
     */
    public abstract accountable(): Promise<readonly RunCommitId[]>;
}

export abstract class TurnStreamHandle {
    public abstract publish(event: TurnStreamEvent): Promise<void>;
}

export abstract class TurnCommitHandle {
    public abstract append(commit: RunCommit): Promise<RunCommitId>;
}

export abstract class TurnCheckpointHandle {
    public abstract current(): Promise<RunCheckpoint | undefined>;
    public abstract persist(checkpoint: RunCheckpoint, commit: RunCommit): Promise<TurnOutcome>;
}

export abstract class TurnInvocationHandle {
    public abstract invoke(
        operation: TurnBoundOperation,
        requestKey: OperationRequestKey,
        input: FacetData
    ): Promise<TurnInvocationResult>;
}

export abstract class TurnInboxHandle {
    public abstract read(afterSequence: number): Promise<readonly TurnInboxEntry[]>;
}

export abstract class TurnOutcomeHandle {
    public abstract succeed(commit: RunCommit): Promise<TurnOutcome>;
    public abstract fail(commit: RunCommit): Promise<TurnOutcome>;
    public abstract cancel(commit: RunCommit, cancellation: TurnInboxEntry): Promise<TurnOutcome>;
    public abstract cancelled(): Promise<TurnOutcome>;
}

export interface TurnContext extends TurnExecutionScope {
    readonly operations: readonly TurnBoundOperation[];
    readonly prompt: ContentRef;
    readonly content: TurnContentHandle;
    readonly inbox: TurnInboxHandle;
    readonly commit: TurnCommitHandle;
    readonly checkpoint: TurnCheckpointHandle;
    readonly invocation: TurnInvocationHandle;
    readonly model: TurnModelHandle;
    readonly modelInput: TurnModelInputHandle;
    readonly stream: TurnStreamHandle;
    readonly outcome: TurnOutcomeHandle;
    readonly cancellation: AbortSignal;
}

export abstract class TurnExecutor {
    public abstract execute(turn: TurnContext): Promise<TurnOutcome>;
}

export interface TurnExecutorHostInit<Transaction> {
    readonly runtime: RunRuntime<Transaction>;
    readonly executor: TurnExecutor;
    readonly content: ContentStore;
    readonly operations: TurnOperationSource;
    readonly prompt: TurnPromptAssembler;
    readonly invocations: TurnInvocationPort;
    readonly model: TurnModelPort;
    readonly stream: TurnStreamPort;
    readonly now: () => Date;
}

export class TurnExecutorHost<Transaction> {
    public constructor(private readonly init: TurnExecutorHostInit<Transaction>) {}

    public async execute(token: LeaseToken): Promise<TurnOutcome> {
        const scope = new LeaseScopedTurn(this.init, token);
        const recovered = scope.recover();
        if (recovered !== undefined) return recovered;
        const initial = scope.active();
        const operations = await scope.resolveOperations(initial);
        const prompt = await scope.assemblePrompt({ ...initial.scope, operations });
        const replay = new TurnModelInputReplay({
            repository: this.init.runtime.repository,
            content: this.init.content
        });
        const context = Object.freeze<TurnContext>({
            ...initial.scope,
            operations,
            prompt,
            content: new ScopedContentHandle(scope),
            inbox: new ScopedInboxHandle(scope),
            commit: new ScopedCommitHandle(scope),
            checkpoint: new ScopedCheckpointHandle(scope),
            invocation: new ScopedInvocationHandle(scope, operations),
            model: new ScopedModelHandle(scope, operations, replay),
            modelInput: new ScopedModelInputHandle(scope, replay),
            stream: new ScopedStreamHandle(scope),
            outcome: new ScopedOutcomeHandle(scope),
            cancellation: scope.signal
        });
        let proposed: TurnOutcome;
        try {
            proposed = await this.init.executor.execute(context);
        } catch (error) {
            const committed = scope.recover();
            if (committed !== undefined) return committed;
            throw error;
        }
        const committed = scope.recover();
        if (committed === undefined || !outcomesEqual(proposed, committed)) {
            throw invalidTurn("Turn executor returned without its exact canonical transition");
        }
        return committed;
    }
}

interface ActiveTurnSnapshot {
    readonly scope: TurnExecutionScope;
    readonly branch: RunBranch;
    readonly head: RunCommit;
    readonly now: Date;
}

class LeaseScopedTurn<Transaction> {
    readonly #controller = new AbortController();
    public readonly signal = this.#controller.signal;

    public constructor(
        public readonly init: TurnExecutorHostInit<Transaction>,
        public readonly token: LeaseToken
    ) {}

    public active(): ActiveTurnSnapshot {
        const now = this.init.now();
        return this.init.runtime.repository.transaction((transaction) => {
            const repository = this.init.runtime.repository;
            const turn = required(
                repository.loadTurn(transaction, this.token.turn),
                "Turn executor target does not exist"
            );
            if (findCancellation(repository.listInbox(transaction, turn.id), this.token)) {
                this.#controller.abort();
            }
            const joined = repository.loadExecutionScope(transaction, this.token, now);
            return Object.freeze({
                scope: Object.freeze({
                    turn: joined.turn,
                    token: this.token,
                    effectiveCommit: joined.effectiveCommit,
                    placement: joined.placement,
                    resumeCheckpoint: joined.checkpoint
                }),
                branch: joined.branch,
                head: joined.head,
                now
            });
        });
    }

    public async resolveOperations(
        snapshot: ActiveTurnSnapshot
    ): Promise<readonly TurnBoundOperation[]> {
        const resolved = await this.init.operations.resolve(snapshot.scope);
        this.active();
        return validateOperations(snapshot.scope.placement, resolved);
    }

    public async assemblePrompt(request: TurnPromptAssembly): Promise<ContentRef> {
        const prompt = await this.init.prompt.assemble(Object.freeze(request));
        this.active();
        await this.requireContent(prompt);
        return prompt;
    }

    public async requireContent(ref: ContentRef): Promise<void> {
        const stat = await this.withActive(() => this.init.runtime.repository.content.stat(ref));
        if (stat === undefined || !stat.ref.equals(ref) || !stat.digest.equals(ref.digest)) {
            throw new AgentCoreError("content.not-found", "Turn content is not available");
        }
    }

    /**
     * The dispatch waits on this commit (SPEC §5.6). A commit the Turn's lease rejects, a
     * store that is unavailable, and a commit whose outcome the substrate cannot report
     * all refuse dispatch: the record's identity is derived from its content and its
     * parent, so an unknown outcome is settled by re-reading that exact commit rather than
     * by assuming either branch, and a further attempt at the same commit can still reach
     * durability. A durability failure is never grounds to proceed.
     */
    public commitModelInput(commit: RunCommit): void {
        const snapshot = this.active();
        let failure: Error | undefined;
        try {
            this.init.runtime.appendTurnCommit(commit, snapshot.branch.revision, snapshot.now);
        } catch (error) {
            failure = error instanceof Error ? error : new TypeError(String(error));
        }
        if (!this.durablyStored(commit)) {
            throw new AgentCoreError(
                "turn.model-input-undurable",
                `The model call is refused because its request is not durably recorded${
                    failure === undefined ? "" : `: ${failure.message}`
                }`
            );
        }
    }

    private durablyStored(commit: RunCommit): boolean {
        try {
            const stored = this.init.runtime.repository.transaction((transaction) =>
                this.init.runtime.repository.loadCommit(transaction, commit.id)
            );
            return stored?.proposalDigest.equals(commit.proposalDigest) === true;
        } catch {
            // A store that cannot answer whether the record landed has not established
            // durability, which is the same refusal as one that rejected the append.
            return false;
        }
    }

    public async withActive<Result>(operation: () => Promise<Result>): Promise<Result> {
        this.active();
        try {
            return await operation();
        } finally {
            this.active();
        }
    }

    public recover(): TurnOutcome | undefined {
        return this.init.runtime.repository.transaction((transaction) => {
            const repository = this.init.runtime.repository;
            const turn = repository.loadTurn(transaction, this.token.turn);
            if (turn === undefined) return undefined;
            const resultCommits = repository
                .listCommits(transaction)
                .filter(
                    (commit) =>
                        commit.isTurnAuthored("result", this.token) &&
                        commit.content !== undefined &&
                        turn.result?.equals(commit.content) === true
                );
            if (resultCommits.length > 1) {
                throw invalidTurn("Turn executor has multiple terminal commits for one token");
            }
            const resultCommit = resultCommits[0];
            if (turn.status.kind === "succeeded" || turn.status.kind === "failed") {
                if (resultCommit === undefined) return undefined;
                return Object.freeze({
                    kind: turn.status.kind,
                    result: required(turn.result, "Terminal Turn is missing its result"),
                    commit: resultCommit.id
                });
            }
            if (turn.status.kind === "suspended") {
                const checkpoint = required(
                    repository.loadCheckpoint(
                        transaction,
                        required(turn.checkpoint, "Suspended Turn is missing its checkpoint")
                    ),
                    "Suspended Turn checkpoint does not exist"
                );
                const commit = required(
                    repository.loadCommit(transaction, checkpoint.commit),
                    "Suspended Turn checkpoint commit does not exist"
                );
                if (
                    !commit.isTurnAuthored("checkpoint", this.token) ||
                    !commit.content?.equals(checkpoint.state)
                ) {
                    return undefined;
                }
                return Object.freeze({ kind: "suspended", checkpoint, commit: commit.id });
            }
            if (findCancellation(repository.listInbox(transaction, turn.id), this.token)) {
                this.#controller.abort();
                // A cancellation delivered against a lease this token still holds is a
                // request the holder must settle itself (§5.6); only a displaced or
                // fenced lease makes the cancellation the Turn's recorded outcome.
                if (holdsCurrentLease(turn, this.token)) return undefined;
                let cancelled: TurnOutcome = { kind: "cancelled" };
                if (resultCommit?.content !== undefined) {
                    cancelled = { ...cancelled, result: resultCommit.content };
                }
                if (resultCommit !== undefined) {
                    cancelled = { ...cancelled, commit: resultCommit.id };
                }
                return Object.freeze(cancelled);
            }
            return undefined;
        });
    }

    public readInbox(afterSequence: number): readonly TurnInboxEntry[] {
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
            throw new TypeError("Turn inbox cursor must be a non-negative safe integer");
        }
        return this.init.runtime.repository.transaction((transaction) => {
            const repository = this.init.runtime.repository;
            const turn = required(
                repository.loadTurn(transaction, this.token.turn),
                "Turn executor target does not exist"
            );
            const entries = repository
                .listInbox(transaction, turn.id)
                .filter((entry) => entry.sequence >= afterSequence);
            const cancellation = findCancellation(entries, this.token);
            if (cancellation !== undefined) {
                this.#controller.abort();
                return Object.freeze(entries);
            }
            turn.requireToken(this.token, this.init.now());
            return Object.freeze(entries);
        });
    }
}

class ScopedContentHandle<Transaction> extends TurnContentHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async put(bytes: Uint8Array, hint?: MediaHint): Promise<ContentPutResult> {
        const stored = await this.scope.withActive(() =>
            this.scope.init.runtime.repository.content.put(bytes.slice(), hint)
        );
        if (!stored.ref.digest.equals(stored.digest)) {
            throw new AgentCoreError("codec.invalid", "Content store returned mismatched identity");
        }
        return Object.freeze({ ref: stored.ref, digest: stored.digest });
    }

    public async get(ref: ContentRef): Promise<Uint8Array> {
        const bytes = await this.scope.withActive(() =>
            this.scope.init.runtime.repository.content.get(ref)
        );
        return bytes.slice();
    }

    public async stat(ref: ContentRef): Promise<ContentStat | undefined> {
        return this.scope.withActive(() => this.scope.init.runtime.repository.content.stat(ref));
    }
}

class ScopedModelHandle<Transaction> extends TurnModelHandle {
    public constructor(
        private readonly scope: LeaseScopedTurn<Transaction>,
        private readonly operations: readonly TurnBoundOperation[],
        private readonly replay: TurnModelInputReplay<Transaction>
    ) {
        super();
    }

    /**
     * Records the model input, then issues the reconstruction of what it recorded. Nothing
     * the model observes is assembled a second time here, so a request and its record
     * cannot drift (SPEC §5.6), and the record is durable before the request is dispatched.
     */
    public async call(assembly: TurnModelInputAssembly): Promise<TurnModelExchange> {
        const snapshot = this.scope.active();
        const record = this.record(assembly);
        for (const section of record.sections) {
            const ref = section.shown.ref;
            if (ref !== undefined) await this.scope.requireContent(ref);
        }
        for (const admitted of record.admitted) await this.scope.requireContent(admitted.content);
        const document = await this.scope.withActive(() =>
            this.scope.init.content.put(TurnModelInput.encode(record))
        );
        const commit = new RunCommit({
            id: modelInputCommitId(snapshot.head.id, document.ref),
            run: snapshot.scope.turn.run,
            branch: snapshot.scope.turn.branch,
            kind: "modelInput",
            parents: [snapshot.head.id],
            pins: snapshot.scope.turn.pins,
            writer: { kind: "turn", token: this.scope.token },
            subjectTurn: snapshot.scope.turn.id,
            content: document.ref
        });
        // Before the claim becomes an undeletable record: a coverage claim the branch
        // contradicts is not a failure worth keeping, it is a false statement in an
        // append-only log, so it is refused where it is still only a proposal.
        this.replay.requireAccounted(commit.id, snapshot.head.id, record);
        this.scope.commitModelInput(commit);
        const request = await this.scope.withActive(() => this.replay.reconstruct(commit.id));
        const result = await this.scope.withActive(() =>
            this.scope.init.model.call(
                Object.freeze({
                    ...request,
                    turn: snapshot.scope.turn,
                    token: this.scope.token,
                    signal: this.scope.signal
                })
            )
        );
        requireUsage(result.usage);
        await this.scope.requireContent(result.output);
        // SPEC §5.2: the Run's token total advances where the model call commits.
        this.scope.init.runtime.recordModelTokens(
            snapshot.scope.turn.run,
            totalTokens(result.usage)
        );
        return Object.freeze({
            input: commit.id,
            output: result.output,
            usage: freezeUsage(result.usage)
        });
    }

    /**
     * The record an assembly names, with every claim checked against the Turn's own state: an
     * offered Operation is one the placement snapshot already resolved, and an admitted
     * Event is one this Turn's inbox carries at that exact sequence and payload. The
     * admission cut is the inbox length the host observed, not one the assembly supplies.
     */
    private record(assembly: TurnModelInputAssembly): TurnModelInput {
        const inbox = this.scope.readInbox(0);
        for (const offered of assembly.catalog) {
            if (!this.operations.includes(offered)) {
                throw new AgentCoreError(
                    "operation.missing",
                    "A model input offers an Operation outside the Turn's resolved catalog"
                );
            }
        }
        const admitted = assembly.admitted.map((entry) => {
            const stored = inbox.find((candidate) => candidate.id.equals(entry.id));
            if (
                stored === undefined ||
                stored.sequence !== entry.sequence ||
                stored.event !== entry.event ||
                !stored.payload.equals(entry.payload)
            ) {
                throw invalidTurn("A model input admits an Event this Turn's inbox does not carry");
            }
            return new TurnAdmittedEvent(stored.id, stored.sequence, stored.event, stored.payload);
        });
        return new TurnModelInput({
            sections: assembly.sections,
            catalog: assembly.catalog,
            admitted,
            admissionCut: inbox.length,
            covers: assembly.covers
        });
    }
}

class ScopedModelInputHandle<Transaction> extends TurnModelInputHandle {
    public constructor(
        private readonly scope: LeaseScopedTurn<Transaction>,
        private readonly replay: TurnModelInputReplay<Transaction>
    ) {
        super();
    }

    public async reconstruct(input: RunCommitId): Promise<TurnModelRequest> {
        return this.scope.withActive(() => this.replay.reconstruct(input));
    }

    public async accountable(): Promise<readonly RunCommitId[]> {
        return this.scope.withActive(async () => this.replay.accountable(this.scope.active().head.id));
    }
}

class ScopedStreamHandle<Transaction> extends TurnStreamHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async publish(event: TurnStreamEvent): Promise<void> {
        const canonical = canonicalStreamEvent(event);
        const turn = this.scope.active().scope.turn;
        await this.scope.withActive(() =>
            this.scope.init.stream.publish(
                Object.freeze({ turn, token: this.scope.token, event: canonical })
            )
        );
    }
}

class ScopedInvocationHandle<Transaction> extends TurnInvocationHandle {
    public constructor(
        private readonly scope: LeaseScopedTurn<Transaction>,
        private readonly operations: readonly TurnBoundOperation[]
    ) {
        super();
    }

    public async invoke(
        requested: TurnBoundOperation,
        requestKey: OperationRequestKey,
        input: FacetData
    ): Promise<TurnInvocationResult> {
        if (!this.operations.includes(requested)) {
            throw new AgentCoreError(
                "operation.missing",
                "Turn invocation requires one exact bound Operation"
            );
        }
        const turn = this.scope.active().scope.turn;
        const result = await this.scope.withActive(() =>
            this.scope.init.invocations.invoke(
                Object.freeze({
                    turn,
                    token: this.scope.token,
                    operation: requested,
                    requestKey,
                    input: canonicalFacetData(input),
                    signal: this.scope.signal
                })
            )
        );
        return canonicalInvocationResult(result);
    }
}

class ScopedCommitHandle<Transaction> extends TurnCommitHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async append(commit: RunCommit): Promise<RunCommitId> {
        if (commit.kind !== "message" && commit.kind !== "verdict") {
            throw invalidTurn("Turn commit handle appends only message or verdict commits");
        }
        await this.scope.requireContent(required(commit.content, "Turn commit requires content"));
        const snapshot = this.scope.active();
        this.scope.init.runtime.appendTurnCommit(commit, snapshot.branch.revision, snapshot.now);
        this.scope.active();
        return commit.id;
    }
}

class ScopedCheckpointHandle<Transaction> extends TurnCheckpointHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async current(): Promise<RunCheckpoint | undefined> {
        return this.scope.active().scope.resumeCheckpoint;
    }

    public async persist(checkpoint: RunCheckpoint, commit: RunCommit): Promise<TurnOutcome> {
        await this.scope.requireContent(checkpoint.state);
        if (checkpoint.tree !== undefined) await this.scope.requireContent(checkpoint.tree);
        const snapshot = this.scope.active();
        this.scope.init.runtime.suspendTurn({
            turn: snapshot.scope.turn.id,
            expectedTurnRevision: snapshot.scope.turn.revision,
            expectedBranchRevision: snapshot.branch.revision,
            token: this.scope.token,
            checkpoint,
            commit,
            now: snapshot.now
        });
        return canonicalOutcome(this.scope);
    }
}

class ScopedInboxHandle<Transaction> extends TurnInboxHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async read(afterSequence: number): Promise<readonly TurnInboxEntry[]> {
        return this.scope.readInbox(afterSequence);
    }
}

class ScopedOutcomeHandle<Transaction> extends TurnOutcomeHandle {
    public constructor(private readonly scope: LeaseScopedTurn<Transaction>) {
        super();
    }

    public async succeed(commit: RunCommit): Promise<TurnOutcome> {
        return this.complete("succeeded", commit);
    }

    public async fail(commit: RunCommit): Promise<TurnOutcome> {
        return this.complete("failed", commit);
    }

    public async cancel(commit: RunCommit, cancellation: TurnInboxEntry): Promise<TurnOutcome> {
        await this.scope.requireContent(required(commit.content, "Turn result requires content"));
        await this.scope.requireContent(cancellation.payload);
        const snapshot = this.scope.active();
        this.scope.init.runtime.cancelHeldTurn(
            {
                turn: snapshot.scope.turn.id,
                expectedTurnRevision: snapshot.scope.turn.revision,
                expectedBranchRevision: snapshot.branch.revision,
                token: this.scope.token,
                outcome: "cancelled",
                commit,
                now: snapshot.now
            },
            cancellation
        );
        return canonicalOutcome(this.scope);
    }

    public async cancelled(): Promise<TurnOutcome> {
        const outcome = this.scope.recover();
        if (outcome?.kind !== "cancelled") {
            throw invalidTurn("Turn token has no settled cancellation outcome");
        }
        return outcome;
    }

    private async complete(
        outcome: "succeeded" | "failed",
        commit: RunCommit
    ): Promise<TurnOutcome> {
        await this.scope.requireContent(required(commit.content, "Turn result requires content"));
        const snapshot = this.scope.active();
        this.scope.init.runtime.completeTurn({
            turn: snapshot.scope.turn.id,
            expectedTurnRevision: snapshot.scope.turn.revision,
            expectedBranchRevision: snapshot.branch.revision,
            token: this.scope.token,
            outcome,
            commit,
            now: snapshot.now
        });
        return canonicalOutcome(this.scope);
    }
}

function validateOperations(
    placement: TurnPlacementSnapshot,
    operations: readonly TurnBoundOperation[]
): readonly TurnBoundOperation[] {
    const bindings = new Set<string>();
    const canonical = operations.map((operation) => {
        if (!(operation instanceof TurnBoundOperation)) {
            throw new TypeError("Turn Operations must use the canonical bound Operation contract");
        }
        if (bindings.has(operation.binding.value)) {
            throw new TypeError("Turn Operation bindings must be unique");
        }
        if (!placement.placements.some((pin) => pin.facet.equals(operation.facet))) {
            throw invalidTurn("Turn Operation is absent from the immutable placement snapshot");
        }
        bindings.add(operation.binding.value);
        return operation;
    });
    return Object.freeze(canonical);
}

/**
 * The offered catalog, checked for the one property a record must carry independently of
 * the Turn it came from: a binding names at most one Operation, so a reconstruction cannot
 * offer the model two meanings for one name.
 */
function validateOfferedCatalog(
    catalog: readonly TurnBoundOperation[]
): readonly TurnBoundOperation[] {
    const bindings = new Set<string>();
    for (const operation of catalog) {
        if (!(operation instanceof TurnBoundOperation)) {
            throw new TypeError("An offered catalog holds canonical bound Operations");
        }
        if (bindings.has(operation.binding.value)) {
            throw new TypeError("An offered catalog binds each name once");
        }
        bindings.add(operation.binding.value);
    }
    return [...catalog];
}

function boundOperationData(operation: TurnBoundOperation): JsonValue {
    return {
        binding: operation.binding.value,
        descriptor: operation.descriptor.toData(),
        facet: operation.facet.value,
        operation: operation.operation.value
    };
}

function boundOperationFromData(value: JsonValue): TurnBoundOperation {
    const object = requireObject(value, "Offered Operation");
    requireExactFields(
        object,
        ["binding", "descriptor", "facet", "operation"],
        [],
        "Offered Operation"
    );
    return new TurnBoundOperation(
        new BindingName(requireString(object["binding"], "Offered Operation binding")),
        new FacetRef(requireString(object["facet"], "Offered Operation Facet")),
        new OperationRef(requireString(object["operation"], "Offered Operation reference")),
        OperationDescriptor.fromData(requireShown(object["descriptor"]))
    );
}

/**
 * A model input commit's identity, derived from the record it names and the commit it
 * descends from. Deriving rather than minting is what makes a second attempt at a commit
 * whose outcome was unknown the same commit rather than a second one.
 */
function modelInputCommitId(parent: RunCommitId, document: ContentRef): RunCommitId {
    const digest = Digest.sha256(
        encodeCanonicalJson({ document: document.value, parent: parent.value })
    );
    return new RunCommitId(`model-input:${digest.value}`);
}

/** A field the exact-shape assertion has already proven present. */
function requireShown(value: JsonValue | undefined): JsonValue {
    if (value === undefined) throw new TypeError("A shape-checked record field is missing");
    return value;
}

function unrebuildable(missing: string): AgentCoreError {
    return new AgentCoreError(
        "run.model-input-unrebuildable",
        `A committed model call request cannot be rebuilt: ${missing}`
    );
}

function unaccounted(input: RunCommitId, discrepancy: string): AgentCoreError {
    return new AgentCoreError(
        "turn.model-input-unaccounted",
        `Model input ${input.value} does not account for its base transcript: ${discrepancy}`
    );
}

/**
 * The commits of a transcript a surface can carry. A commit naming no content shows the
 * model nothing of its own — an `invocation`, an `eventDelivery`, an `undo`, a `migration`
 * and an abandoned `rewrite` are graph facts whose model-visible material lives in the
 * `message` and `result` commits they pair with, which SPEC §5.2 keeps in the graph through
 * `requests` and `invocation` so no cut can strand one. A `modelInput` commit's content is a
 * surface record — this rule's own subject — and never history a later call reads.
 */
function accountableTranscript(transcript: readonly RunCommit[]): readonly RunCommit[] {
    return transcript.filter(
        (commit) => commit.content !== undefined && commit.kind !== "modelInput"
    );
}

function canonicalInvocationResult(result: TurnInvocationResult): TurnInvocationResult {
    return result.tier === "mediated"
        ? Object.freeze({
              tier: "mediated",
              output: canonicalFacetData(result.output),
              evidence: canonicalFacetData(result.evidence),
              admission: result.admission
          })
        : Object.freeze({ tier: "direct", output: canonicalFacetData(result.output) });
}

/**
 * The Invocation and item Receipts a mediated dispatch's evidence names (§7.4). A handle is
 * built from the records these identify, so the seam reads the identity out of the evidence
 * rather than being told it.
 */
function admittedIdentity(evidence: FacetData): {
    readonly invocation: InvocationId;
    readonly receipts: readonly ReceiptId[];
} {
    const object = requireObject(evidence, "Mediated admission evidence");
    return Object.freeze({
        invocation: new InvocationId(
            requireString(object["invocation"], "Mediated admission Invocation")
        ),
        receipts: Object.freeze(
            requireArray(object["receipts"], "Mediated admission Receipts").map(
                (value) => new ReceiptId(requireString(value, "Mediated admission Receipt"))
            )
        )
    });
}

function canonicalStreamEvent(event: TurnStreamEvent): TurnStreamEvent {
    if (event.kind === "content") {
        return Object.freeze({ kind: "content", bytes: event.bytes.slice() });
    }
    requireUsage(event.usage);
    return Object.freeze({ kind: "usage", usage: freezeUsage(event.usage) });
}

function requireUsage(usage: TurnModelUsage): void {
    for (const value of [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens
    ]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
            throw new TypeError("Turn model usage values must be non-negative safe integers");
        }
    }
}

function totalTokens(usage: TurnModelUsage): number {
    return (
        usage.inputTokens +
        usage.outputTokens +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0)
    );
}

function freezeUsage(usage: TurnModelUsage): TurnModelUsage {
    let frozen: TurnModelUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens
    };
    if (usage.cacheReadTokens !== undefined) {
        frozen = { ...frozen, cacheReadTokens: usage.cacheReadTokens };
    }
    if (usage.cacheWriteTokens !== undefined) {
        frozen = { ...frozen, cacheWriteTokens: usage.cacheWriteTokens };
    }
    return Object.freeze(frozen);
}

function findCancellation(
    entries: readonly TurnInboxEntry[],
    token: LeaseToken
): TurnInboxEntry | undefined {
    // Carrying a cancellation token and being a turn.cancel entry are the same fact:
    // TurnInboxEntry's constructor rejects either without the other, and its codec
    // decodes through that constructor, so a matched entry cannot have another event.
    // Only duplication is left to reject.
    const matches = entries.filter(
        (entry) =>
            entry.cancellationToken !== undefined &&
            leaseTokensEqual(entry.cancellationToken, token)
    );
    if (matches.length > 1) {
        throw invalidTurn("Turn executor cancellation evidence is not canonical");
    }
    return matches[0];
}

function holdsCurrentLease(turn: Turn, token: LeaseToken): boolean {
    return (
        turn.status.kind === "running" &&
        turn.lease.holder !== undefined &&
        leaseTokensEqual(
            { turn: turn.id, holder: turn.lease.holder, epoch: turn.lease.epoch },
            token
        )
    );
}

function outcomesEqual(left: TurnOutcome, right: TurnOutcome): boolean {
    return bytesEqual(
        encodeCanonicalJson(outcomeIdentity(left)),
        encodeCanonicalJson(outcomeIdentity(right))
    );
}

function outcomeIdentity(outcome: TurnOutcome): JsonValue {
    switch (outcome.kind) {
        case "suspended":
            return [
                outcome.kind,
                encodeBase64(RunCheckpoint.codec.encode(outcome.checkpoint)),
                outcome.commit.value
            ];
        case "cancelled":
            return [outcome.kind, outcome.result?.value ?? null, outcome.commit?.value ?? null];
        default:
            return [outcome.kind, outcome.result.value, outcome.commit.value];
    }
}

function required<Value>(value: Value | undefined, message: string): Value {
    if (value === undefined) throw invalidTurn(message);
    return value;
}

function canonicalOutcome<Transaction>(scope: LeaseScopedTurn<Transaction>): TurnOutcome {
    return required(scope.recover(), "Turn transition was not durably recorded");
}

function invalidTurn(message: string): AgentCoreError {
    return new AgentCoreError("turn.invalid-state", message);
}

function requireNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new AgentCoreError("lease.invalid", "Turn execution is cancelled");
    }
}
