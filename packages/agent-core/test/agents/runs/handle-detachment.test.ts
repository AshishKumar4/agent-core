import { describe, expect, it } from "vitest";
import { MemoryContentStore } from "../../../src/content";
import { ContentRef, Digest, Revision, encodeCanonicalJson } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import type { FacetData, Impact } from "../../../src/facets";
import { InvocationId } from "../../../src/interaction-references";
import { EffectAttemptId, ReceiptId } from "../../../src/invocation-references";
import { AttemptCompletion, AttemptReceipt, PreEffectReceipt } from "../../../src/invocations";
import {
    runObligationKey,
    type RunAdmissionReservation,
    type RunObligation
} from "../../../src/agents/runs/admission";
import {
    ResourceCeiling,
    SpawnAttenuation,
    type ResourceDimension,
    type ResourceLimits
} from "../../../src/agents/runs/ceiling";
import { RunCommit } from "../../../src/agents/runs/commit";
import { requireObject } from "../../../src/agents/record-data";
import {
    RunInvocationDelivery,
    RunInvocationDeliveryCause
} from "../../../src/agents/runs/invocation-delivery";
import {
    TurnAdmissionHandle,
    TurnAdmissionPublisher,
    TurnAdmissionReceiptFacts,
    TurnAdmissionRecordPort,
    TurnAdmissionVerifier
} from "../../../src/agents/runs/handle";
import {
    RunBranchId,
    RunId,
    SpawnReservationId,
    TurnInboxEntryId
} from "../../../src/agents/runs/id";
import type { LeaseToken } from "../../../src/agents/runs/lease";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import type { RunTerminalization, TerminalizeRunRequest } from "../../../src/agents/runs/runtime";
import { SpawnReservation } from "../../../src/agents/runs/spawn";
import { Turn, TurnInboxEntry } from "../../../src/agents/runs/turn";
import {
    attenuationDigest,
    configuration,
    content,
    digest,
    harness,
    ids,
    mutableData,
    pins,
    seedRunningTurn,
    settlementAuditKey,
    thrownBy,
    type Assembled
} from "./fixture";

const ADMITTED_AT = new Date(1_400);
const PUBLISHED_AT = new Date(1_500);
const CANCELLED_AT = new Date(1_600);
const OUTPUT: FacetData = { value: 1 };
/**
 * One cancellation for every Run this file cancels, aborted before the first one does: §7.4
 * builds `aborted` from cancellation that reached the attempt and from nothing else.
 */
const CANCELLATION = new AbortController();
CANCELLATION.abort();

type Seeded = ReturnType<typeof seedRunningTurn>;

/** The §7.4 identities one mediated item is admitted under, frozen across both halves. */
interface ItemEvidence {
    readonly receipt: ReceiptId;
    readonly attempt: EffectAttemptId;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
}

/** The awaited mediated item whose admission identity the Turn puts in the tool position. */
const ITEM: ItemEvidence = Object.freeze({
    receipt: new ReceiptId("detachment-receipt"),
    attempt: new EffectAttemptId("detachment-attempt"),
    invocation: new InvocationId("detachment-invocation"),
    itemIndex: 0,
    itemKey: "detachment-item-key"
});

/** The `delegate` spawn item whose Receipt carries the child RunRef and nothing else. */
const DELEGATE: ItemEvidence = Object.freeze({
    receipt: new ReceiptId("delegate-receipt"),
    attempt: new EffectAttemptId("delegate-attempt"),
    invocation: new InvocationId("delegate-invocation"),
    itemIndex: 0,
    itemKey: "delegate-item-key"
});

/**
 * The §7.4 evidence seam, holding the real Receipt records an admission is verified over and
 * the content their attempts produced. Projecting a Receipt into `TurnAdmissionReceiptFacts`
 * is the only work it does, so every admission rule stays in `TurnAdmissionVerifier` and the
 * record a test reads is the one §7.4 defines rather than a shape invented here.
 */
class ItemRecords extends TurnAdmissionRecordPort {
    readonly #store = new MemoryContentStore();
    readonly #facts = new Map<string, TurnAdmissionReceiptFacts>();

    /** Records the succeeded attempt Receipt that admits a handle over `output`. */
    public async succeed(item: ItemEvidence, output: FacetData): Promise<AttemptReceipt> {
        const stored = await this.#store.put(encodeCanonicalJson(output));
        const receipt = new AttemptReceipt(
            item.receipt,
            item.attempt,
            AttemptCompletion.succeeded,
            undefined,
            ADMITTED_AT,
            stored.ref
        );
        this.#facts.set(
            item.receipt.value,
            TurnAdmissionReceiptFacts.succeeded(attemptFacts(item), stored.ref)
        );
        return receipt;
    }

    /** Records the pre-effect Receipt a Turn lost before admission leaves behind (§7.4). */
    public cancelPreEffect(item: ItemEvidence, reason: string): PreEffectReceipt {
        const receipt = new PreEffectReceipt(
            item.receipt,
            item.invocation,
            item.itemIndex,
            "cancelledPreEffect",
            ADMITTED_AT,
            reason
        );
        this.#facts.set(
            item.receipt.value,
            TurnAdmissionReceiptFacts.preEffect(`${receipt.outcome} ${receipt.reason}`)
        );
        return receipt;
    }

    public async receipt(receipt: ReceiptId): Promise<TurnAdmissionReceiptFacts | undefined> {
        return this.#facts.get(receipt.value);
    }

    public async result(ref: ContentRef): Promise<Uint8Array> {
        return this.#store.get(ref);
    }
}

function attemptFacts(item: ItemEvidence) {
    return Object.freeze({
        id: item.attempt,
        invocation: item.invocation,
        itemIndex: item.itemIndex,
        idempotencyKey: item.itemKey
    });
}

