import type { ContentStore } from "../../content";
import {
    ContentRef,
    Digest,
    RecordCodec,
    Revision,
    TextId,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonValue
} from "../../core";
import { AgentCoreError } from "../../errors";
import { RunCommitId, TurnId } from "../../execution-references";
import { canonicalFacetData, type FacetData, type Impact } from "../../facets";
import { InvocationId } from "../../interaction-references";
import { EffectAttemptId, ReceiptId } from "../../invocation-references";
import type { AdmittedInvocationItem } from "../../invocations";
import {
    CodecRecord,
    bytesEqual,
    digestFromData,
    requireExactFields,
    requireInteger,
    requireObject,
    requireString
} from "../record-data";
import type { RunAdmissionReservation, RunObligation } from "./admission";
import { RunId, TurnInboxEntryId } from "./id";
import { RunInvocationDelivery, RunInvocationDeliveryCause } from "./invocation-delivery";
import type { LeaseToken } from "./lease";
import type { RunRuntime } from "./runtime";
import { TurnInboxEntry } from "./turn";

/**
 * What a handle puts in the model's tool position (SPEC §5.6): a mediated Invocation's own
 * admission identity, or the child RunRef a `delegate` spawn's Receipt carries. The two are
 * different owners rather than two spellings of one, because an Invocation identity leaves
 * the item owned by the issuing Run while a child RunRef names a settlement unit of its
 * own, so each renders its own tool position and its own address instead of a reader
 * branching on a kind field it has to remember the meaning of.
 */
export abstract class TurnAdmissionIdentity {
    public static invocation(invocation: InvocationId): TurnAdmissionIdentity {
        return new InvocationAdmissionIdentity(invocation);
    }

    /**
     * The child a `delegate` spawn's Receipt names, with that Receipt and the digest of its
     * result. A child RunRef cannot exist before the Receipt carries it, so the evidence that
     * proves it belongs to this case alone: an Invocation identity commits at admission, where
     * no Receipt exists, and a handle carrying both would have to leave one of them empty.
     */
    public static childRun(run: RunId, receipt: ReceiptId, result: Digest): TurnAdmissionIdentity {
        return new ChildRunAdmissionIdentity(run, receipt, result);
    }

    public abstract readonly kind: "invocation" | "childRun";

    /** The child Run this identity names; an Invocation identity names none. */
    public abstract readonly childRun: RunId | undefined;

    /**
     * The Run whose cancellation is cancellation of this item's owner (SPEC §5.6). The
     * caller supplies the Run the issuing Turn belongs to. An Invocation identity detaches
     * the item from the Turn and not from the Run, so the issuing Run answers for it. A
     * child RunRef detaches it from that Run as well, so the child Run answers for itself.
     */
    public abstract owner(issuingRun: RunId): RunId;

    /** The exact canonical value the model reads in the tool position. */
    public abstract toolPosition(): FacetData;

    /** The stable string an at-least-once delivery keys its idempotency on. */
    public abstract get address(): string;

    public abstract equals(other: TurnAdmissionIdentity): boolean;

    public abstract toData(): JsonValue;

    /**
     * Decodes exactly the fields the named case carries. One shared field list would admit an
     * Invocation identity holding a spawn Receipt, which is the pairing these two cases exist
     * to leave unconstructable.
     */
    public static fromData(value: JsonValue): TurnAdmissionIdentity {
        const object = requireObject(value, "Turn admission identity");
        const kind = requireString(object["kind"], "Turn admission identity kind");
        if (kind === "invocation") {
            requireExactFields(object, ["kind", "reference"], [], "Turn admission Invocation");
            return TurnAdmissionIdentity.invocation(
                new InvocationId(requireString(object["reference"], "Turn admission Invocation"))
            );
        }
        if (kind === "childRun") {
            requireExactFields(
                object,
                ["kind", "receipt", "reference", "result"],
                [],
                "Turn admission child Run"
            );
            return TurnAdmissionIdentity.childRun(
                new RunId(requireString(object["reference"], "Turn admission child Run")),
                new ReceiptId(requireString(object["receipt"], "Turn admission spawn Receipt")),
                digestFromData(object["result"], "Turn admission spawn result")
            );
        }
        throw new TypeError("Turn admission identity kind is invalid");
    }
}

class InvocationAdmissionIdentity extends TurnAdmissionIdentity {
    public readonly kind = "invocation" as const;
    public readonly childRun = undefined;

