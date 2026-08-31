import { describe, expect, it } from "vitest";
import { MemoryContentStore } from "../../../src/content";
import { ContentRef, Digest, Revision, encodeCanonicalJson } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { TurnId } from "../../../src/execution-references";
import { InvocationId } from "../../../src/interaction-references";
import { EffectAttemptId, ReceiptId } from "../../../src/invocation-references";
import { AdmittedInvocationItem } from "../../../src/invocations";
import {
    ResourceCeiling,
    SpawnAttenuation,
    widensResourceCeiling
} from "../../../src/agents/runs/ceiling";
import { requireObject } from "../../../src/agents/record-data";
import { RunCommit } from "../../../src/agents/runs/commit";
import {
    TurnAdmissionHandle,
    TurnAdmissionHandleCodec,
    TurnAdmissionIdentity,
    TurnAdmissionMessage,
    TurnAdmissionPublisher,
    TurnAdmissionRecordPort,
    TurnAdmissionReceiptFacts,
    TurnAdmissionVerifier,
    type TurnAdmissionAttemptFacts,
    type TurnAdmissionHandleInit
} from "../../../src/agents/runs/handle";
import {
    RunBranchId,
    RunId,
    SpawnReservationId,
    TurnInboxEntryId
} from "../../../src/agents/runs/id";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import { isSettled } from "../../../src/agents/runs/settlement";
import { SpawnReservation } from "../../../src/agents/runs/spawn";
import { Turn, TurnInboxEntry } from "../../../src/agents/runs/turn";
import { RunCommitId } from "../../../src/execution-references";
import {
    attenuationDigest,
    configuration,
    content,
    digest,
    harness,
    ids,
    mutableData,
    pins,
    refs,
    seedRunningTurn,
    settlementAuditKey,
    thrownBy
} from "./fixture";

const PUBLISHED_AT = new Date(1_500);
const ATTEMPT = new EffectAttemptId("handle-attempt");
const ITEM_KEY = "handle-item-key";
const CHILD_RUN = new RunId("handle-child-run");

type Seeded = ReturnType<typeof seedRunningTurn>;

/** What the §7.4 records say about the item under test, with every field a case can bend. */
interface RecordSpec {
    /** A pre-effect Receipt: the item never reached an EffectAttempt. */
    readonly preEffect?: string;
    /** An attempt Receipt that attempted and did not succeed, with its outcome. */
    readonly unsucceeded?: string;
    readonly attempt?: TurnAdmissionAttemptFacts;
    /** The bytes the result ContentRef is taken over. */
    readonly stored?: Uint8Array;
    /** Bytes served in place of the stored ones, for a Receipt whose content disagrees. */
    readonly served?: Uint8Array;
    readonly missing?: boolean;
}

/**
 * A Receipt-and-EffectAttempt stub over a real content store, so the digest the verifier
 * re-derives is the store's own. Nothing here decides admissibility: every rule under test
 * belongs to `TurnAdmissionVerifier`, which is the point of the seam being this narrow. The
 * three factories are the three shapes the records can take, so a case bends which shape it
 * returns rather than bending fields inside one shape.
 */
class StubRecords extends TurnAdmissionRecordPort {
    readonly #store = new MemoryContentStore();
    #ref: ContentRef | undefined;

    public constructor(private readonly spec: RecordSpec = {}) {
        super();
    }

    public async receipt(receipt: ReceiptId): Promise<TurnAdmissionReceiptFacts | undefined> {
        if (this.spec.missing === true) return undefined;
        if (this.spec.preEffect !== undefined) {
            return TurnAdmissionReceiptFacts.preEffect(this.spec.preEffect);
        }
        const attempt =
            this.spec.attempt ??
            Object.freeze({
                id: ATTEMPT,
                invocation: refs.invocation,
                itemIndex: 0,
                idempotencyKey: `${ITEM_KEY}:${receipt.value}`
            });
        if (this.spec.unsucceeded !== undefined) {
            return TurnAdmissionReceiptFacts.unsucceeded(attempt, this.spec.unsucceeded);
        }
        this.#ref ??= (
            await this.#store.put(this.spec.stored ?? encodeCanonicalJson({ value: 1 }))
        ).ref;
        return TurnAdmissionReceiptFacts.succeeded(attempt, this.#ref);
    }

    public async result(ref: ContentRef): Promise<Uint8Array> {
        return this.spec.served ?? this.#store.get(ref);
    }
}

function verifier(spec: RecordSpec = {}): TurnAdmissionVerifier {
    return new TurnAdmissionVerifier(new StubRecords(spec));
}