function admissionRequest(value: Seeded, item: ItemEvidence, impact: Impact = "observe") {
    return {
        run: value.running.run,
        turn: value.running.id,
        token: value.token,
        impact,
        invocation: item.invocation,
        receipts: [item.receipt]
    };
}

/** The publisher owns the Run's content store, since a delivery writes its own payload. */
function publisher(value: Seeded): TurnAdmissionPublisher<object> {
    return new TurnAdmissionPublisher(value.runtime, value.storage.content);
}

/**
 * Publishes a handle and records the §7.4 evidence a later reader derives the same handle
 * back from. Publication is what detaches the item to a Run, so a Run's cancellation has to
 * be able to read the value the Turn put in the model's tool position.
 */
function publish(
    value: Seeded,
    handle: TurnAdmissionHandle,
    token: LeaseToken
): RunAdmissionReservation {
    const reservation = publisher(value).publish(handle, token, PUBLISHED_AT);
    value.evidence.publishedHandles.set(runObligationKey(handle.obligation()), handle);
    return reservation;
}

/** The messages a Run still owes its published items' Invocation owners. */
function pendingDeliveries(value: Seeded, run: RunId = ids.run) {
    return value.runtime.pendingInvocationDeliveries(run);
}

/** Only the cancellation messages, which is what a Run's own end owes. */
function cancellationDeliveries(value: Seeded, run: RunId = ids.run) {
    return pendingDeliveries(value, run).filter((entry) => entry.cause.kind === "cancellation");
}

/** Every key a delivery's canonical bytes carry, so a new field cannot arrive unnoticed. */
function deliveryKeys(value: RunInvocationDelivery): readonly string[] {
    return Object.keys(requireObject(value.toData(), "delivery")).sort();
}

/** Runs an admission that must be refused and hands back the typed refusal. */
async function refusedBy(admission: Promise<TurnAdmissionHandle>): Promise<AgentCoreError> {
    try {
        await admission;
    } catch (error) {
        if (error instanceof AgentCoreError) return error;
        throw error;
    }
    throw new TypeError("Expected the admission to be refused");
}

function requireRun(value: Seeded, run: RunId): Run {
    return value.repository.transaction((transaction) => {
        const stored = value.repository.loadRun(transaction, run);
        if (stored === undefined) throw new TypeError("Expected a stored Run");
        return stored;
    });
}

function requireTurn(value: Seeded, turn: TurnId): Turn {
    return value.repository.transaction((transaction) => {
        const stored = value.repository.loadTurn(transaction, turn);
        if (stored === undefined) throw new TypeError("Expected a stored Turn");
        return stored;
    });
}

function requireBranch(value: Seeded, branch: RunBranchId): RunBranch {
    return value.repository.transaction((transaction) => {
        const stored = value.repository.loadBranch(transaction, branch);
        if (stored === undefined) throw new TypeError("Expected a stored Run branch");
        return stored;
    });
}

function requirePlacement(value: Seeded, turn: TurnId): Digest {
    return value.repository.transaction((transaction) => {
        const stored = value.repository.loadPlacement(transaction, turn);
        if (stored === undefined) throw new TypeError("Expected a stored Turn placement");
        return stored.digest;
    });
}

/** What the Run still owes: the obligations its open admission registry holds. */
function frontier(value: Seeded, run: RunId): readonly RunObligation[] {
    return value.repository.transaction((transaction) => {
        const registry = value.repository.loadAdmission(transaction, run);
        if (registry === undefined) throw new TypeError("Expected a stored admission registry");
        return registry.frontier();
    });
}

/** Records the §7.4 evidence that one published item now has a terminal current Receipt. */
function satisfyItem(value: Seeded, handle: TurnAdmissionHandle): void {
    value.settlement.terminalItems.add(
        `${handle.invocation.value}:${handle.itemIndex}:${handle.itemKey}`
    );
    value.settlement.audits.add(
        settlementAuditKey({
            kind: "receipt",
            invocation: handle.invocation,
            itemIndex: handle.itemIndex,
            itemKey: handle.itemKey
        })
    );
}

/** Cancels the seeded issuing Turn through the §5.3 held-cancellation rows. */
function cancelIssuingTurn(value: Seeded, name: string): void {
    const turn = requireTurn(value, ids.turn);
    const inbox = value.repository.transaction((transaction) =>
        value.repository.listInbox(transaction, ids.turn)
    );
    value.runtime.cancelHeldTurn(
        {
            turn: ids.turn,
            expectedTurnRevision: turn.revision,
            expectedBranchRevision: requireBranch(value, ids.branch).revision,
            token: value.token,
            outcome: "cancelled",
            commit: new RunCommit({
                id: new RunCommitId(`commit-${name}`),
                run: ids.run,
                branch: ids.branch,
                kind: "result",
                parents: [requireBranch(value, ids.branch).head],
                pins: pins(),
                writer: { kind: "turn", token: value.token },
                subjectTurn: ids.turn,
                content: content("7")
            }),
            now: CANCELLED_AT
        },
        new TurnInboxEntry(
            new TurnInboxEntryId(`cancel-${name}`),
            ids.turn,
            inbox.length,
            "turn.cancel",
            content("b"),
            digest("b"),
            `cancel-key-${name}`,
            value.token,
            CANCELLED_AT
        )
    );
}

interface RunCancellation {
    readonly run: RunId;
    readonly branch: RunBranchId;
    /** The Turn that performs the cancellation, and whose lease authorizes its writes. */
    readonly turn: TurnId;
    readonly token: LeaseToken;
    readonly name: string;
    /**
     * The cancellation §7.4 builds `aborted` from for anything this Run published. It is
     * aborted before any Run here cancels, so every case reads the same reached cancellation.
     */
    readonly cancellation?: AbortSignal;
    readonly exhausted?: ResourceDimension;
    readonly now?: Date;
}