    public constructor(public readonly invocation: InvocationId) {
        super();
        Object.freeze(this);
    }

    public owner(issuingRun: RunId): RunId {
        return issuingRun;
    }

    public toolPosition(): FacetData {
        return canonicalFacetData({ invocation: this.invocation.value });
    }

    public get address(): string {
        return `invocation:${this.invocation.value}`;
    }

    public equals(other: TurnAdmissionIdentity): boolean {
        return (
            other instanceof InvocationAdmissionIdentity && other.invocation.equals(this.invocation)
        );
    }

    public toData(): JsonValue {
        return { kind: this.kind, reference: this.invocation.value };
    }
}

class ChildRunAdmissionIdentity extends TurnAdmissionIdentity {
    public readonly kind = "childRun" as const;

    public constructor(
        public readonly childRun: RunId,
        public readonly receipt: ReceiptId,
        public readonly result: Digest
    ) {
        super();
        if (receipt.constructor !== ReceiptId || result.constructor !== Digest) {
            throw new TypeError("Turn admission child Run names its exact spawn evidence");
        }
        Object.freeze(this);
    }

    public owner(): RunId {
        return this.childRun;
    }

    public toolPosition(): FacetData {
        return canonicalFacetData({ run: this.childRun.value });
    }

    public get address(): string {
        return `run:${this.childRun.value}`;
    }

    public equals(other: TurnAdmissionIdentity): boolean {
        return (
            other instanceof ChildRunAdmissionIdentity &&
            other.childRun.equals(this.childRun) &&
            other.receipt.equals(this.receipt) &&
            other.result.equals(this.result)
        );
    }

    public toData(): JsonValue {
        return {
            kind: this.kind,
            receipt: this.receipt.value,
            reference: this.childRun.value,
            result: this.result.value
        };
    }
}

export interface TurnAdmissionHandleInit {
    readonly run: RunId;
    readonly turn: TurnId;
    readonly issuedEpoch: number;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
    readonly identity: TurnAdmissionIdentity;
}

/**
 * A durable, addressable reference to an admitted mediated item (SPEC §5.6). It is a value
 * rather than a stored record on purpose: everything it names — the Invocation, the
 * EffectAttempt, the child RunRef — is already owned durably elsewhere, so a table of handles
 * would be a second copy of state with its own way of going stale. Its canonical bytes are
 * what survive a process, and re-verifying those bytes against the same §7.4 records is what
 * makes a decoded handle address exactly the work the original named. It carries no time of
 * its own for the same reason: the EffectAttempt it names already records when the item was
 * admitted.
 *
 * It names the four facts of the admitted item and no outcome. Admission is the commit point
 * an Invocation identity has (§5.6), and admission leaves an EffectAttempt that no Receipt
 * names yet, so a Receipt on this record would be a field one whole case could never fill.
 * The one identity whose commit point is a Receipt carries that Receipt itself.
 *
 * The recorded `issuedEpoch` is provenance and never authority. A handle authorizes
 * addressing its Turn; writing as that Turn needs the exact current lease (§5.3), which the
 * caller presents separately and which this record cannot substitute for.
 */
export class TurnAdmissionHandle extends CodecRecord {
    public static get codec(): RecordCodec<TurnAdmissionHandle> {
        return TurnAdmissionHandleCodec;
    }

    public readonly run: RunId;
    public readonly turn: TurnId;
    public readonly issuedEpoch: number;
    public readonly invocation: InvocationId;
    public readonly itemIndex: number;
    public readonly itemKey: string;
    public readonly attempt: EffectAttemptId;
    public readonly identity: TurnAdmissionIdentity;

    public constructor(init: TurnAdmissionHandleInit) {
        super();
        if (!Number.isSafeInteger(init.issuedEpoch) || init.issuedEpoch < 0) {
            throw new TypeError("Turn admission handle epoch is invalid");
        }
        if (!Number.isSafeInteger(init.itemIndex) || init.itemIndex < 0) {
            throw new TypeError("Turn admission handle item index is invalid");
        }
        if (init.itemKey.length === 0) {
            throw new TypeError("Turn admission handle requires an item key");
        }
        if (init.identity.childRun?.equals(init.run) === true) {
            throw new TypeError("Turn admission handle child Run must be distinct");
        }
        this.run = init.run;
        this.turn = init.turn;
        this.issuedEpoch = init.issuedEpoch;
        this.invocation = init.invocation;
        this.itemIndex = init.itemIndex;
        this.itemKey = init.itemKey;
        this.attempt = init.attempt;
        this.identity = init.identity;
        Object.freeze(this);
    }

