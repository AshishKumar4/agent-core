// @ts-nocheck
import type { JsonValue } from "../../../src/core";
import {
    SELF_OPERATIONS,
    SelfFacet,
    SelfRunDependency,
    type SelfCheckpointInput,
    type SelfCommitMessageInput,
    type SelfFinishInput,
    type SelfMigrationInput,
    type SelfSpawnInput
} from "../../../src/facets";
import { describe, expect, test } from "vitest";
import { denyingRuntime, operationDeclarationEvidence, recordingRuntime } from "./harness";

operationDeclarationEvidence("Self", SELF_OPERATIONS, {
    checkpoint: "mutate",
    commitMessage: "mutate",
    spawn: "delegate",
    finish: "mutate",
    proposeMigration: "administer"
});

describe("Self protected Run contract", () => {
    test("[P11-SELF-COMPOSITION] composes mediated Facet Operations over the typed Run dependency", async () => {
        const run = new TestRunDependency();
        const { runtime, admission } = recordingRuntime("self-composition");
        await new SelfFacet(runtime, run).checkpoint({ checkpoint: { value: 1 } });
        expect(admission.calls).toMatchObject([
            { kind: "invoke", name: "checkpoint", impact: "mutate" }
        ]);
        expect(run.calls).toEqual(["checkpoint"]);
    });

    test("[P11-SELF-FINISH-MEMBRANE] invokes finish through mediation before the Run dependency", async () => {
        const run = new TestRunDependency();
        const { runtime, admission } = recordingRuntime("self-finish");
        await new SelfFacet(runtime, run).finish({ result: { value: 1 } });
        expect(admission.calls).toMatchObject([{ kind: "invoke", name: "finish" }]);
        expect(run.calls).toEqual(["finish"]);
    });

    test("[P11-SELF-SPAWN-MEMBRANE] invokes spawn through mediation before the Run dependency", async () => {
        const run = new TestRunDependency();
        const { runtime, admission } = recordingRuntime("self-spawn");
        await new SelfFacet(runtime, run).spawn({ child: { value: 1 } });
        expect(admission.calls).toMatchObject([
            { kind: "invoke", name: "spawn", impact: "delegate" }
        ]);
        expect(run.calls).toEqual(["spawn"]);
    });

    test("[P11-SELF-MEDIATION] routes all five Operations without caller-supplied leases or authority", async () => {
        const run = new TestRunDependency();
        const { runtime, admission } = recordingRuntime("self");
        const facet = new SelfFacet(runtime, run);
        await facet.checkpoint({ checkpoint: { value: 1 } });
        await facet.commitMessage({ message: { value: 2 } });
        await facet.spawn({ child: { value: 3 } });
        await facet.finish({ result: { value: 4 } });
        await facet.proposeMigration({ migration: { value: 5 } });

        expect(admission.calls.map((call) => call.name)).toEqual([
            "checkpoint",
            "commitMessage",
            "spawn",
            "finish",
            "proposeMigration"
        ]);
        expect(run.calls).toEqual([
            "checkpoint",
            "commitMessage",
            "spawn",
            "finish",
            "proposeMigration"
        ]);
        expect(
            admission.calls.every((call) => {
                const input = call.input as Record<string, unknown>;
                return !("lease" in input) && !("authority" in input) && !("invocationId" in input);
            })
        ).toBe(true);
    });

    test("[P11-SELF-AUTHORITY] denial prevents the typed Run dependency", async () => {
        const run = new TestRunDependency();
        const facet = new SelfFacet(denyingRuntime("self").runtime, run);
        await expect(facet.spawn({ child: {} })).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(run.calls).toEqual([]);
    });
});

class TestRunDependency extends SelfRunDependency {
    public readonly calls: string[] = [];

    public async checkpoint(_input: SelfCheckpointInput): Promise<JsonValue> {
        return this.record("checkpoint");
    }

    public async commitMessage(_input: SelfCommitMessageInput): Promise<JsonValue> {
        return this.record("commitMessage");
    }

    public async spawn(_input: SelfSpawnInput): Promise<JsonValue> {
        return this.record("spawn");
    }

    public async finish(_input: SelfFinishInput): Promise<JsonValue> {
        return this.record("finish");
    }

    public async proposeMigration(_input: SelfMigrationInput): Promise<JsonValue> {
        return this.record("proposeMigration");
    }

    private record(operation: string): JsonValue {
        this.calls.push(operation);
        return { operation };
    }
}