/** The §5.3 terminal request one Run cancellation presents, under the named Turn lease. */
function cancellationRequest(
    value: Seeded,
    request: RunCancellation
): Assembled<TerminalizeRunRequest> {
    const branch = requireBranch(value, request.branch);
    const terminalize: Assembled<TerminalizeRunRequest> = {
        run: request.run,
        turn: request.turn,
        expectedRunRevision: requireRun(value, request.run).revision,
        expectedTurnRevision: requireTurn(value, request.turn).revision,
        expectedBranchRevision: branch.revision,
        token: request.token,
        outcome: "cancelled",
        commit: new RunCommit({
            id: new RunCommitId(`commit-${request.name}`),
            run: request.run,
            branch: request.branch,
            kind: "result",
            parents: [branch.head],
            pins: pins(),
            writer: { kind: "turn", token: request.token },
            subjectTurn: request.turn,
            content: content("8")
        }),
        cancellation: request.cancellation ?? CANCELLATION.signal,
        siblingCancellations: new Map(),
        now: request.now ?? CANCELLED_AT
    };
    if (request.exhausted !== undefined) terminalize.exhausted = request.exhausted;
    return terminalize;
}

/** Cancels one Run through its own §5.3 terminal rows, under the presented Turn lease. */
function cancelRun(value: Seeded, request: RunCancellation): RunTerminalization {
    return value.runtime.terminalizeRun(cancellationRequest(value, request));
}

interface ChildSpawn {
    readonly name: string;
    readonly parent: RunId;
    /** The spawning Turn's exact current lease, which the reservation names. */
    readonly token: LeaseToken;
    readonly limits: ResourceLimits;
    readonly at?: Date;
}

/** Spawns a child Run, declaring `limits` as the ceiling its attenuation commits to. */
function spawnChild(value: Seeded, request: ChildSpawn) {
    const at = request.at ?? PUBLISHED_AT;
    const snapshot = configuration();
    const run = new RunId(`run-${request.name}`);
    const branch = new RunBranchId(`branch-${request.name}`);
    const rootContent = content("4");
    const root = new RunCommit({
        id: new RunCommitId(`commit-root-${request.name}`),
        run,
        branch,
        kind: "root",
        parents: [],
        pins: snapshot.pins,
        writer: { kind: "root" },
        content: rootContent,
        treeCheckpoint: content("e")
    });
    const attenuation = new SpawnAttenuation({ ceiling: new ResourceCeiling(request.limits) });
    const reservation = new SpawnReservation(
        new SpawnReservationId(`spawn-${request.name}`),
        request.parent,
        request.token.turn,
        run,
        request.token,
        snapshot.id,
        rootContent,
        DELEGATE.invocation,
        DELEGATE.receipt,
        attenuationDigest(attenuation),
        at
    );
    value.spawn.attenuations.set(reservation.id.value, attenuation);
    value.runtime.spawnRun(
        reservation,
        {
            run: new Run({
                id: run,
                agent: ids.agent,
                configuration: snapshot.id,
                root: root.id,
                initialBranch: branch,
                parent: request.parent,
                revision: new Revision(0)
            }),
            configuration: snapshot,
            branch: new RunBranch(branch, run, "main", root.id, new Revision(0)),
            root
        },
        at
    );
    const turn = new TurnId(`turn-${request.name}`);
    const placement = new TurnPlacementSnapshot(turn, pins(), []);
    value.runtime.createTurn(
        {
            turn: new Turn({
                id: turn,
                run,
                branch,
                startHead: root.id,
                effectiveInput: root.id,
                pins: pins(),
                placement: placement.digest,
                input: content("a"),
                revision: new Revision(0)
            }),
            placement
        },
        new Revision(0)
    );
    value.runtime.claimTurn(turn, new Revision(0), ids.holder, at, new Date(500_000));
    return {
        run,
        branch,
        token: Object.freeze({ turn, holder: ids.holder, epoch: 1 })
    };
}

describe("admission as the handle's commit point", () => {
    it(
        "[C13-TURN-HANDLE-DETACHMENT] issues no handle before admission and freezes the admitted item after it",
        { tags: "p0" },
        async () => {
            // One admission from both sides. The Run, the Turn, the Invocation and the item
            // are the same on each half, so which side of the commit point the cancellation
            // falls on is the only thing that differs.
            const before = seedRunningTurn();
            const after = seedRunningTurn();

            // Before admission the Turn is cancelled, so §7.4 holds a pre-effect Receipt over
            // an item that never reached an EffectAttempt.
            const lost = new ItemRecords();
            const preEffect = lost.cancelPreEffect(ITEM, "the issuing Turn lost its lease");
            cancelIssuingTurn(before, "detachment-before");
            expect([preEffect.variant, preEffect.outcome]).toEqual([
                "preEffect",
                "cancelledPreEffect"
            ]);
            expect(Object.keys(preEffect)).not.toContain("attempt");

            const refused = await refusedBy(
                new TurnAdmissionVerifier(lost).verify(admissionRequest(before, ITEM))
            );
            expect(refused.code).toBe("invocation.invalid");
            expect(refused.message).toMatch(/reached no EffectAttempt/);
            // Nothing detached, so the Run never owed the item and Settled never waits on it.
            expect(frontier(before, ids.run)).toEqual([]);

            // After admission the same item is frozen. Its intent is the Invocation, item key
            // and EffectAttempt the handle names; its placement and Package pin are the
            // Turn's, and the cancellation moves none of them.
            const admitted = new ItemRecords();
            await admitted.succeed(ITEM, OUTPUT);
            const handle = await new TurnAdmissionVerifier(admitted).verify(
                admissionRequest(after, ITEM)
            );
            const reservation = publish(after, handle, after.token);
            const placement = requirePlacement(after, ids.turn);
            const packagePins = requireTurn(after, ids.turn).pins;

            cancelIssuingTurn(after, "detachment-after");

            expect(requireTurn(after, ids.turn).status.kind).toBe("cancelled");
            expect([handle.invocation.value, handle.itemIndex, handle.itemKey]).toEqual([
                ITEM.invocation.value,
                ITEM.itemIndex,
                ITEM.itemKey
            ]);
            expect(handle.attempt.equals(ITEM.attempt)).toBe(true);
            expect(requirePlacement(after, ids.turn).equals(placement)).toBe(true);
            expect(requireTurn(after, ids.turn).pins.equals(packagePins)).toBe(true);
            // The item's Receipt is still owed to the Run, so the cancellation revoked no
            // handle. A host that revoked one on Turn cancellation fails exactly here.
            expect(frontier(after, ids.run)).toEqual([handle.obligation()]);
            expect(after.runtime.acceptsRunAdmission(reservation)).toBe(true);
        }
    );
});