    /** The exact canonical value the model reads in the tool position (SPEC §5.6). */
    public toolPosition(): FacetData {
        return this.identity.toolPosition();
    }

    /** The stable string a later delivery addresses this admission by. */
    public get address(): string {
        return this.identity.address;
    }

    /**
     * The Run that governs this published item's cancellation (SPEC §5.6). §7.4 assigns
     * `aborted` to cancellation of the Turn or Run that owns an item, and leaves which of
     * the two open. Publication closes that disjunction. It closes it on a Run in both
     * cases: the issuing Run for an Invocation identity, and the child Run for a RunRef. A
     * published item therefore keeps no Turn owner for a Turn's cancellation to be.
     */
    public get owner(): RunId {
        return this.identity.owner(this.run);
    }

    /**
     * The durable message this published item's Invocation owner is owed when `scope`
     * cancels (SPEC §5.6). It answers nothing where `scope` does not own the item, which is
     * the issuing Turn's case: RunId and TurnId are different classes, so a cancelled Turn
     * never equals the owner and the prohibition holds by identity rather than by a branch
     * a host can forget.
     *
     * The message is a request and never a verdict. §7.4 builds `aborted` only from
     * cancellation that reached the attempt, and the Run observes its own end rather than
     * the target's live controller, so what travels here is the exact item and attempt the
     * Run stopped owning. The Invocation owner aborts its own controller and classifies the
     * attempt from what it observes, including observing that nothing is left to abort.
     */
    public cancellationDelivery(
        scope: RunId | TurnId,
        terminalCommit: RunCommitId
    ): RunInvocationDelivery | undefined {
        const owner = this.owner;
        if (!owner.equals(scope)) return undefined;
        return new RunInvocationDelivery({
            run: owner,
            invocation: this.invocation,
            itemIndex: this.itemIndex,
            itemKey: this.itemKey,
            attempt: this.attempt,
            cause: RunInvocationDeliveryCause.cancellation(terminalCommit)
        });
    }

    /**
     * The durable message its Invocation owner is owed once publication has detached the
     * item into this Run (SPEC §5.6). An item detached to a child Run is that Run's own
     * settlement unit, so this Run owes its owner nothing and answers nothing.
     */
    public admissionDelivery(): RunInvocationDelivery | undefined {
        if (this.identity.kind !== "invocation") return undefined;
        return new RunInvocationDelivery({
            run: this.run,
            invocation: this.invocation,
            itemIndex: this.itemIndex,
            itemKey: this.itemKey,
            attempt: this.attempt,
            cause: RunInvocationDeliveryCause.admission
        });
    }

    /**
     * The Run obligation publishing this handle detaches the item into (SPEC §5.2, §5.6).
     * Terminalization captures whatever is still reserved, so an outstanding handle withholds
     * Settled without holding any Turn.
     */
    public obligation(): RunObligation {
        return Object.freeze({
            kind: "invocationItem" as const,
            invocation: this.invocation,
            itemIndex: this.itemIndex,
            itemKey: this.itemKey
        });
    }

    public equals(other: TurnAdmissionHandle): boolean {
        return bytesEqual(
            TurnAdmissionHandleCodec.encode(this),
            TurnAdmissionHandleCodec.encode(other)
        );
    }

    public toData(): JsonValue {
        return {
            attempt: this.attempt.value,
            identity: this.identity.toData(),
            invocation: this.invocation.value,
            issuedEpoch: this.issuedEpoch,
            itemIndex: this.itemIndex,
            itemKey: this.itemKey,
            run: this.run.value,
            turn: this.turn.value
        };
    }

