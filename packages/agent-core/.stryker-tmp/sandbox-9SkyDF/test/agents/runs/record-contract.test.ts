// @ts-nocheck
import { describe, expect, it } from "vitest";
import { Revision } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { FacetRef } from "../../../src/facets";
import { RunCommitId, TurnId } from "../../../src/execution-references";
import {
    compareText,
    digestFromData,
    requireArray,
    requireExactFields,
    requireInteger,
    requireObject,
    requireOptionalString,
    requireString,
    requireTimestamp,
    revisionData,
    revisionFromData
} from "../../../src/agents/record-data";
import { RunCommit } from "../../../src/agents/runs/commit";
import { RunAdmissionRegistry } from "../../../src/agents/runs/admission";
import {
    RunCheckpointId,
    RunId,
    SpawnReservationId,
    TurnInboxEntryId
} from "../../../src/agents/runs/id";
import { TurnLease } from "../../../src/agents/runs/lease";
import { RunPins, RunConfigurationSnapshot } from "../../../src/agents/runs/pins";
import { PlacementPin, TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import { SettlementObligation, TerminalSnapshot } from "../../../src/agents/runs/settlement";
import { SpawnReservation } from "../../../src/agents/runs/spawn";
import { RunCheckpoint, Turn, TurnInboxEntry, TurnStatus } from "../../../src/agents/runs/turn";
import {
    AgentPolicyRevisionRecord,
    AgentRevisionRecord,
    ModelPolicyRevisionRecord
} from "../../../src/agents/source";
import { configuration, content, digest, genesis, ids, pins, refs, sourceRecords } from "./fixture";

interface StaticCodec<Value extends object> {
    readonly codec: unknown;
    encode(value: Value): Uint8Array;
    decode(bytes: Uint8Array): Value;
}

function assertRecord<Value extends object>(type: StaticCodec<Value>, value: Value): Value {
    expect(type.codec).toBeDefined();
    expect(Object.isFrozen(value)).toBe(true);
    const decoded = type.decode(type.encode(value));
    expect(Object.isFrozen(decoded)).toBe(true);
    return decoded;
}

describe("uniform durable record contract", () => {
    it("[agent.revision] [agent.policy-revision] [agent.model-revision] provides static codec, encode, decode, and frozen source records", () => {
        const source = sourceRecords();
        assertRecord(AgentRevisionRecord, source.agent);
        assertRecord(AgentPolicyRevisionRecord, source.policy);
        assertRecord(ModelPolicyRevisionRecord, source.model);
    });

    it("[run.pins] [run.configuration-snapshot] [run.commit] [run.record] [run.branch] [turn.record] [turn.placement-snapshot] [run.checkpoint] [turn.inbox-entry] [run.admission-registry] [run.settlement-obligation] [run.terminal-snapshot] [run.spawn-reservation] provides the same contract for every Run-owned record", () => {
        const base = genesis();
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        const turn = new Turn({
            id: ids.turn,
            run: ids.run,
            branch: ids.branch,
            startHead: ids.root,
            effectiveInput: ids.root,
            pins: pins(),
            placement: placement.digest,
            input: content("a"),
            revision: new Revision(0)
        });
        const checkpoint = new RunCheckpoint(
            new RunCheckpointId("record-checkpoint"),
            ids.turn,
            ids.root,
            content("b"),
            0,
            undefined
        );
        const inbox = new TurnInboxEntry(
            new TurnInboxEntryId("record-inbox"),
            ids.turn,
            0,
            "message",
            content("c"),
            digest("c"),
            "record-key",
            undefined,
            new Date(1000)
        );
        const obligation = new SettlementObligation({
            registryEpoch: 1,
            obligations: [
                {
                    kind: "invocationItem",
                    invocation: refs.invocation,
                    itemIndex: 0,
                    itemKey: "record-item"
                },
                { kind: "route", reservation: refs.route },
                { kind: "systemCommit", commit: new RunCommitId("required") }
            ]
        });
        const terminal = new TerminalSnapshot(
            ids.run,
            ids.turn,
            ids.root,
            new RunCommitId("terminal"),
            "succeeded",
            obligation,
            new Date(2000)
        );
        const spawn = new SpawnReservation(
            new SpawnReservationId("spawn-record"),
            ids.run,
            ids.turn,
            new RunId("child-record"),
            { turn: ids.turn, holder: ids.holder, epoch: 1 },
            configuration().id,
            content("d"),
            refs.invocation,
            refs.receipt,
            digest("d"),
            new Date(3000)
        );

        assertRecord(RunPins, pins());
        assertRecord(RunConfigurationSnapshot, configuration());
        assertRecord(RunCommit, base.root);
        assertRecord(Run, base.run);
        assertRecord(RunBranch, base.branch);
        assertRecord(Turn, turn);
        assertRecord(TurnPlacementSnapshot, placement);
        assertRecord(RunCheckpoint, checkpoint);
        assertRecord(TurnInboxEntry, inbox);
        assertRecord(RunAdmissionRegistry, RunAdmissionRegistry.initial(ids.run));
        assertRecord(SettlementObligation, obligation);
        assertRecord(TerminalSnapshot, terminal);
        const decodedSpawn = assertRecord<SpawnReservation>(SpawnReservation, spawn);
        expect(decodedSpawn.recordedAt.getTime()).toBe(3000);
        expect(
            TurnLease.decode(TurnLease.encode(TurnLease.unclaimed(ids.turn))).turn.equals(ids.turn)
        ).toBe(true);
        expect((turn.toData() as { lease: unknown }).lease).toEqual(TurnLease.toData(turn.lease));
    });

    it("defensively copies arrays, nested evidence, tokens, and dates", () => {
        const packages = [...pins().packages];
        const value = new RunPins({ ...pins(), packages });
        packages.pop();
        expect(value.packages).toHaveLength(2);

        const obligations = [
            {
                kind: "invocationItem" as const,
                invocation: refs.invocation,
                itemIndex: 0,
                itemKey: "defensive-item"
            }
        ];
        const obligation = new SettlementObligation({
            registryEpoch: 1,
            obligations
        });
        obligations.pop();
        expect(obligation.obligations).toHaveLength(1);

        const token = { turn: ids.turn, holder: ids.holder, epoch: 1 };
        const at = new Date(1000);
        const inbox = new TurnInboxEntry(
            new TurnInboxEntryId("defensive"),
            ids.turn,
            0,
            "turn.cancel",
            content("e"),
            digest("e"),
            "defensive",
            token,
            at
        );
        token.epoch = 9;
        at.setTime(9000);
        expect(inbox.cancellationToken?.epoch).toBe(1);
        expect(inbox.recordedAt.getTime()).toBe(1000);
        const returned = inbox.recordedAt;
        returned.setTime(5000);
        expect(inbox.recordedAt.getTime()).toBe(1000);
        expect(Object.isFrozen(genesis().run.lifecycle)).toBe(true);
        expect(Object.isFrozen(TurnStatus.queued)).toBe(true);
    });
});

describe("record data shape helpers", () => {
    it("accepts valid values and rejects every malformed category", () => {
        expect(requireObject({}, "object")).toEqual({});
        for (const value of [null, [], "string"] as const) {
            expect(() => requireObject(value as never, "object")).toThrow(TypeError);
        }
        expect(() => requireExactFields({}, ["required"], [], "fields")).toThrow(TypeError);
        expect(() => requireExactFields({ extra: true }, [], [], "fields")).toThrow(TypeError);
        expect(() => requireString("", "string")).toThrow(TypeError);
        expect(requireOptionalString(undefined, "optional")).toBeUndefined();
        expect(requireOptionalString(null, "optional")).toBeUndefined();
        expect(requireOptionalString("value", "optional")).toBe("value");
        for (const value of ["1", -1, 1.5]) {
            expect(() => requireInteger(value as never, "integer")).toThrow(TypeError);
        }
        expect(() => requireTimestamp(Number.MAX_SAFE_INTEGER, "timestamp")).toThrow(TypeError);
        expect(() => requireArray({}, "array")).toThrow(TypeError);
        expect(revisionData(new Revision(2))).toBe(2);
        expect(revisionFromData(2, "revision").value).toBe(2);
        expect(digestFromData(digest("f").value, "digest")).toEqual(digest("f"));
        expect(compareText("a", "b")).toBe(-1);
        expect(compareText("b", "a")).toBe(1);
        expect(compareText("a", "a")).toBe(0);
    });
});

describe("constituent shape validation", () => {
    it("rejects malformed placement sets", () => {
        const valid = {
            facet: new FacetRef("core:facet"),
            policy: ["dynamic"] as const,
            substrate: ["dynamic"] as const,
            trust: ["dynamic"] as const,
            selected: "dynamic" as const
        };
        expect(() => new FacetRef("")).toThrow(/Facet reference/);
        for (const manifest of [[], ["dynamic", "dynamic"], ["unknown" as never]]) {
            expect(() => new PlacementPin({ ...valid, manifest: manifest as never })).toThrow(
                TypeError
            );
        }
        expect(
            () =>
                new PlacementPin({
                    ...valid,
                    manifest: ["dynamic"],
                    policy: ["provider"],
                    selected: "dynamic"
                })
        ).toThrow(/source set/);
        const placement = new PlacementPin({ ...valid, manifest: ["dynamic"] });
        expect(() => new TurnPlacementSnapshot(ids.turn, pins(), [placement, placement])).toThrow(
            /unique/
        );
    });

    it("rejects malformed spawn reservations", () => {
        const base = [
            ids.run,
            ids.turn,
            new RunId("child"),
            { turn: ids.turn, holder: ids.holder, epoch: 1 },
            configuration().id,
            content("f"),
            refs.invocation,
            refs.receipt,
            digest("f")
        ] as const;
        expect(
            () =>
                new SpawnReservation(
                    new SpawnReservationId("same-run"),
                    ids.run,
                    ids.turn,
                    ids.run,
                    base[3],
                    base[4],
                    base[5],
                    base[6],
                    base[7],
                    base[8],
                    new Date(1)
                )
        ).toThrow(/distinct/);
        expect(
            () =>
                new SpawnReservation(
                    new SpawnReservationId("wrong-turn"),
                    base[0],
                    base[1],
                    base[2],
                    { ...base[3], turn: new TurnId("other") },
                    base[4],
                    base[5],
                    base[6],
                    base[7],
                    base[8],
                    new Date(1)
                )
        ).toThrow(/spawning Turn/);
        expect(
            () =>
                new SpawnReservation(
                    new SpawnReservationId("bad-date"),
                    ...base,
                    new Date(Number.NaN)
                )
        ).toThrow(/time/);
        expect(
            () =>
                new SpawnReservation(
                    new SpawnReservationId("bad-epoch"),
                    base[0],
                    base[1],
                    base[2],
                    { ...base[3], epoch: -1 },
                    base[4],
                    base[5],
                    base[6],
                    base[7],
                    base[8],
                    new Date(1)
                )
        ).toThrow(/epoch/);
        expect(
            () =>
                new TurnInboxEntry(
                    new TurnInboxEntryId("wrong-token-turn"),
                    ids.turn,
                    0,
                    "turn.cancel",
                    content("a"),
                    digest("a"),
                    "wrong-token-turn",
                    { turn: new TurnId("other"), holder: ids.holder, epoch: 1 },
                    new Date(1)
                )
        ).toThrow(/exact Turn/);
        expect(
            () =>
                new TurnInboxEntry(
                    new TurnInboxEntryId("bad-token-epoch"),
                    ids.turn,
                    0,
                    "turn.cancel",
                    content("a"),
                    digest("a"),
                    "bad-token-epoch",
                    { turn: ids.turn, holder: ids.holder, epoch: -1 },
                    new Date(1)
                )
        ).toThrow(/valid epoch/);
    });
});

describe("Run lifecycle record errors", () => {
    it("separates constructor shape errors from operational transition errors", () => {
        const terminal = new TerminalSnapshot(
            ids.run,
            ids.turn,
            ids.root,
            new RunCommitId("terminal-shape"),
            "failed",
            new SettlementObligation({
                registryEpoch: 1,
                obligations: []
            }),
            new Date(1000)
        );
        expect(
            () =>
                new Run({
                    id: ids.run,
                    agent: ids.agent,
                    configuration: configuration().id,
                    root: ids.root,
                    initialBranch: ids.branch,
                    lifecycle: genesis().run.lifecycle,
                    terminal,
                    revision: new Revision(0)
                })
        ).toThrow(TypeError);
        const foreign = new TerminalSnapshot(
            new RunId("foreign"),
            ids.turn,
            ids.root,
            new RunCommitId("foreign-terminal"),
            "failed",
            terminal.obligation,
            new Date(1000)
        );
        try {
            genesis().run.terminalize(foreign);
            throw new Error("Expected terminalization failure");
        } catch (error) {
            expect(error).toBeInstanceOf(AgentCoreError);
            expect((error as AgentCoreError).code).toBe("run.invalid-state");
        }
        const data = structuredClone(genesis().run.toData()) as Record<string, unknown>;
        data["lifecycle"] = "unknown";
        expect(() => Run.fromData(data as never)).toThrow(/lifecycle/);
        expect(
            () => new RunBranch(genesis().branch.id, ids.run, " ", ids.root, new Revision(0))
        ).toThrow(/blank/);
    });

    it("reports revision exhaustion with closed domain errors", () => {
        const run = new Run({
            id: ids.run,
            agent: ids.agent,
            configuration: configuration().id,
            root: ids.root,
            initialBranch: ids.branch,
            revision: new Revision(Number.MAX_SAFE_INTEGER)
        });
        const branch = new RunBranch(
            ids.branch,
            ids.run,
            "main",
            ids.root,
            new Revision(Number.MAX_SAFE_INTEGER)
        );
        const placement = new TurnPlacementSnapshot(ids.turn, pins(), []);
        const turn = new Turn({
            id: ids.turn,
            run: ids.run,
            branch: ids.branch,
            startHead: ids.root,
            effectiveInput: ids.root,
            pins: pins(),
            placement: placement.digest,
            input: content("a"),
            revision: new Revision(Number.MAX_SAFE_INTEGER)
        });
        for (const [operation, code] of [
            [() => run.revise(), "run.invalid-state"],
            [() => branch.advance(new RunCommitId("next")), "run.invalid-state"],
            [() => turn.revise(), "turn.invalid-state"]
        ] as const) {
            try {
                operation();
                throw new Error("Expected exhaustion");
            } catch (error) {
                expect(error).toBeInstanceOf(AgentCoreError);
                expect((error as AgentCoreError).code).toBe(code);
            }
        }
    });
});