describe("the issuing Turn's cancellation and a published handle", () => {
    it(
        "[C13-TURN-HANDLE-DETACHMENT] records no aborted failure on an item the cancelled Turn published",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const records = new ItemRecords();
            await records.succeed(ITEM, OUTPUT);
            const handle = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, ITEM)
            );
            const reservation = publish(seeded, handle, seeded.token);

            cancelIssuingTurn(seeded, "detachment-prohibition");
            const cancelled = requireTurn(seeded, ids.turn);
            expect(cancelled.status.kind).toBe("cancelled");
            expect(cancelled.lease.holder).toBeUndefined();

            // The message is the discriminating observation: a host that propagated the
            // Turn's cancellation would owe the Invocation owner a message for an item this
            // rule requires to settle on its own terms.
            const terminalCommit = new RunCommitId("detachment-prohibition-commit");
            expect(handle.cancellationDelivery(cancelled.id, terminalCommit)).toBeUndefined();

            // The same call over the item's own owner does owe one, so the refusal above is
            // this rule rather than a method that answers nothing.
            expect(handle.owner.equals(ids.run)).toBe(true);
            const owed = handle.cancellationDelivery(handle.owner, terminalCommit);
            expect(owed?.cause.kind).toBe("cancellation");
            expect(owed?.attempt.equals(handle.attempt)).toBe(true);

            // The Run owes a request and never a verdict. §7.4 builds `aborted` only from
            // cancellation the target observed reaching the attempt, so there is no field
            // here a failure kind could travel in.
            expect(deliveryKeys(owed!)).toEqual([
                "attempt",
                "cause",
                "id",
                "invocation",
                "itemIndex",
                "itemKey",
                "run"
            ]);
            expect(Object.keys(requireObject(owed!.cause.toData(), "cause")).sort()).toEqual([
                "kind",
                "terminalCommit"
            ]);

            // Publication owes the owner its admission message, and the issuing Turn's
            // cancellation leaves that message exactly as it was.
            expect(pendingDeliveries(seeded).map((entry) => entry.cause.kind)).toEqual([
                "admission"
            ]);

            // The item settles on its own terms: the Run still owes its Receipt and still
            // admits the reservation publication made.
            expect(frontier(seeded, ids.run)).toEqual([handle.obligation()]);
            expect(seeded.runtime.acceptsRunAdmission(reservation)).toBe(true);

            // The fence is the other half of the rule. A cancelled Turn is terminal and
            // unheld, so it can name the detached work and can author no write for it.
            const fenced = thrownBy(
                AgentCoreError,
                () => publisher(seeded).publish(handle, seeded.token, new Date(1_700)),
                "publish under a fenced lease"
            );
            expect(fenced.code).toBe("lease.invalid");
        }
    );
});

