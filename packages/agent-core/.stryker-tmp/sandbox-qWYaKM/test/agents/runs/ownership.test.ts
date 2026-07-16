// @ts-nocheck
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
    it("maps every durable W5 codec to exactly one owner and store", () => {
        const artifact = JSON.parse(
            readFileSync(
                resolve(process.cwd(), "artifacts/integration/request-archive/W5/ownership.json"),
                "utf8"
            )
        ) as { readonly records: readonly OwnershipRow[] };
        const byKind = new Map(artifact.records.map((row) => [row.kind, row]));
        expect(byKind.size).toBe(artifact.records.length);
        for (const type of durableTypes) {
            const row = byKind.get(type.codec.kind);
            expect(row, type.codec.kind).toBeDefined();
            expect(row?.owner.length).toBeGreaterThan(0);
            expect(row?.store.length).toBeGreaterThan(0);
            expect(row?.source.startsWith("src/")).toBe(true);
        }
    });

    it("keeps mutable source records out of Run storage", async () => {
        const { RUN_RECORD_KINDS } = await import("../../../src/agents/runs/store");
        expect(RUN_RECORD_KINDS).not.toContain("agent-revision");
        expect(RUN_RECORD_KINDS).not.toContain("policy-revision");
        expect(RUN_RECORD_KINDS).not.toContain("model-revision");
        expect(RUN_RECORD_KINDS).not.toContain("environment-revision");
    });
});
