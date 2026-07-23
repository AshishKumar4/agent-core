import { MemoryContentStore } from "../../../src/content";
import { CompatRange, SemVer, type JsonValue } from "../../../src/core";
import {
    FacetPackageId,
    OperationName,
    SELF_OPERATIONS,
    SelfFacet,
    SelfRunDependency,
    createSelfManifest,
    type FacetManifest,
    type InternalProfileFacetRuntime,
    type OperationContext,
    type SelfCheckpointInput,
    type SelfCommitMessageInput,
    type SelfFinishInput,
    type SelfMigrationInput,
    type SelfSpawnInput
} from "../../../src/facets";
import { InvocationId } from "../../../src/invocations";
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

    test("internal runtime routes all five Operations to the typed Run dependency", { tags: "p1" }, async () => {
        const run = new TestRunDependency();
        const { runtime } = recordingRuntime("self-internal");
        const internal = new SelfFacet(runtime, run).asInternalRuntime(selfManifest());
        await internal.start({ signal: new AbortController().signal });
        expect(internal.active).toBe(true);

        const context = internalContext();
        await expect(
            execute(internal, "checkpoint", { checkpoint: { value: 1 } }, context)
        ).resolves.toEqual({ operation: "checkpoint" });
        await execute(internal, "commitMessage", { message: { value: 2 } }, context);
        await execute(internal, "spawn", { child: { value: 3 } }, context);
        await execute(internal, "finish", { result: { value: 4 } }, context);
        await execute(internal, "proposeMigration", { migration: { value: 5 } }, context);
        expect(run.calls).toEqual([
            "checkpoint",
            "commitMessage",
            "spawn",
            "finish",
            "proposeMigration"
        ]);
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

function selfManifest(): FacetManifest {
    return createSelfManifest({
        id: new FacetPackageId("profile.self"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        bindings: []
    });
}

function internalContext(): OperationContext {
    return Object.freeze({
        invocation: new InvocationId("internal-invocation"),
        itemIndex: 0,
        idempotencyKey: "internal-idempotency",
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}

function execute(
    internal: InternalProfileFacetRuntime,
    name: string,
    input: JsonValue,
    context: OperationContext
): Promise<JsonValue> {
    const operation = internal.operation(new OperationName(name));
    if (operation === undefined) throw new TypeError(`Missing internal Operation ${name}`);
    return operation.execute(context, input);
}