function admissionRequest(
    seeded: Seeded,
    overrides: Partial<{ impact: "observe" | "delegate" }> = {}
) {
    return {
        run: seeded.running.run,
        turn: seeded.running.id,
        token: seeded.token,
        impact: overrides.impact ?? ("observe" as const),
        invocation: refs.invocation,
        receipts: [refs.receipt]
    };
}

function handleInit(overrides: Partial<TurnAdmissionHandleInit> = {}): TurnAdmissionHandleInit {
    return {
        run: ids.run,
        turn: ids.turn,
        issuedEpoch: 1,
        invocation: refs.invocation,
        itemIndex: 0,
        itemKey: ITEM_KEY,
        attempt: ATTEMPT,
        identity: TurnAdmissionIdentity.invocation(refs.invocation),
        ...overrides
    };
}

/** The child RunRef identity a delegate spawn's Receipt admits, with that Receipt's evidence. */
function childIdentity(run: RunId = CHILD_RUN): TurnAdmissionIdentity {
    return TurnAdmissionIdentity.childRun(run, refs.receipt, digest("1"));
}

/** The publisher writes the Event payloads its inbox rows own, so it holds the Run's store. */
function publisher(value: Seeded | ReturnType<typeof harness>): TurnAdmissionPublisher<object> {
    return new TurnAdmissionPublisher(value.runtime, value.storage.content);
}

function terminalRequest(value: Seeded, commitId: string) {
    return {
        run: ids.run,
        turn: ids.turn,
        expectedRunRevision: value.repository.transaction((transaction) => {
            const run = value.repository.loadRun(transaction, ids.run);
            if (run === undefined) throw new TypeError("Expected seeded Run");
            return run.revision;
        }),
        expectedTurnRevision: value.repository.transaction((transaction) => {
            const turn = value.repository.loadTurn(transaction, ids.turn);
            if (turn === undefined) throw new TypeError("Expected seeded Turn");
            return turn.revision;
        }),
        expectedBranchRevision: new Revision(0),
        token: value.token,
        outcome: "succeeded" as const,
        commit: new RunCommit({
            id: new RunCommitId(commitId),
            run: ids.run,
            branch: ids.branch,
            kind: "result",
            parents: [ids.root],
            pins: pins(),
            writer: { kind: "turn", token: value.token },
            subjectTurn: ids.turn,
            content: content("f")
        }),
        siblingCancellations: new Map(),
        now: new Date(2_000)
    };
}

/** The addressed Turn's current revision, since every delivery advances it. */
function turnRevision(value: Seeded, turn: TurnId): Revision {
    return value.repository.transaction((transaction) => {
        const stored = value.repository.loadTurn(transaction, turn);
        if (stored === undefined) throw new TypeError("Expected a stored Turn");
        return stored.revision;
    });
}

/** A second running Turn on the seeded Run, for outcomes a later Turn reads as history. */
function laterTurn(value: Seeded, name: string) {
    const turn = new TurnId(name);
    const placement = new TurnPlacementSnapshot(turn, pins(), []);
    value.runtime.createTurn(
        {
            turn: new Turn({
                id: turn,
                run: ids.run,
                branch: ids.branch,
                startHead: ids.root,
                effectiveInput: ids.root,
                pins: pins(),
                placement: placement.digest,
                input: content("a"),
                revision: new Revision(0)
            }),
            placement
        },
        new Revision(0)
    );
    const running = value.runtime.claimTurn(
        turn,
        new Revision(0),
        ids.holder,
        new Date(1_000),
        new Date(5_000)
    );
    return { turn, running, token: Object.freeze({ turn, holder: ids.holder, epoch: 1 }) };
}