describe("the two owners a published handle detaches to", () => {
    it(
        "[C13-TURN-HANDLE-DETACHMENT] [C13-RUN-SETTLED-DERIVED] aborts the Run's own outstanding item and leaves a spawned child Run to itself",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const records = new ItemRecords();
            await records.succeed(ITEM, OUTPUT);
            const outstanding = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, ITEM)
            );
            publish(seeded, outstanding, seeded.token);

            // A `delegate` spawn in the same Turn. Its Receipt carries the child RunRef, so
            // the handle the model reads names a settlement unit of its own.
            const child = spawnChild(seeded, {
                name: "detachment-child",
                parent: ids.run,
                token: seeded.token,
                limits: { tokens: 10 }
            });
            await records.succeed(DELEGATE, { run: child.run.value });
            const delegated = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, DELEGATE, "delegate")
            );
            publish(seeded, delegated, seeded.token);

            // The two owners are different Runs, which is what a host that cascaded collapses.
            expect(outstanding.owner.equals(ids.run)).toBe(true);
            expect(delegated.owner.equals(child.run)).toBe(true);

            // The `delegate` Receipt is terminal as soon as it carries the child RunRef, so
            // the parent's obligation for it is dischargeable while the child still runs.
            satisfyItem(seeded, delegated);

            const terminal = cancelRun(seeded, {
                run: ids.run,
                branch: ids.branch,
                turn: ids.turn,
                token: seeded.token,
                name: "detachment-run-cancel"
            });
            expect(terminal.snapshot.outcome).toBe("cancelled");

            // The cancellation path itself answers, which is the discriminating observation: a
            // host that cascaded would owe the child's item a message too.
            const owed = cancellationDeliveries(seeded);
            expect(owed.map((entry) => entry.itemKey)).toEqual([ITEM.itemKey]);
            expect(
                owed.every((entry) =>
                    entry.cause.terminalCommit?.equals(terminal.snapshot.terminalCommit)
                )
            ).toBe(true);
            expect(owed.some((entry) => entry.itemKey === DELEGATE.itemKey)).toBe(false);
            expect(requireRun(seeded, child.run).lifecycle.kind).toBe("active");
            expect(requireTurn(seeded, child.token.turn).status.kind).toBe("running");

            // Settled waits on the Run's own item, and the child never withholds it.
            expect(terminal.snapshot.obligation.obligations).toHaveLength(2);
            expect(terminal.snapshot.obligation.obligations).toEqual(
                expect.arrayContaining([outstanding.obligation(), delegated.obligation()])
            );
            expect(seeded.runtime.settled(ids.run)).toBe(false);
            satisfyItem(seeded, outstanding);
            expect(seeded.runtime.settled(ids.run)).toBe(true);
            expect(requireRun(seeded, child.run).lifecycle.kind).toBe("active");
        }
    );

    it(
        "[C13-TURN-HANDLE-DETACHMENT] [C13-TURN-EXACT-LEASE] refuses the parent Turn's lease as authority over a child Run",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const child = spawnChild(seeded, {
                name: "isolated-child",
                parent: ids.run,
                token: seeded.token,
                limits: { tokens: 10 }
            });
            const records = new ItemRecords();
            await records.succeed(DELEGATE, { run: child.run.value });
            const delegated = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, DELEGATE, "delegate")
            );
            expect(delegated.identity.childRun?.equals(child.run)).toBe(true);

            // The parent Turn presented as the child Run's finishing Turn: it belongs to
            // another Run, so the child's terminal rows refuse it.
            const foreignTurn = thrownBy(
                AgentCoreError,
                () =>
                    cancelRun(seeded, {
                        run: child.run,
                        branch: ids.branch,
                        turn: ids.turn,
                        token: seeded.token,
                        name: "isolated-foreign-turn"
                    }),
                "the parent Turn terminalizing the child Run"
            );
            expect(foreignTurn.code).toBe("run.invalid-state");
            expect(foreignTurn.message).toMatch(/does not match the finishing Turn/);

            // The child's own Turn under the parent's lease: a Turn lease authorizes writes
            // for no other Turn, so the exact-lease rule refuses it.
            const foreignLease = thrownBy(
                AgentCoreError,
                () =>
                    cancelRun(seeded, {
                        run: child.run,
                        branch: child.branch,
                        turn: child.token.turn,
                        token: seeded.token,
                        name: "isolated-foreign-lease"
                    }),
                "the parent lease terminalizing the child Run"
            );
            expect(foreignLease.code).toBe("lease.invalid");
            expect(foreignLease.message).toMatch(/exact current lease token/);

            // Both refusals left the child running, so neither was a cancellation that raced.
            expect(requireRun(seeded, child.run).lifecycle.kind).toBe("active");
            expect(requireTurn(seeded, child.token.turn).status.kind).toBe("running");

            // Only authority that reaches the child Run cancels it, and it reaches no further.
            const terminal = cancelRun(seeded, {
                run: child.run,
                branch: child.branch,
                turn: child.token.turn,
                token: child.token,
                name: "isolated-own-lease"
            });
            expect(terminal.snapshot.run.equals(child.run)).toBe(true);
            expect(requireRun(seeded, child.run).lifecycle.kind).toBe("terminal");
            expect(requireRun(seeded, ids.run).lifecycle.kind).toBe("active");
            expect(requireTurn(seeded, ids.turn).status.kind).toBe("running");
        }
    );
});