    public static fromData(value: JsonValue): TurnAdmissionHandle {
        const object = requireObject(value, "Turn admission handle");
        requireExactFields(
            object,
            [
                "attempt",
                "identity",
                "invocation",
                "issuedEpoch",
                "itemIndex",
                "itemKey",
                "run",
                "turn"
            ],
            [],
            "Turn admission handle"
        );
        return new TurnAdmissionHandle({
            run: new RunId(requireString(object["run"], "Turn admission handle Run")),
            turn: new TurnId(requireString(object["turn"], "Turn admission handle Turn")),
            issuedEpoch: requireInteger(object["issuedEpoch"], "Turn admission handle epoch"),
            invocation: new InvocationId(
                requireString(object["invocation"], "Turn admission handle Invocation")
            ),
            itemIndex: requireInteger(object["itemIndex"], "Turn admission handle item index"),
            itemKey: requireString(object["itemKey"], "Turn admission handle item key"),
            attempt: new EffectAttemptId(
                requireString(object["attempt"], "Turn admission handle EffectAttempt")
            ),
            identity: TurnAdmissionIdentity.fromData(
                requireObject(object["identity"] ?? null, "Turn admission handle identity")
            )
        });
    }
}

class AdmissionHandleCodec extends RecordCodec<TurnAdmissionHandle> {
    public constructor() {
        super(
            [
                TurnAdmissionHandle,
                TurnAdmissionIdentity,
                Digest,
                RunId,
                TurnId,
                InvocationId,
                EffectAttemptId,
                ReceiptId,
                InvocationAdmissionIdentity,
                ChildRunAdmissionIdentity,
                TextId,
                CodecRecord
            ],
            "turn.admission-handle",
            // Major 1 survives the removal of the top-level `receipt` and `result` fields
            // because this record has no store: `artifacts/records/runs-turns.json` lists
            // `store: null` and the registry gate enforces it, so no encoded handle is ever
            // read back from anywhere. Its bytes cross the command plane only, as a tool
            // position a model reads and an address a delivery keys on, and every consumer
            // decodes the same version this build emits. A persisted handle would need a
            // major bump and a tolerant read instead.
            { major: 1, minor: 0 }
        );
    }
    protected encodePayload(value: TurnAdmissionHandle): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): TurnAdmissionHandle {
        return TurnAdmissionHandle.fromData(value);
    }
}

export const TurnAdmissionHandleCodec: RecordCodec<TurnAdmissionHandle> =
    new AdmissionHandleCodec();

/** The EffectAttempt an AttemptReceipt names, as the Turn seam reads it (SPEC §7.4). */
export interface TurnAdmissionAttemptFacts {
    readonly id: EffectAttemptId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly idempotencyKey: string;
}

/** The attempt and result a succeeded Receipt admits a handle over. */
export interface TurnAdmittedItem {
    readonly attempt: TurnAdmissionAttemptFacts;
    readonly result: ContentRef;
}

/**
 * What one item's Receipt says (SPEC §7.4), reduced to what a handle is built from. Three
 * shapes for three questions, because a single `succeeded` flag answered two of them at
 * once: a pre-effect Receipt never attempted anything, while an attempt Receipt that failed
 * or came back indeterminate attempted and did not succeed, and reporting both as "not
 * succeeded" left one refusal covering two different operator actions. Only the succeeded
 * case can be constructed at all, and it cannot be constructed without its result, so the
 * pairings the verifier used to check are now unrepresentable.
 *
 * `detail` carries why a non-admitting Receipt does not admit — a pre-effect outcome and
 * reason, or an unsuccessful attempt's outcome and failure kind. It exists for the refusal
 * message and is deliberately unreachable from `admitted()`, so no admission decision can
 * come to depend on Receipt failure state (§7.4, C13-RECEIPT-FAILURE-ORTHOGONAL).
 */
export abstract class TurnAdmissionReceiptFacts {
    /** A Receipt over an item that never reached an EffectAttempt, so nothing succeeded. */
    public static preEffect(detail: string): TurnAdmissionReceiptFacts {
        return new PreEffectFacts(detail);
    }

    /** An attempt Receipt that attempted and did not succeed; it names no result. */
    public static unsucceeded(
        attempt: TurnAdmissionAttemptFacts,
        detail: string
    ): TurnAdmissionReceiptFacts {
        return new UnsucceededFacts(attempt, detail);
    }

    /** The only shape that admits a handle, and it cannot exist without its result. */
    public static succeeded(
        attempt: TurnAdmissionAttemptFacts,
        result: ContentRef
    ): TurnAdmissionReceiptFacts {
        return new SucceededFacts(attempt, result);
    }

    /**
     * The attempt and result this Receipt admits a handle over, or a typed refusal naming
     * which non-admitting case it is. Returning rather than reporting keeps the two answers
     * distinct without a nullable pair for a caller to re-check.
     */
    public abstract admit(): TurnAdmittedItem;
}