describe("Turn admission handle records", () => {
    it(
        "[turn.admission-handle] round-trips one canonical addressable admission identity",
        { tags: "p0" },
        () => {
            const handle = new TurnAdmissionHandle(handleInit());
            const decoded = TurnAdmissionHandleCodec.decode(
                TurnAdmissionHandleCodec.encode(handle)
            );

            expect(decoded).toEqual(handle);
            expect(decoded.equals(handle)).toBe(true);
            expect(Object.isFrozen(decoded)).toBe(true);
            expect(handle.toolPosition()).toEqual({ invocation: refs.invocation.value });
            expect(handle.address).toBe(`invocation:${refs.invocation.value}`);
            expect(handle.obligation()).toEqual({
                kind: "invocationItem",
                invocation: refs.invocation,
                itemIndex: 0,
                itemKey: ITEM_KEY
            });
        }
    );

    it(
        "[turn.admission-handle] refuses an unknown field and a missing field",
        { tags: "p1" },
        () => {
            const handle = new TurnAdmissionHandle(handleInit());
            const extra = mutableData({ record: handle.toData() });
            extra["surplus"] = 1;
            expect(() => TurnAdmissionHandle.fromData(extra)).toThrow(TypeError);

            const missing = mutableData({ record: handle.toData() });
            delete missing["itemKey"];
            expect(() => TurnAdmissionHandle.fromData(missing)).toThrow(TypeError);
        }
    );

    it.each([
        ["a negative lease epoch", { issuedEpoch: -1 }],
        ["a fractional lease epoch", { issuedEpoch: 1.5 }],
        ["a negative item index", { itemIndex: -1 }],
        ["an empty item key", { itemKey: "" }],
        ["a child Run equal to its own Run", { identity: childIdentity(ids.run) }]
    ] as const)("refuses %s", { tags: "p1" }, (_label, overrides) => {
        expect(() => new TurnAdmissionHandle(handleInit(overrides))).toThrow(TypeError);
    });

    it("renders each identity kind's own tool position and address", { tags: "p1" }, () => {
        const child = childIdentity();
        const invocation = TurnAdmissionIdentity.invocation(refs.invocation);

        expect(child.toolPosition()).toEqual({ run: CHILD_RUN.value });
        expect(child.address).toBe(`run:${CHILD_RUN.value}`);
        expect(child.childRun?.equals(CHILD_RUN)).toBe(true);
        expect(invocation.childRun).toBeUndefined();
        expect(child.equals(invocation)).toBe(false);
        expect(TurnAdmissionIdentity.fromData(child.toData()).equals(child)).toBe(true);
        expect(TurnAdmissionIdentity.fromData(invocation.toData()).equals(invocation)).toBe(true);
        expect(() => TurnAdmissionIdentity.fromData({ kind: "turn", reference: "x" })).toThrow(
            TypeError
        );
    });

    it(
        "[C13-TURN-HANDLE-DETACHMENT] keeps the spawn Receipt on the one identity that has one",
        { tags: "p0" },
        () => {
            const child = childIdentity();
            const invocation = TurnAdmissionIdentity.invocation(refs.invocation);

            // The child RunRef commits at the spawn Receipt, so it carries that Receipt and
            // the digest of its result. The Invocation identity commits at admission, where no
            // Receipt exists, so there is no field on it for one to hide in.
            expect(child.toData()).toEqual({
                kind: "childRun",
                receipt: refs.receipt.value,
                reference: CHILD_RUN.value,
                result: digest("1").value
            });
            expect(invocation.toData()).toEqual({
                kind: "invocation",
                reference: refs.invocation.value
            });

            // Each case decodes exactly its own fields, so neither shape can borrow the
            // other's: an Invocation identity carrying a Receipt is refused outright.
            expect(() =>
                TurnAdmissionIdentity.fromData({
                    kind: "invocation",
                    reference: refs.invocation.value,
                    receipt: refs.receipt.value,
                    result: digest("1").value
                })
            ).toThrow(TypeError);
            const missing = mutableData({ record: child.toData() });
            delete missing["result"];
            expect(() => TurnAdmissionIdentity.fromData(missing)).toThrow(TypeError);

            // Two child identities over the same Run but different spawn Receipts are not the
            // same identity, so the evidence is part of what the handle's bytes commit.
            expect(
                child.equals(
                    TurnAdmissionIdentity.childRun(
                        CHILD_RUN,
                        new ReceiptId("handle-other-receipt"),
                        digest("1")
                    )
                )
            ).toBe(false);
        }
    );
});