describe("the cancellation a published item answers to", () => {
    it(
        "[C13-TURN-HANDLE-DETACHMENT] reports `aborted` for a published item when its Run cancels and nothing when its issuing Turn does",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const records = new ItemRecords();
            await records.succeed(ITEM, OUTPUT);
            const handle = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, ITEM)
            );
            publish(seeded, handle, seeded.token);

            // A second Turn, because a Run finishes under a lease the cancelled Turn no longer
            // holds. Ending the issuing Turn is the ordinary case this shape exists for.
            const finishing = seedRunningTurn(seeded, {
                id: new TurnId("turn-detachment-scope")
            });
            cancelIssuingTurn(seeded, "detachment-scope-turn");
            expect(requireTurn(seeded, ids.turn).status.kind).toBe("cancelled");
            expect(requireRun(seeded, ids.run).lifecycle.kind).toBe("active");
            // The Turn's cancellation reached the item with no failure kind: the item is still
            // owed and no path recorded one for it.
            expect(frontier(seeded, ids.run)).toEqual([handle.obligation()]);

            cancelRun(seeded, {
                run: ids.run,
                branch: ids.branch,
                turn: finishing.token.turn,
                token: finishing.token,
                name: "detachment-scope-run"
            });
            // The Run's cancellation reaches the same item, and reaches it once. A host that
            // let the Turn's cancellation propagate would have aborted it already.
            const owed = cancellationDeliveries(seeded);
            expect(owed.map((entry) => [entry.invocation.value, entry.cause.kind])).toEqual([
                [ITEM.invocation.value, "cancellation"]
            ]);
            expect(owed[0]?.itemKey).toBe(ITEM.itemKey);
            expect(owed[0]?.attempt.equals(ITEM.attempt)).toBe(true);
        }
    );

    it(
        "[C13-TURN-HANDLE-DETACHMENT] reports nothing for a child RunRef item a parent's cancellation reaches, while that item is still owed",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const records = new ItemRecords();
            const child = spawnChild(seeded, {
                name: "scope-child",
                parent: ids.run,
                token: seeded.token,
                limits: { tokens: 10 }
            });
            await records.succeed(DELEGATE, { run: child.run.value });
            const delegated = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, DELEGATE, "delegate")
            );
            publish(seeded, delegated, seeded.token);
            await records.succeed(ITEM, OUTPUT);
            const own = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, ITEM)
            );
            publish(seeded, own, seeded.token);

            // Neither item has a terminal Receipt, so nothing separates them but the owner the
            // handle names. A host reading the obligation rather than the handle reports both.
            cancelRun(seeded, {
                run: ids.run,
                branch: ids.branch,
                turn: ids.turn,
                token: seeded.token,
                name: "scope-child-cancel"
            });
            expect(cancellationDeliveries(seeded).map((entry) => entry.itemKey)).toEqual([
                ITEM.itemKey
            ]);
            expect(delegated.owner.equals(child.run)).toBe(true);
            expect(requireRun(seeded, child.run).lifecycle.kind).toBe("active");
            expect(requireTurn(seeded, child.token.turn).status.kind).toBe("running");
        }
    );

    it(
        "[C13-TURN-HANDLE-DETACHMENT] reports nothing for a published item whose Receipt is already terminal",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const records = new ItemRecords();
            await records.succeed(ITEM, OUTPUT);
            const handle = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, ITEM)
            );
            publish(seeded, handle, seeded.token);
            satisfyItem(seeded, handle);

            // §7.4 admits no second Receipt over a terminal item, so a cancellation that
            // arrived after it finished names no kind for it.
            const terminal = cancelRun(seeded, {
                run: ids.run,
                branch: ids.branch,
                turn: ids.turn,
                token: seeded.token,
                name: "scope-terminal-item"
            });
            expect(cancellationDeliveries(seeded)).toEqual([]);
            expect(terminal.snapshot.obligation.obligations).toEqual([handle.obligation()]);
            expect(seeded.runtime.settled(ids.run)).toBe(true);
        }
    );

    it(
        "[C13-TURN-HANDLE-DETACHMENT] [C13-TURN-EXACT-LEASE] refuses a TurnId presented where the cancelled Run is required",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const records = new ItemRecords();
            await records.succeed(ITEM, OUTPUT);
            const handle = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, ITEM)
            );
            publish(seeded, handle, seeded.token);

            // Every TextId subclass carries the same shape, so this call compiles. Storage keys
            // are text, so the Run loads, and the owner comparison then matches nothing: a
            // cancelled Run that aborted none of its published work and said nothing about it.
            const impostor = new TurnId(ids.run.value);
            expect(impostor.equals(ids.run)).toBe(false);
            const refused = thrownBy(
                TypeError,
                () =>
                    cancelRun(seeded, {
                        run: impostor,
                        branch: ids.branch,
                        turn: ids.turn,
                        token: seeded.token,
                        name: "scope-impostor"
                    }),
                "a TurnId presented as the cancelled Run"
            );
            expect(refused.message).toMatch(/exact Run ID class/);
            expect(requireRun(seeded, ids.run).lifecycle.kind).toBe("active");

            // The exact class reaches the item, so the refusal above is the identity rule and
            // not a Run this harness never cancelled.
            cancelRun(seeded, {
                run: ids.run,
                branch: ids.branch,
                turn: ids.turn,
                token: seeded.token,
                name: "scope-exact-run"
            });
            expect(cancellationDeliveries(seeded).map((entry) => entry.cause.kind)).toEqual([
                "cancellation"
            ]);
        }
    );

    it(
        "[C13-TURN-HANDLE-DETACHMENT] refuses a cancelled Run that names no cancellation, or one nothing aborted",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const records = new ItemRecords();
            await records.succeed(ITEM, OUTPUT);
            const handle = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, ITEM)
            );
            publish(seeded, handle, seeded.token);

            // A cancellation nothing fired says nothing §7.4 can build `aborted` from, so the
            // whole request is refused before any of it lands.
            const open = thrownBy(
                AgentCoreError,
                () =>
                    cancelRun(seeded, {
                        run: ids.run,
                        branch: ids.branch,
                        turn: ids.turn,
                        token: seeded.token,
                        name: "scope-open-signal",
                        cancellation: new AbortController().signal
                    }),
                "a cancelled Run naming an open cancellation"
            );
            expect(open.code).toBe("run.invalid-state");
            expect(open.message).toMatch(/already reached its published items/);
            expect(requireRun(seeded, ids.run).lifecycle.kind).toBe("active");
            expect(frontier(seeded, ids.run)).toEqual([handle.obligation()]);

            // The rule is exclusive in both directions. A cancelled Run that names no
            // cancellation could resolve none of its published items, and a Run that ended
            // any other way reached none to resolve, so neither request is admitted.
            const request = cancellationRequest(seeded, {
                run: ids.run,
                branch: ids.branch,
                turn: ids.turn,
                token: seeded.token,
                name: "scope-exclusive"
            });
            for (const [label, mutate] of [
                [
                    "cancelled with no cancellation",
                    (): Assembled<TerminalizeRunRequest> => {
                        const bare = { ...request };
                        delete bare.cancellation;
                        return bare;
                    }
                ],
                [
                    "succeeded with a cancellation",
                    (): Assembled<TerminalizeRunRequest> => ({
                        ...request,
                        outcome: "succeeded"
                    })
                ]
            ] as const) {
                const refused = thrownBy(
                    AgentCoreError,
                    () => {
                        seeded.runtime.terminalizeRun(mutate());
                    },
                    label
                );
                expect([label, refused.code]).toEqual([label, "run.invalid-state"]);
                expect(refused.message).toMatch(/no other outcome names one/);
            }
            expect(requireRun(seeded, ids.run).lifecycle.kind).toBe("active");

            // The reached cancellation lands, so the refusal above is the rule and not a
            // request this harness could never have terminalized.
            cancelRun(seeded, {
                run: ids.run,
                branch: ids.branch,
                turn: ids.turn,
                token: seeded.token,
                name: "scope-reached-signal"
            });
            expect(cancellationDeliveries(seeded).map((entry) => entry.cause.kind)).toEqual([
                "cancellation"
            ]);
        }
    );

    it(
        "[C13-TURN-HANDLE-DETACHMENT] names no failure kind for an item the Turn is still awaiting",
        { tags: "p0" },
        () => {
            // §5.6 draws the line at publication: an awaited item is owned by its Turn and
            // ends with it, which is C13-FACET-CANCELLATION-REACH's rule, not this one. So a
            // reservation the Turn never published reaches neither scope here.
            const seeded = seedRunningTurn();
            const awaited: RunObligation = {
                kind: "invocationItem",
                invocation: ITEM.invocation,
                itemIndex: ITEM.itemIndex,
                itemKey: ITEM.itemKey
            };
            seeded.runtime.reserveRunObligation(ids.run, awaited);

            const terminal = cancelRun(seeded, {
                run: ids.run,
                branch: ids.branch,
                turn: ids.turn,
                token: seeded.token,
                name: "scope-awaited"
            });
            expect(terminal.snapshot.obligation.obligations).toEqual([awaited]);
            expect(cancellationDeliveries(seeded)).toEqual([]);
        }
    );
});

