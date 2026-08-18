import type { ContentStore } from "../../content";
import {
    ContentRef,
    Digest,
    RecordCodec,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonValue
} from "../../core";
import { AgentCoreError } from "../../errors";
import { TurnId } from "../../execution-references";
import { canonicalFacetData, type FacetData, type Impact } from "../../facets";
import { InvocationId } from "../../interaction-references";
import { EffectAttemptId, ReceiptId } from "../../invocation-references";
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

    public static childRun(run: RunId): TurnAdmissionIdentity {
        return new ChildRunAdmissionIdentity(run);
    }

    public abstract readonly kind: "invocation" | "childRun";

    /** The child Run this identity names; an Invocation identity names none. */
    public abstract readonly childRun: RunId | undefined;

    /** The exact canonical value the model reads in the tool position. */
    public abstract toolPosition(): FacetData;

    /** The stable string an at-least-once delivery keys its idempotency on. */
    public abstract get address(): string;

    public abstract equals(other: TurnAdmissionIdentity): boolean;

    public abstract toData(): JsonValue;

    public static fromData(value: JsonValue): TurnAdmissionIdentity {
        const object = requireObject(value, "Turn admission identity");
        requireExactFields(object, ["kind", "reference"], [], "Turn admission identity");
        const reference = requireString(object["reference"], "Turn admission identity reference");
        const kind = requireString(object["kind"], "Turn admission identity kind");
        if (kind === "invocation") {
            return TurnAdmissionIdentity.invocation(new InvocationId(reference));
        }
        if (kind === "childRun") return TurnAdmissionIdentity.childRun(new RunId(reference));
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

    public constructor(public readonly childRun: RunId) {
        super();
        Object.freeze(this);
    }

    public toolPosition(): FacetData {
        return canonicalFacetData({ run: this.childRun.value });
    }

    public get address(): string {
        return `run:${this.childRun.value}`;
    }

    public equals(other: TurnAdmissionIdentity): boolean {
        return other instanceof ChildRunAdmissionIdentity && other.childRun.equals(this.childRun);
    }

    public toData(): JsonValue {
        return { kind: this.kind, reference: this.childRun.value };
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
    readonly receipt: ReceiptId;
    readonly result: Digest;
    readonly identity: TurnAdmissionIdentity;
}

/**
 * A durable, addressable reference to an admitted mediated item (SPEC §5.6). It is a value
 * rather than a stored record on purpose: everything it names — the Invocation, the
 * EffectAttempt, the Receipt, the child RunRef — is already owned durably elsewhere, so a
 * table of handles would be a second copy of state with its own way of going stale. Its
 * canonical bytes are what survive a process, and re-verifying those bytes against the same
 * §7.4 records is what makes a decoded handle address exactly the work the original named.
 * It carries no time of its own for the same reason: the Receipt it names already records
 * when the item was admitted.
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
    public readonly receipt: ReceiptId;
    public readonly result: Digest;
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
        this.receipt = init.receipt;
        this.result = init.result;
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
            receipt: this.receipt.value,
            result: this.result.value,
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
                "receipt",
                "result",
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
            receipt: new ReceiptId(
                requireString(object["receipt"], "Turn admission handle Receipt")
            ),
            result: digestFromData(object["result"], "Turn admission handle result"),
            identity: TurnAdmissionIdentity.fromData(
                requireObject(object["identity"] ?? null, "Turn admission handle identity")
            )
        });
    }
}

class AdmissionHandleCodec extends RecordCodec<TurnAdmissionHandle> {
    public constructor() {
        super("turn.admission-handle", { major: 1, minor: 0 });
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

export interface TurnAdmissionRequest {
    readonly run: RunId;
    readonly turn: TurnId;
    readonly token: LeaseToken;
    /** The bound Operation's impact; only `delegate` can carry a child RunRef (SPEC §5.6). */
    readonly impact: Impact;
    readonly invocation: InvocationId;
    readonly receipts: readonly ReceiptId[];
}

/**
 * Builds a handle from admission evidence, or refuses. Admission itself is untouched: this
 * runs after the mediated pipeline has produced its Invocation, EffectAttempt, Receipt and
 * audit chain, and reads them rather than adding to them. A `delegate` spawn's Receipt has
 * to carry the child RunRef and nothing else, so a result that names a child alongside any
 * other field is rejected instead of being read as a child handle plus extra output.
 */
export class TurnAdmissionVerifier {
    public constructor(private readonly records: TurnAdmissionRecordPort) {}

    public async verify(request: TurnAdmissionRequest): Promise<TurnAdmissionHandle> {
        if (!request.token.turn.equals(request.turn)) {
            throw new AgentCoreError(
                "lease.invalid",
                "A Turn admission handle names the exact Turn its lease token holds"
            );
        }
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
        return new TurnAdmissionHandle({
            run: request.run,
            turn: request.turn,
            issuedEpoch: request.token.epoch,
            invocation: request.invocation,
            itemIndex: admitted.attempt.itemIndex,
            itemKey: admitted.attempt.idempotencyKey,
            attempt: admitted.attempt.id,
            receipt,
            result: admitted.result.digest,
            identity: identityFor(request, bytes)
        });
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

    /** Reserves the Run obligation a published handle detaches its item into. */
    public publish(
        handle: TurnAdmissionHandle,
        token: LeaseToken,
        now: Date
    ): RunAdmissionReservation {
        return this.runtime.repository.transaction((tx) => {
            this.requireIssuingLease(tx, handle, token, now);
            return this.runtime.reserveRunObligationInTransaction(
                tx,
                handle.run,
                handle.obligation()
            );
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
 * Which identity a verified Receipt's result names. `decodeCanonicalJson` already refuses
 * bytes that are not in canonical form, so canonicality is its answer rather than a second
 * check here, and what remains is the §5.6 distinction: a delegate result that names a child
 * Run must name only that, while every other mediated result leaves the Invocation as the
 * identity the model reads.
 */
function identityFor(request: TurnAdmissionRequest, bytes: Uint8Array): TurnAdmissionIdentity {
    const payload = decodeCanonicalJson(bytes);
    if (request.impact !== "delegate" || !isJsonObject(payload) || !("run" in payload)) {
        return TurnAdmissionIdentity.invocation(request.invocation);
    }
    requireExactFields(payload, ["run"], [], "Delegate spawn Receipt result");
    return TurnAdmissionIdentity.childRun(
        new RunId(requireString(payload["run"], "Delegate spawn child Run"))
    );
}

function invalidAdmission(message: string): AgentCoreError {
    return new AgentCoreError("invocation.invalid", message);
}