describe("verified admission identities", () => {
    it(
        "[C13-TURN-HANDLE-DETACHMENT] builds an Invocation handle from an admitted item and reads no Receipt",
        { tags: "p0" },
        () => {
            const seeded = seedRunningTurn();
            // §5.6 commits an Invocation identity at admission, which is a durable
            // EffectAttempt that no Receipt names yet. A records seam that answers nothing
            // proves the path never asks it: a handle still comes back.
            const refusing = new TurnAdmissionVerifier(new StubRecords({ missing: true }));
            const item = new AdmittedInvocationItem({
                invocation: refs.invocation,
                itemIndex: 2,
                itemKey: ITEM_KEY,
                attempt: ATTEMPT
            });

            const handle = refusing.admit(
                { run: seeded.running.run, turn: seeded.running.id, token: seeded.token },
                item
            );

            expect(handle.toolPosition()).toEqual({ invocation: refs.invocation.value });
            expect(handle.identity.childRun).toBeUndefined();
            expect([handle.invocation.value, handle.itemIndex, handle.itemKey]).toEqual([
                refs.invocation.value,
                2,
                ITEM_KEY
            ]);
            expect(handle.attempt.equals(ATTEMPT)).toBe(true);
            expect(handle.issuedEpoch).toBe(seeded.token.epoch);
            expect(handle.obligation()).toEqual({
                kind: "invocationItem",
                invocation: refs.invocation,
                itemIndex: 2,
                itemKey: ITEM_KEY
            });
            // The same bytes survive a process, which is what a detached item needs.
            expect(
                TurnAdmissionHandleCodec.decode(TurnAdmissionHandleCodec.encode(handle)).equals(
                    handle
                )
            ).toBe(true);
        }
    );

    it(
        "[C13-TURN-EXACT-LEASE] refuses an admitted item presented under another Turn's lease",
        { tags: "p0" },
        () => {
            const seeded = seedRunningTurn();
            const item = new AdmittedInvocationItem({
                invocation: refs.invocation,
                itemIndex: 0,
                itemKey: ITEM_KEY,
                attempt: ATTEMPT
            });

            expect(
                thrownBy(
                    AgentCoreError,
                    () =>
                        verifier().admit(
                            {
                                run: seeded.running.run,
                                turn: seeded.running.id,
                                token: { ...seeded.token, turn: new TurnId("other-turn") }
                            },
                            item
                        ),
                    "admitted item under a foreign lease"
                ).code
            ).toBe("lease.invalid");
        }
    );

    it(
        "[C13-TURN-ADMISSION-HANDLE] names the mediated Invocation and the exact evidence it was built from",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const handle = await verifier().verify(admissionRequest(seeded));

            // The identity the model reads is the Invocation's, and every field of the handle
            // is a record the pipeline already wrote: nothing here is issued by the handle.
            expect(handle.toolPosition()).toEqual({ invocation: refs.invocation.value });
            expect(handle.invocation.equals(refs.invocation)).toBe(true);
            expect(handle.attempt.equals(ATTEMPT)).toBe(true);
            expect(handle.itemKey).toBe(`${ITEM_KEY}:${refs.receipt.value}`);
            expect(handle.turn.equals(seeded.running.id)).toBe(true);
            expect(handle.issuedEpoch).toBe(seeded.token.epoch);
            // An Invocation identity names the admitted item and no outcome, so no Receipt or
            // result rides along on the record a later process decodes.
            expect(Object.keys(requireObject(handle.toData(), "admission handle"))).toEqual([
                "attempt",
                "identity",
                "invocation",
                "issuedEpoch",
                "itemIndex",
                "itemKey",
                "run",
                "turn"
            ]);
        }
    );

    it(
        "[C13-TURN-ADMISSION-HANDLE] names the child RunRef for a delegate Receipt that carries only that",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const handle = await verifier({
                stored: encodeCanonicalJson({ run: CHILD_RUN.value })
            }).verify(admissionRequest(seeded, { impact: "delegate" }));

            expect(handle.toolPosition()).toEqual({ run: CHILD_RUN.value });
            expect(handle.identity.childRun?.equals(CHILD_RUN)).toBe(true);
            expect(handle.address).toBe(`run:${CHILD_RUN.value}`);
            // The Receipt that carried the child RunRef, and the digest of the bytes it
            // carried it in, ride on the identity that could not exist without them.
            expect(handle.identity.toData()).toEqual({
                kind: "childRun",
                receipt: refs.receipt.value,
                reference: CHILD_RUN.value,
                result: Digest.sha256(encodeCanonicalJson({ run: CHILD_RUN.value })).value
            });
        }
    );

    it(
        "[C13-TURN-ADMISSION-HANDLE] refuses a delegate Receipt carrying the child's output beside its RunRef",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            // §5.6: a spawn's delegate Receipt carries the child RunRef, never the child's
            // result. A payload naming both is the exact confusion the rule forbids, so it is
            // refused rather than read as a handle plus extra output.
            await expect(
                verifier({
                    stored: encodeCanonicalJson({ run: CHILD_RUN.value, output: { done: true } })
                }).verify(admissionRequest(seeded, { impact: "delegate" }))
            ).rejects.toThrow(TypeError);
        }
    );

    it(
        "[C13-TURN-ADMISSION-HANDLE] treats a delegate result that names no child Run as an ordinary Invocation identity",
        { tags: "p1" },
        async () => {
            const seeded = seedRunningTurn();
            // Delegation is not always a spawn: authored-code submission is delegate-impact and
            // returns a value, so its handle names the Invocation.
            const handle = await verifier({
                stored: encodeCanonicalJson({ value: 7 })
            }).verify(admissionRequest(seeded, { impact: "delegate" }));

            expect(handle.toolPosition()).toEqual({ invocation: refs.invocation.value });
        }
    );

    it.each([
        [
            "evidence names no stored Receipt",
            { missing: true },
            "invocation.invalid",
            /no stored Receipt/
        ],
        [
            "the item never reached an EffectAttempt",
            { preEffect: "deniedPreEffect" },
            "invocation.invalid",
            /reached no EffectAttempt: deniedPreEffect/
        ],
        [
            "the EffectAttempt attempted and did not succeed",
            { unsucceeded: "indeterminate" },
            "invocation.invalid",
            /did not succeed: indeterminate/
        ],
        [
            "the EffectAttempt belongs to another Invocation",
            {
                attempt: {
                    id: ATTEMPT,
                    invocation: new InvocationId("other-invocation"),
                    itemIndex: 0,
                    idempotencyKey: ITEM_KEY
                }
            },
            "invocation.invalid",
            /another Invocation's EffectAttempt/
        ],
        [
            "the served bytes do not hash to the Receipt's content",
            { served: encodeCanonicalJson({ value: 2 }) },
            "invocation.invalid",
            /do not hash to the Receipt's content/
        ],
        [
            // Canonicality is the codec's answer, not a second check in the verifier, so the
            // refusal arrives with the codec's own code rather than one this layer restates.
            "the result content is not in canonical form",
            { stored: new TextEncoder().encode('{"b":1,"a":2}') },
            "codec.invalid",
            /not in canonical form/
        ]
    ] as const)(
        "[C13-TURN-ADMISSION-HANDLE] refuses a handle when %s",
        { tags: "p0" },
        async (_label, spec, code, message) => {
            const seeded = seedRunningTurn();
            await expect(verifier(spec).verify(admissionRequest(seeded))).rejects.toMatchObject({
                code,
                message: expect.stringMatching(message)
            });
        }
    );

    it(
        "[C13-TURN-ADMISSION-HANDLE] refuses evidence naming more or fewer than one item Receipt",
        { tags: "p1" },
        async () => {
            const seeded = seedRunningTurn();
            const outcomes = await Promise.all(
                [[], [refs.receipt, new ReceiptId("second-receipt")]].map((receipts) =>
                    verifier()
                        .verify({ ...admissionRequest(seeded), receipts })
                        .then(
                            () => "admitted",
                            (error: Error) =>
                                error instanceof AgentCoreError ? error.code : error.name
                        )
                )
            );

            expect(outcomes).toEqual(["invocation.invalid", "invocation.invalid"]);
        }
    );

    it(
        "[C13-TURN-EXACT-LEASE] refuses a lease token naming another Turn",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            await expect(
                verifier().verify({
                    ...admissionRequest(seeded),
                    token: { ...seeded.token, turn: new TurnId("other-turn") }
                })
            ).rejects.toMatchObject({ code: "lease.invalid" });
        }
    );
});