describe("the derived ceiling that crosses the boundary", () => {
    it(
        "[C13-TURN-HANDLE-DETACHMENT] [C13-RUN-CEILING-REMAINDER] [C13-RUN-CEILING-EXHAUSTION] cancels an exhausted child through its own rows and not the ancestor that declared the bound",
        { tags: "p0" },
        () => {
            const seeded = seedRunningTurn();
            // The lineage a remainder is read from: the root Run declares nothing, the child
            // bounds depth and wall time, and the grandchild spends one level of the depth it
            // inherited by being spawned.
            const child = spawnChild(seeded, {
                name: "ceiling-child",
                parent: ids.run,
                token: seeded.token,
                limits: { depth: 1, wallClockMs: 1_000 }
            });
            const grandchild = spawnChild(seeded, {
                name: "ceiling-grandchild",
                parent: child.run,
                token: child.token,
                limits: { depth: 1 }
            });

            expect(seeded.runtime.remainingResources(child.run, CANCELLED_AT)?.limit("depth")).toBe(
                1
            );
            expect(
                seeded.runtime.remainingResources(grandchild.run, CANCELLED_AT)?.limit("depth")
            ).toBe(0);
            expect(seeded.runtime.exhaustedResource(grandchild.run, CANCELLED_AT)).toBe("depth");
            // Wall time comes from the spawn reservation written beside the root RunCommit, so
            // the same lineage answers it and the clock alone moves it.
            expect(
                seeded.runtime.remainingResources(child.run, CANCELLED_AT)?.limit("wallClockMs")
            ).toBe(900);
            expect(seeded.runtime.exhaustedResource(child.run, new Date(2_500))).toBe(
                "wallClockMs"
            );

            // The ancestor that declared the ceiling cannot cancel the Run that exhausted it.
            const ancestor = thrownBy(
                AgentCoreError,
                () =>
                    cancelRun(seeded, {
                        run: grandchild.run,
                        branch: child.branch,
                        turn: child.token.turn,
                        token: child.token,
                        name: "ceiling-ancestor",
                        exhausted: "depth"
                    }),
                "the declaring ancestor cancelling the exhausted child"
            );
            expect(ancestor.code).toBe("run.invalid-state");
            expect(requireRun(seeded, grandchild.run).lifecycle.kind).toBe("active");

            // The recorded dimension is the derived one, not one the caller asserts: a
            // dimension with allowance left is refused.
            const untrue = thrownBy(
                AgentCoreError,
                () =>
                    cancelRun(seeded, {
                        run: child.run,
                        branch: child.branch,
                        turn: child.token.turn,
                        token: child.token,
                        name: "ceiling-untrue",
                        exhausted: "depth"
                    }),
                "cancelling on a dimension with allowance left"
            );
            expect(untrue.code).toBe("run.invalid-state");
            expect(untrue.message).toMatch(/allowance left/);

            // The grandchild cancels itself, through its own Turn and its own lease, naming
            // the dimension its lineage says ran out.
            const terminal = cancelRun(seeded, {
                run: grandchild.run,
                branch: grandchild.branch,
                turn: grandchild.token.turn,
                token: grandchild.token,
                name: "ceiling-self",
                exhausted: "depth"
            });
            expect(terminal.snapshot.turn.equals(grandchild.token.turn)).toBe(true);
            expect([terminal.snapshot.outcome, terminal.snapshot.exhausted]).toEqual([
                "cancelled",
                "depth"
            ]);
            expect(requireRun(seeded, grandchild.run).lifecycle.exhausted).toBe("depth");
            // The ancestor that declared the bound is untouched by the child ending itself.
            expect(requireRun(seeded, child.run).lifecycle.kind).toBe("active");
        }
    );
});