class PreEffectFacts extends TurnAdmissionReceiptFacts {
    public constructor(private readonly detail: string) {
        super();
        Object.freeze(this);
    }

    public admit(): never {
        throw invalidAdmission(`Admission Receipt reached no EffectAttempt: ${this.detail}`);
    }
}

class UnsucceededFacts extends TurnAdmissionReceiptFacts {
    public constructor(
        private readonly attempt: TurnAdmissionAttemptFacts,
        private readonly detail: string
    ) {
        super();
        Object.freeze(this);
    }

    public admit(): never {
        throw invalidAdmission(
            `Admission EffectAttempt ${this.attempt.id.value} did not succeed: ${this.detail}`
        );
    }
}

class SucceededFacts extends TurnAdmissionReceiptFacts {
    readonly #item: TurnAdmittedItem;

    public constructor(attempt: TurnAdmissionAttemptFacts, result: ContentRef) {
        super();
        this.#item = Object.freeze({ attempt, result });
        Object.freeze(this);
    }

    public admit(): TurnAdmittedItem {
        return this.#item;
    }
}

/**
 * Reads the §7.4 evidence a handle is built from. Deliberately narrow: this seam retrieves
 * records and resolves content and decides nothing, so every rule about what that evidence
 * must say lives in `TurnAdmissionVerifier` and no substrate can admit a handle the Turn
 * layer would refuse.
 */
export abstract class TurnAdmissionRecordPort {
    public abstract receipt(receipt: ReceiptId): Promise<TurnAdmissionReceiptFacts | undefined>;
    public abstract result(ref: ContentRef): Promise<Uint8Array>;
}

/** The Turn presenting an admission, and the exact lease that proves it is that Turn. */
export interface TurnAdmissionScope {
    readonly run: RunId;
    readonly turn: TurnId;
    readonly token: LeaseToken;
}

export interface TurnAdmissionRequest extends TurnAdmissionScope {
    /** The bound Operation's impact; only `delegate` can carry a child RunRef (SPEC §5.6). */
    readonly impact: Impact;
    readonly invocation: InvocationId;
    readonly receipts: readonly ReceiptId[];
}

/** The four facts a handle names its item by, however the caller came to hold them. */
interface TurnAdmissionItemFacts {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
    readonly attempt: EffectAttemptId;
}

/**
 * Builds a handle at either of the two commit points §5.6 gives one, or refuses. Admission
 * itself is untouched in both: this runs after the Invocation plane has recorded what it
 * records, and reads that rather than adding to it.
 *
 * `admit` is the admission commit point. An item with a durable EffectAttempt and no Receipt
 * is exactly what a detached admission leaves, so the facts of that item are all this path
 * reads and there is no Receipt for it to wait on.
 *
 * `verify` is the Receipt commit point, which one identity genuinely needs: a child RunRef
 * cannot exist before the spawn's `delegate` Receipt carries it. A spawn's Receipt has to
 * carry that RunRef and nothing else, so a result naming a child alongside any other field is
 * rejected instead of being read as a child handle plus extra output. A mediated result that
 * names no child leaves the Invocation as the identity, and the item facts it is built from
 * are the ones the Receipt's own EffectAttempt reports, so both paths end in one builder.
 */
export class TurnAdmissionVerifier {
    public constructor(private readonly records: TurnAdmissionRecordPort) {}

    /**
     * The handle an admitted item admits, with no Receipt read (SPEC §5.6). The item is the
     * whole evidence: it names the Invocation, the item index, that item's key and the exact
     * EffectAttempt admission recorded, which is what a later delivery is matched against.
     */
    public admit(scope: TurnAdmissionScope, item: AdmittedInvocationItem): TurnAdmissionHandle {
        this.requireIssuingScope(scope);
        return this.build(scope, item, TurnAdmissionIdentity.invocation(item.invocation));
    }