describe("distinguishing the admission Receipt shapes", () => {
    it(
        "[C13-TURN-ADMISSION-FACTS-DISTINCT] refuses a pre-effect denial and an unsuccessful attempt with different reasons",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const reason = async (spec: RecordSpec): Promise<string> =>
                verifier(spec)
                    .verify(admissionRequest(seeded))
                    .then(
                        () => "admitted",
                        (error: Error) => error.message
                    );

            const denial = await reason({ preEffect: "deniedPreEffect" });
            const unsucceeded = await reason({ unsucceeded: "indeterminate" });

            // Neither admits, and a caller told only "not succeeded" could not tell which
            // of the two it presented. The seam answers the question it was asked.
            expect(denial).toMatch(/reached no EffectAttempt: deniedPreEffect/);
            expect(unsucceeded).toMatch(/did not succeed: indeterminate/);
            expect(denial).not.toEqual(unsucceeded);
        }
    );

    it(
        "[C13-TURN-ADMISSION-FACTS-DISTINCT] admits the succeeded shape alone, carrying both the attempt and its result",
        { tags: "p1" },
        () => {
            const attempt: TurnAdmissionAttemptFacts = Object.freeze({
                id: ATTEMPT,
                invocation: refs.invocation,
                itemIndex: 0,
                idempotencyKey: ITEM_KEY
            });
            const result = content("1");

            expect(TurnAdmissionReceiptFacts.succeeded(attempt, result).admit()).toEqual({
                attempt,
                result
            });
            expect(() => TurnAdmissionReceiptFacts.preEffect("cancelledPreEffect").admit()).toThrow(
                /reached no EffectAttempt/
            );
            expect(() => TurnAdmissionReceiptFacts.unsucceeded(attempt, "failed").admit()).toThrow(
                /did not succeed/
            );
        }
    );
});