describe("the durable outbox a lost response replays from", () => {
    it(
        "[C13-TURN-HANDLE-DETACHMENT] replays the same cancellation message after a lost response and a restart, and discharges it exactly once",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const records = new ItemRecords();
            await records.succeed(ITEM, OUTPUT);
            const handle = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, ITEM)
            );
            publish(seeded, handle, seeded.token);

            // The response is dropped on purpose: that is the failure this record exists for.
            // A terminal Run admits no second terminalization, so nothing could produce the
            // message again if it lived only in what terminalization returned.
            cancelRun(seeded, {
                run: ids.run,
                branch: ids.branch,
                turn: ids.turn,
                token: seeded.token,
                name: "outbox-response-loss"
            });

            const restarted = harness(seeded.storage.snapshot());
            const replayed = restarted.runtime.pendingInvocationDeliveries(ids.run);
            const cancellation = replayed.find((entry) => entry.cause.kind === "cancellation");
            expect(cancellation).toBeDefined();
            expect([
                cancellation?.run.value,
                cancellation?.invocation.value,
                cancellation?.itemIndex,
                cancellation?.itemKey,
                cancellation?.attempt.value
            ]).toEqual([
                ids.run.value,
                ITEM.invocation.value,
                ITEM.itemIndex,
                ITEM.itemKey,
                ITEM.attempt.value
            ]);
            expect(
                cancellation?.cause.terminalCommit?.equals(
                    new RunCommitId("commit-outbox-response-loss")
                )
            ).toBe(true);

            // The owner acknowledges after its own transaction, its response is lost too, and
            // it retries with the same message. At-least-once makes that the ordinary case, so
            // the second acknowledgement discharges nothing and refuses nothing.
            // A restarted harness holds no seeded Turn, so the Run is read through its own
            // repository rather than through the seeded reader.
            const restartedRevision = (): Revision =>
                restarted.repository.transaction((transaction) => {
                    const stored = restarted.repository.loadRun(transaction, ids.run);
                    if (stored === undefined) throw new TypeError("Expected a stored Run");
                    return stored.revision;
                });
            restarted.runtime.acknowledgeInvocationDelivery(cancellation!);
            const afterFirst = restartedRevision();
            restarted.runtime.acknowledgeInvocationDelivery(cancellation!);
            expect(restartedRevision().value).toBe(afterFirst.value);

            const reopened = harness(restarted.storage.snapshot());
            expect(
                reopened.runtime
                    .pendingInvocationDeliveries(ids.run)
                    .some((entry) => entry.cause.kind === "cancellation")
            ).toBe(false);
        }
    );

    it(
        "[C13-TURN-HANDLE-DETACHMENT] owes one admission message per published handle, and refuses a message of another Run",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const records = new ItemRecords();
            await records.succeed(ITEM, OUTPUT);
            const handle = await new TurnAdmissionVerifier(records).verify(
                admissionRequest(seeded, ITEM)
            );
            publish(seeded, handle, seeded.token);
            const first = requireRun(seeded, ids.run).revision;

            // Publishing the same handle is the same message. A host that appended again would
            // owe the owner two commands for one admitted item.
            publish(seeded, handle, seeded.token);
            expect(pendingDeliveries(seeded).map((entry) => entry.cause.kind)).toEqual([
                "admission"
            ]);
            expect(requireRun(seeded, ids.run).revision.value).toBe(first.value);

            // A message naming another Run is a caller addressing state it does not hold, so it
            // is refused rather than treated as a discharged duplicate.
            const foreign = new RunInvocationDelivery({
                run: new RunId("outbox-foreign-run"),
                invocation: ITEM.invocation,
                itemIndex: ITEM.itemIndex,
                itemKey: ITEM.itemKey,
                attempt: ITEM.attempt,
                cause: RunInvocationDeliveryCause.admission
            });
            // A message naming another Run is refused where it would be applied, and the
            // runtime path cannot even reach a Run that does not exist.
            const refused = thrownBy(
                AgentCoreError,
                () => {
                    requireRun(seeded, ids.run).acknowledgeDelivery(foreign);
                },
                "foreign delivery"
            );
            expect(refused.code).toBe("run.invalid-state");
            expect(refused.message).toMatch(/belongs to another Run/);
            const missing = thrownBy(
                AgentCoreError,
                () => {
                    seeded.runtime.acknowledgeInvocationDelivery(foreign);
                },
                "missing Run"
            );
            expect(missing.message).toMatch(/does not exist/);
            expect(pendingDeliveries(seeded)).toHaveLength(1);
        }
    );

    it(
        "[C13-TURN-HANDLE-DETACHMENT] [run.invocation-delivery] round-trips its own bytes and refuses every other shape",
        { tags: "p0" },
        () => {
            const admission = new RunInvocationDelivery({
                run: ids.run,
                invocation: ITEM.invocation,
                itemIndex: ITEM.itemIndex,
                itemKey: ITEM.itemKey,
                attempt: ITEM.attempt,
                cause: RunInvocationDeliveryCause.admission
            });
            const encoded = RunInvocationDelivery.codec.encode(admission);
            expect(RunInvocationDelivery.codec.decode(encoded).equals(admission)).toBe(true);

            // A cause carries exactly the fields its own case has, so a terminal commit on an
            // admission and a cancellation without one are both shapes that do not exist.
            expect(() =>
                RunInvocationDeliveryCause.fromData({
                    kind: "admission",
                    terminalCommit: "commit-outbox"
                })
            ).toThrow(TypeError);
            expect(() => RunInvocationDeliveryCause.fromData({ kind: "cancellation" })).toThrow(
                TypeError
            );
            expect(() => RunInvocationDeliveryCause.fromData({ kind: "aborted" })).toThrow(
                TypeError
            );

            // The refusal that keeps the Run out of §7.4's business: a failure kind is not a
            // field this record has, so a maintainer adding one turns this red.
            const data = mutableData(admission.toData());
            data["failure"] = "aborted";
            expect(() => RunInvocationDelivery.fromData(data)).toThrow(TypeError);

            // The identity covers every field, so a forged id cannot discharge another message.
            const forged = mutableData(admission.toData());
            forged["itemKey"] = "outbox-other-item";
            expect(() => RunInvocationDelivery.fromData(forged)).toThrow(TypeError);

            // One message twice is not an outbox a Run can hold.
            const stored = requireRun(seedRunningTurn(), ids.run);
            expect(
                () =>
                    new Run({
                        id: stored.id,
                        agent: stored.agent,
                        configuration: stored.configuration,
                        root: stored.root,
                        initialBranch: stored.initialBranch,
                        deliveries: [admission, admission],
                        revision: stored.revision
                    })
            ).toThrow(TypeError);
        }
    );
});
