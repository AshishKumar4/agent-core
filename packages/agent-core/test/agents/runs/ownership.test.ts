import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isJsonValue } from "../../../src/core";
import { requireArray, requireObject, requireString } from "../../../src/agents/record-data";
import { RunCommit } from "../../../src/agents/runs/commit";
import { TurnLease } from "../../../src/agents/runs/lease";
import { RunConfigurationSnapshot, RunPins } from "../../../src/agents/runs/pins";
import { TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import { SettlementObligation, TerminalSnapshot } from "../../../src/agents/runs/settlement";
import { SpawnReservation } from "../../../src/agents/runs/spawn";
import { RunCheckpoint, Turn, TurnInboxEntry } from "../../../src/agents/runs/turn";
import {
    AgentPolicyRevisionRecord,
    AgentRevisionRecord,
    ModelPolicyRevisionRecord
} from "../../../src/agents/source";

interface OwnershipRow {
    readonly kind: string;
    readonly owner: string;
    readonly source: string;
    readonly store: string;
}

/** Reads the archived ownership rows, naming any field the archive failed to record. */
function ownershipRows(path: string): readonly OwnershipRow[] {
    const artifact: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonValue(artifact)) throw new TypeError("Ownership artifact is not JSON");
    const records = requireArray(
        requireObject(artifact, "Ownership artifact")["records"],
        "Ownership records"
    );
    return records.map((record, index) => {
        const row = requireObject(record, `Ownership record ${index}`);
        return {
            kind: requireString(row["kind"], `Ownership record ${index} kind`),
            owner: requireString(row["owner"], `Ownership record ${index} owner`),
            source: requireString(row["source"], `Ownership record ${index} source`),
            store: requireString(row["store"], `Ownership record ${index} store`)
        };
    });
}

const durableTypes = [
    AgentRevisionRecord,
    AgentPolicyRevisionRecord,
    ModelPolicyRevisionRecord,
    RunPins,
    RunConfigurationSnapshot,
    Run,
    RunBranch,
    RunCommit,
    Turn,
    TurnLease,
    TurnPlacementSnapshot,
    RunCheckpoint,
    TurnInboxEntry,
    SpawnReservation,
    SettlementObligation,
    TerminalSnapshot
] as const;

describe("W5 ownership isolation", () => {
    it("maps every durable W5 codec to exactly one owner and store", { tags: "p2" }, () => {
        const records = ownershipRows(
            resolve(process.cwd(), "artifacts/integration/request-archive/W5/ownership.json")
        );
        const byKind = new Map(records.map((row) => [row.kind, row]));
        expect(byKind.size).toBe(records.length);
        for (const type of durableTypes) {
            const row = byKind.get(type.codec.kind);
            expect(row, type.codec.kind).toBeDefined();
            expect(row?.owner.length).toBeGreaterThan(0);
            expect(row?.store.length).toBeGreaterThan(0);
            expect(row?.source.startsWith("src/")).toBe(true);
        }
    });

    it("keeps mutable source records out of Run storage", { tags: "p2" }, async () => {
        const { RUN_RECORD_KINDS } = await import("../../../src/agents/runs/store");
        expect(RUN_RECORD_KINDS).not.toContain("agent-revision");
        expect(RUN_RECORD_KINDS).not.toContain("policy-revision");
        expect(RUN_RECORD_KINDS).not.toContain("model-revision");
        expect(RUN_RECORD_KINDS).not.toContain("environment-revision");
    });
});