describe("addressing an admitted item", () => {
    it(
        "[C13-TURN-ADMISSION-HANDLE] addresses the same Turn after its bytes outlive the process",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const handle = await verifier().verify(admissionRequest(seeded));
            const bytes = TurnAdmissionHandleCodec.encode(handle);

            // A fresh runtime over the same durable state is what a restart looks like from
            // here: nothing of the issuing process survives except these bytes.
            const restarted = harness(seeded.storage.snapshot());
            const recovered = TurnAdmissionHandleCodec.decode(bytes);
            expect(recovered.turn.equals(seeded.running.id)).toBe(true);

            const reservation = publisher(restarted).publish(recovered, seeded.token, PUBLISHED_AT);
            expect(reservation.obligation).toEqual(recovered.obligation());
            expect(restarted.runtime.acceptsRunAdmission(reservation)).toBe(true);
        }
    );

    it(
        "[C13-TURN-EXACT-LEASE] refuses every write a handle attempts without the Turn's current lease",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const handle = await verifier().verify(admissionRequest(seeded));
            const publish = publisher(seeded);

            // Presenting an epoch the Turn never issued the handle at is refused outright.
            const forged = thrownBy(
                AgentCoreError,
                () =>
                    publish.publish(
                        handle,
                        { ...seeded.token, epoch: seeded.token.epoch + 1 },
                        PUBLISHED_AT
                    ),
                "forged epoch publish"
            );
            expect(forged.code).toBe("lease.invalid");

            // A handle whose own epoch matches still writes nothing once that lease has
            // expired: the handle records provenance, and only a live lease admits a write.
            const expired = thrownBy(
                AgentCoreError,
                () => publish.publish(handle, seeded.token, new Date(6_000)),
                "expired lease publish"
            );
            expect(expired.code).toBe("lease.invalid");

            // A takeover fences the displaced holder and advances the epoch, so the handle is
            // now stale against a lease that is itself perfectly live — the sharpest form of
            // the rule, because the token presented is the current one and it is the handle
            // that no longer belongs.
            const reclaimed = seeded.runtime.reclaimTurn(
                ids.turn,
                seeded.running.revision,
                ids.holder,
                new Date(6_000),
                new Date(20_000),
                new TurnInboxEntry(
                    new TurnInboxEntryId("handle-takeover"),
                    ids.turn,
                    0,
                    "turn.cancel",
                    content("b"),
                    digest("b"),
                    "handle-takeover-key",
                    seeded.token,
                    new Date(6_000)
                )
            );
            const live = Object.freeze({
                turn: ids.turn,
                holder: ids.holder,
                epoch: reclaimed.lease.epoch
            });
            expect(live.epoch).toBe(handle.issuedEpoch + 1);
            const stale = thrownBy(
                AgentCoreError,
                () => publish.publish(handle, live, new Date(6_100)),
                "stale handle publish"
            );
            expect(stale.code).toBe("lease.invalid");

            // The same live lease admits a handle issued under it, so the refusals above are
            // the handle's staleness and not a publisher that never writes.
            const reissued = await verifier().verify({
                ...admissionRequest(seeded),
                token: live
            });
            expect(publish.publish(reissued, live, new Date(6_100)).obligation).toEqual(
                reissued.obligation()
            );
        }
    );

    it(
        "[C13-TURN-NO-RETRY] cannot address a terminal Turn and offers no way to recreate one",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const handle = await verifier().verify(admissionRequest(seeded));
            const publish = publisher(seeded);
            seeded.runtime.terminalizeRun(terminalRequest(seeded, "handle-terminal"));

            const refused = thrownBy(
                AgentCoreError,
                () => publish.publish(handle, seeded.token, new Date(2_100)),
                "terminal publish"
            );
            expect(refused.code).toBe("lease.invalid");

            await expect(
                publish.deliver({
                    handle,
                    turn: handle.turn,
                    expected: turnRevision(seeded, ids.turn),
                    token: seeded.token,
                    message: TurnAdmissionMessage.outcome({ done: true }),
                    now: new Date(2_100)
                })
            ).rejects.toMatchObject({ code: "lease.invalid" });

            // Both refusals are Turn.requireToken's: a terminal Turn is not running and holds
            // no lease, so a handle can still name the work and can author nothing. The claim
            // that no Turn-retry symbol exists anywhere is C13-TURN-NO-RETRY-EXPORT's and its
            // sibling gates', not something a method-name assertion here could witness.
        }
    );

    it(
        "[C13-TURN-CANCEL-INBOX] delivers steering and outcomes as ordinary inbox Events, never as cancellation",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const handle = await verifier().verify(admissionRequest(seeded));
            const publish = publisher(seeded);
            const revision = () => turnRevision(seeded, ids.turn);

            const steering = await publish.deliver({
                handle,
                turn: handle.turn,
                expected: revision(),
                token: seeded.token,
                message: TurnAdmissionMessage.steering("nonce-1", { hint: "prefer speed" }),
                now: PUBLISHED_AT
            });

            expect(steering.event).toBe("admission.steering");
            expect(steering.idempotencyKey).toBe(
                JSON.stringify([handle.address, "steering", "nonce-1"])
            );
            expect(steering.cancellationToken).toBeUndefined();
            expect(steering.sequence).toBe(0);

            const outcome = await publish.deliver({
                handle,
                turn: handle.turn,
                expected: revision(),
                token: seeded.token,
                message: TurnAdmissionMessage.outcome({ ok: true }),
                now: PUBLISHED_AT
            });
            expect([outcome.event, outcome.sequence]).toEqual(["admission.outcome", 1]);

            // At-least-once delivery is keyed on the handle, so a repeat of the same message
            // is refused rather than appended twice.
            await expect(
                publish.deliver({
                    handle,
                    turn: handle.turn,
                    expected: revision(),
                    token: seeded.token,
                    message: TurnAdmissionMessage.outcome({ ok: true }),
                    now: PUBLISHED_AT
                })
            ).rejects.toMatchObject({ code: "turn.invalid-state" });

            // The Turn is still running: an addressed Event is not a fence.
            expect(
                seeded.repository.transaction(
                    (transaction) => seeded.repository.loadTurn(transaction, ids.turn)?.status.kind
                )
            ).toBe("running");
        }
    );

    it(
        "[C13-TURN-ADMISSION-HANDLE] delivers an outcome to a later Turn and to no Turn outside its Run",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const handle = await verifier().verify(admissionRequest(seeded));
            const later = laterTurn(seeded, "turn-later");
            const publish = publisher(seeded);

            // §5.6: the outcome of detached work is read by a later Turn as ordinary history
            // when the issuing Turn ends first.
            const delivered = await publish.deliver({
                handle,
                turn: later.turn,
                expected: later.running.revision,
                token: later.token,
                message: TurnAdmissionMessage.outcome({ answer: 42 }),
                now: PUBLISHED_AT
            });
            expect(delivered.turn.equals(later.turn)).toBe(true);

            // The addressed Turn's own lease is what authorizes the write; the issuing Turn's
            // token is not a key to it.
            await expect(
                publish.deliver({
                    handle,
                    turn: later.turn,
                    expected: turnRevision(seeded, later.turn),
                    token: seeded.token,
                    message: TurnAdmissionMessage.steering("nonce-2", {}),
                    now: PUBLISHED_AT
                })
            ).rejects.toMatchObject({ code: "lease.invalid" });

            // A child Run is a settlement unit of its own, and a parent's handle is not reach
            // into it: the same handle cannot address a Turn outside the Run it detached into,
            // even holding that Turn's live lease.
            const child = spawnChild(seeded, "handle-foreign", ids.run, seeded.token, {
                tokens: 100
            });
            await expect(
                publish.deliver({
                    handle,
                    turn: child.token.turn,
                    expected: turnRevision(seeded, child.token.turn),
                    token: child.token,
                    message: TurnAdmissionMessage.outcome({}),
                    now: PUBLISHED_AT
                })
            ).rejects.toMatchObject({ code: "turn.invalid-state" });
        }
    );
});