    public async verify(request: TurnAdmissionRequest): Promise<TurnAdmissionHandle> {
        this.requireIssuingScope(request);
        const [receipt] = request.receipts;
        if (receipt === undefined || request.receipts.length !== 1) {
            throw invalidAdmission("A Turn-issued admission names exactly one item Receipt");
        }
        const facts = await this.records.receipt(receipt);
        if (facts === undefined) {
            throw invalidAdmission("Admission evidence names no stored Receipt");
        }
        // Refuses on its own behalf, naming which non-admitting case it is, so a caller that
        // presented a denial is told that rather than that its attempt failed.
        const admitted = facts.admit();
        if (!admitted.attempt.invocation.equals(request.invocation)) {
            throw invalidAdmission("Admission Receipt names another Invocation's EffectAttempt");
        }
        const bytes = await this.records.result(admitted.result);
        if (!Digest.sha256(bytes).equals(admitted.result.digest)) {
            throw invalidAdmission("Admission result bytes do not hash to the Receipt's content");
        }
        const item: TurnAdmissionItemFacts = {
            invocation: admitted.attempt.invocation,
            itemIndex: admitted.attempt.itemIndex,
            itemKey: admitted.attempt.idempotencyKey,
            attempt: admitted.attempt.id
        };
        const child = childRunOf(request, bytes);
        return this.build(
            request,
            item,
            child === undefined
                ? TurnAdmissionIdentity.invocation(request.invocation)
                : TurnAdmissionIdentity.childRun(child, receipt, admitted.result.digest)
        );
    }

    private build(
        scope: TurnAdmissionScope,
        item: TurnAdmissionItemFacts,
        identity: TurnAdmissionIdentity
    ): TurnAdmissionHandle {
        return new TurnAdmissionHandle({
            run: scope.run,
            turn: scope.turn,
            issuedEpoch: scope.token.epoch,
            invocation: item.invocation,
            itemIndex: item.itemIndex,
            itemKey: item.itemKey,
            attempt: item.attempt,
            identity
        });
    }

    private requireIssuingScope(scope: TurnAdmissionScope): void {
        if (!scope.token.turn.equals(scope.turn)) {
            throw new AgentCoreError(
                "lease.invalid",
                "A Turn admission handle names the exact Turn its lease token holds"
            );
        }
    }
}

/**
 * An Event a handle addresses to a Turn's inbox (SPEC §5.6). Cancellation is not one of
 * them: `turn.cancel` is the reserved inbox Event a fence delivers, and routing it through a
 * handle would make a detached reference a way to end a Turn it no longer belongs to.
 */
export abstract class TurnAdmissionMessage {
    /** The awaited answer, arriving as ordinary history once admission has detached. */
    public static outcome(payload: FacetData): TurnAdmissionMessage {
        return new OutcomeMessage(canonicalFacetData(payload));
    }

    /** External steering of admitted work, keyed by the caller's own nonce. */
    public static steering(nonce: string, payload: FacetData): TurnAdmissionMessage {
        return new SteeringMessage(nonce, canonicalFacetData(payload));
    }

    public abstract readonly event: string;
    public abstract readonly payload: FacetData;
    public abstract key(handle: TurnAdmissionHandle): string;
}

class OutcomeMessage extends TurnAdmissionMessage {
    public readonly event = "admission.outcome";

    public constructor(public readonly payload: FacetData) {
        super();
        Object.freeze(this);
    }

    public key(handle: TurnAdmissionHandle): string {
        return JSON.stringify([handle.address, "outcome"]);
    }
}

class SteeringMessage extends TurnAdmissionMessage {
    public readonly event = "admission.steering";

    public constructor(
        private readonly nonce: string,
        public readonly payload: FacetData
    ) {
        super();
        if (nonce.length === 0) throw new TypeError("Admission steering requires a nonce");
        Object.freeze(this);
    }

    public key(handle: TurnAdmissionHandle): string {
        // The address and the caller's nonce are both unconstrained text, so a
        // delimiter join is not injective; JSON escaping closes each component.
        return JSON.stringify([handle.address, "steering", this.nonce]);
    }
}

export interface TurnAdmissionDelivery {
    readonly handle: TurnAdmissionHandle;
    /** The Turn being addressed: the issuing Turn, or a later one reading it as history. */
    readonly turn: TurnId;
    readonly expected: Revision;
    /** That Turn's exact current lease. A handle addresses work; a lease authorizes writes. */
    readonly token: LeaseToken;
    readonly message: TurnAdmissionMessage;
    readonly now: Date;
}

/**
 * Publishes handles and addresses the work they name (SPEC §5.6).
 *
 * Publication is the point where an item stops being awaited and becomes owned by the Run,
 * so it reserves exactly the §5.2 admission obligation terminalization already knows how to
 * capture — the handle's lifetime and the Run's terminalization are therefore one story:
 * terminalization closes the registry with the handle's item still in the frontier, the Run
 * terminalizes normally, and `isSettled` withholds Settled until that item has a terminal
 * current Receipt. A handle is never a hold on a Turn, which is why ending the issuing Turn
 * is the ordinary case this shape exists for.
 *
 * Every mutation here presents the addressed Turn's exact current lease and is refused
 * without it, so a handle that outlives its Turn can still name the work and can no longer
 * write as it.
 */