describe("handle lifetime and Run terminalization", () => {
    it(
        "[C13-RUN-SETTLED-DERIVED] lets the issuing Turn terminalize while withholding Settled for the outstanding item",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const handle = await verifier().verify(admissionRequest(seeded));
            publisher(seeded).publish(handle, seeded.token, PUBLISHED_AT);

            // §5.6: a handle detaches work from the Turn that issued it, and ending that Turn
            // is the ordinary case the shape exists for. A live handle is therefore a hold on
            // the Run's admission frontier, never on a Turn — terminalization succeeds and
            // captures the item, and Settled is what waits.
            const { snapshot } = seeded.runtime.terminalizeRun(
                terminalRequest(seeded, "handle-live")
            );
            expect(snapshot.obligation.obligations).toEqual([handle.obligation()]);
            expect(seeded.runtime.settled(ids.run)).toBe(false);

            seeded.settlement.terminalItems.add(
                `${handle.invocation.value}:${handle.itemIndex}:${handle.itemKey}`
            );
            for (const audit of snapshot.obligation.requiredAudits) {
                seeded.settlement.audits.add(settlementAuditKey(audit));
            }
            expect(seeded.runtime.settled(ids.run)).toBe(true);
            expect(
                isSettled(
                    seeded.repository.transaction((transaction) => transaction),
                    snapshot.obligation,
                    seeded.settlement
                )
            ).toBe(true);
        }
    );

    it(
        "[C13-RUN-FRONTIER-EMPTY] settles at once when the handle is released before terminalization",
        { tags: "p0" },
        async () => {
            const seeded = seedRunningTurn();
            const handle = await verifier().verify(admissionRequest(seeded));
            const publish = publisher(seeded);
            const reservation = publish.publish(handle, seeded.token, PUBLISHED_AT);

            publish.settle(reservation);

            const { snapshot } = seeded.runtime.terminalizeRun(
                terminalRequest(seeded, "handle-released")
            );
            expect(snapshot.obligation.obligations).toEqual([]);
            expect(seeded.runtime.settled(ids.run)).toBe(true);
        }
    );
});

describe("child admission and the parent ceiling", () => {
    it(
        "[C13-TURN-ADMISSION-HANDLE] names only a child the parent's remaining ceiling admitted",
        { tags: "p0" },
        async () => {
            const root = seedRunningTurn();
            const parent = spawnChild(root, "handle-parent", ids.run, root.token, {
                tokens: 100
            });
            root.runtime.recordModelUsage(parent.run, 40);
            const remaining = root.runtime.remainingResources(parent.run, new Date(1_600));
            expect(remaining?.limit("tokens")).toBe(60);

            // A widening spawn never happens, so no Run exists for a handle to name. The
            // handle carries no authority that could have admitted it.
            const widened = thrownBy(
                AgentCoreError,
                () => spawnChild(root, "handle-wider", parent.run, parent.token, { tokens: 61 }),
                "widened spawn"
            );
            expect(widened.code).toBe("authority.denied");
            const absent = new TurnAdmissionHandle(
                handleInit({
                    run: parent.run,
                    turn: parent.token.turn,
                    identity: childIdentity(new RunId("run-handle-wider"))
                })
            );
            expect(
                root.repository.transaction((transaction) =>
                    root.repository.loadRun(transaction, absent.identity.childRun!)
                )
            ).toBeUndefined();

            const child = spawnChild(root, "handle-child", parent.run, parent.token, {
                tokens: 10
            });
            const handle = await verifier({
                stored: encodeCanonicalJson({ run: child.run.value })
            }).verify({
                run: parent.run,
                turn: parent.token.turn,
                token: parent.token,
                impact: "delegate",
                invocation: refs.invocation,
                receipts: [refs.receipt]
            });

            expect(handle.identity.childRun?.equals(child.run)).toBe(true);
            const childRemaining = root.runtime.remainingResources(child.run, new Date(1_600));
            expect(childRemaining?.limit("tokens")).toBe(10);
            expect(widensResourceCeiling(remaining, childRemaining!)).toBe(false);
        }
    );
});

/** Spawns a child Run under `parent`, declaring `limits` as its attenuated ceiling. */
function spawnChild(
    value: Seeded,
    name: string,
    parent: RunId,
    token: Seeded["token"],
    limits: ConstructorParameters<typeof ResourceCeiling>[0]
) {
    const snapshot = configuration();
    const run = new RunId(`run-${name}`);
    const branch = new RunBranchId(`branch-${name}`);
    const root = new RunCommit({
        id: new RunCommitId(`commit-${name}`),
        run,
        branch,
        kind: "root",
        parents: [],
        pins: snapshot.pins,
        writer: { kind: "root" },
        content: content("4"),
        treeCheckpoint: content("e")
    });
    const attenuation = new SpawnAttenuation({ ceiling: new ResourceCeiling(limits) });
    const reservation = new SpawnReservation(
        new SpawnReservationId(`spawn-${name}`),
        parent,
        token.turn,
        run,
        token,
        snapshot.id,
        root.content!,
        refs.invocation,
        refs.receipt,
        attenuationDigest(attenuation),
        new Date(1_500)
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
                parent,
                revision: new Revision(0)
            }),
            configuration: snapshot,
            branch: new RunBranch(branch, run, "main", root.id, new Revision(0)),
            root
        },
        new Date(1_500)
    );
    const turn = new TurnId(`turn-${name}`);
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
    value.runtime.claimTurn(turn, new Revision(0), ids.holder, new Date(1_000), new Date(500_000));
    return { run, branch, token: Object.freeze({ turn, holder: ids.holder, epoch: 1 }) };
}