export class TurnAdmissionPublisher<Transaction> {
    public constructor(
        private readonly runtime: RunRuntime<Transaction>,
        private readonly content: ContentStore
    ) {}

    /**
     * Reserves the Run obligation a published handle detaches its item into, and in the same
     * transaction takes on the message its Invocation owner is owed (SPEC §5.2, §5.6).
     *
     * One transaction, because the two facts are one fact: an obligation the Run holds with
     * no message durable would leave the owner never told to start, and a message durable
     * with no obligation would let the Run settle while the item is still owed.
     */
    public publish(
        handle: TurnAdmissionHandle,
        token: LeaseToken,
        now: Date
    ): RunAdmissionReservation {
        return this.runtime.repository.transaction((tx) => {
            this.requireIssuingLease(tx, handle, token, now);
            return this.runtime.publishAdmissionInTransaction(tx, handle);
        });
    }

    /** Discharges a published handle's obligation once its item is no longer outstanding. */
    public settle(reservation: RunAdmissionReservation): void {
        this.runtime.completeRunObligation(reservation);
    }

    /**
     * Appends the handle's addressed Event to a Turn's inbox under that Turn's own lease. The
     * addressed Turn may be a later one than the issuing Turn — that is the shape §5.6 exists
     * for — but never one outside the Run the handle detached into, so a handle can be read
     * as history without becoming reach into an unrelated Run.
     */
    public async deliver(delivery: TurnAdmissionDelivery): Promise<TurnInboxEntry> {
        const put = await this.content.put(encodeCanonicalJson(delivery.message.payload));
        const key = delivery.message.key(delivery.handle);
        const delivered = this.runtime.repository.transaction((tx) => {
            const addressed = this.runtime.repository.loadTurn(tx, delivery.turn);
            if (addressed === undefined || !addressed.run.equals(delivery.handle.run)) {
                throw new AgentCoreError(
                    "turn.invalid-state",
                    "A Turn admission handle addresses only Turns of the Run it detached into"
                );
            }
            const sequence = this.runtime.repository.listInbox(tx, delivery.turn).length;
            const entry = new TurnInboxEntry(
                new TurnInboxEntryId(`${key}#${sequence}`),
                delivery.turn,
                sequence,
                delivery.message.event,
                put.ref,
                put.ref.digest,
                key,
                undefined,
                delivery.now
            );
            this.runtime.deliverEventInTransaction(
                tx,
                delivery.turn,
                delivery.expected,
                delivery.token,
                entry,
                delivery.now
            );
            return entry;
        });
        return delivered;
    }

    private requireIssuingLease(
        tx: Transaction,
        handle: TurnAdmissionHandle,
        token: LeaseToken,
        now: Date
    ): void {
        const turn = this.runtime.repository.loadTurn(tx, handle.turn);
        if (turn === undefined) {
            throw new AgentCoreError(
                "turn.invalid-state",
                "A Turn admission handle names no stored Turn"
            );
        }
        if (!token.turn.equals(handle.turn) || token.epoch !== handle.issuedEpoch) {
            throw new AgentCoreError(
                "lease.invalid",
                "A Turn admission handle authorizes addressing its Turn, never writing as it"
            );
        }
        turn.requireToken(token, now);
    }
}

/**
 * The child Run a verified Receipt's result names, and `undefined` where it names none.
 * `decodeCanonicalJson` already refuses bytes that are not in canonical form, so canonicality
 * is its answer rather than a second check here, and what remains is the §5.6 distinction: a
 * delegate result that names a child Run must name only that, while every other mediated
 * result leaves the Invocation as the identity the model reads.
 */
function childRunOf(request: TurnAdmissionRequest, bytes: Uint8Array): RunId | undefined {
    const payload = decodeCanonicalJson(bytes);
    if (request.impact !== "delegate" || !isJsonObject(payload) || !("run" in payload)) {
        return undefined;
    }
    requireExactFields(payload, ["run"], [], "Delegate spawn Receipt result");
    return new RunId(requireString(payload["run"], "Delegate spawn child Run"));
}

function invalidAdmission(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
