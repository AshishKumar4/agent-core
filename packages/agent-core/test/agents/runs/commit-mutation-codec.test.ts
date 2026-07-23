import { describe, expect, test } from "vitest";
import { SemVer } from "../../../src/core";
import { RunCommitId } from "../../../src/execution-references";
import { ReceiptId } from "../../../src/invocations";
import {
    RunCommit,
    type CommitWriter,
    type RunCommitInit
} from "../../../src/agents/runs/commit";
import { BlueprintPin, RunPins } from "../../../src/agents/runs/pins";
import { content, digest, ids, pins, refs } from "./fixture";

const source = new RunCommitId("merge-source");

// Optional-field lists in the decoders are empty, so the only extra key an
// ArrayDeclaration mutant would admit is this exact literal.
const alien = "Stryker was here";

function expectTypeError(label: string, operation: () => unknown, message: string): void {
    let caught: unknown;
    try {
        operation();
    } catch (error) {
        caught = error;
    }
    expect(caught, label).toBeInstanceOf(TypeError);
    expect((caught as TypeError).message, label).toBe(message);
}

function decodeMutated(
    base: RunCommit,
    update: (data: Record<string, unknown>) => void
): () => RunCommit {
    const data = structuredClone(base.toData()) as Record<string, unknown>;
    update(data);
    return () => RunCommit.fromData(data as never);
}

function writerOf(data: Record<string, unknown>): Record<string, unknown> {
    return data["writer"] as Record<string, unknown>;
}

function causeOf(data: Record<string, unknown>): Record<string, unknown> {
    return writerOf(data)["cause"] as Record<string, unknown>;
}

function resolutionOf(data: Record<string, unknown>): Record<string, unknown> {
    return data["resolution"] as Record<string, unknown>;
}

function treeOf(data: Record<string, unknown>): Record<string, unknown> {
    return data["treeResolution"] as Record<string, unknown>;
}

function turnWriter(): CommitWriter {
    return { kind: "turn", token: { turn: ids.turn, holder: ids.holder, epoch: 1 } };
}

function controlWriter(): CommitWriter {
    return {
        kind: "system",
        cause: { kind: "control", audit: refs.audit, receipt: refs.receipt }
    };
}

function migratedPins(): RunPins {
    const base = pins();
    return new RunPins({
        blueprint: new BlueprintPin("blueprint", new SemVer("9.9.9"), digest("9")),
        packages: base.packages,
        agent: base.agent,
        effectivePolicy: base.effectivePolicy,
        modelPolicy: base.modelPolicy,
        environment: base.environment
    });
}

function turnAuthored(id: string, kind: "message" | "verdict"): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind,
        parents: [ids.root],
        pins: pins(),
        writer: turnWriter(),
        subjectTurn: ids.turn,
        content: content("1")
    });
}

function rootCommit(): RunCommit {
    return new RunCommit({
        id: ids.root,
        run: ids.run,
        branch: ids.branch,
        kind: "root",
        parents: [],
        pins: pins(),
        writer: { kind: "root" }
    });
}

function invocation(id: string): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "invocation",
        parents: [ids.root],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "receipt", audit: refs.audit, receipt: refs.receipt }
        },
        invocation: refs.invocation,
        receipt: refs.receipt
    });
}

function delivery(id: string): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "eventDelivery",
        parents: [ids.root],
        pins: pins(),
        writer: {
            kind: "system",
            cause: { kind: "delivery", audit: refs.audit, reservation: refs.route }
        },
        reservation: refs.route
    });
}

function migrationCommit(id: string): RunCommit {
    const migrated = migratedPins();
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "migration",
        parents: [ids.root],
        pins: migrated,
        writer: controlWriter(),
        receipt: refs.receipt,
        migration: { from: pins(), to: migrated }
    });
}

type MergeOptionals = Pick<
    RunCommitInit,
    "resolution" | "subjectTurn" | "treeCheckpoint" | "treeResolution"
>;

function merge(id: string, optionals: MergeOptionals): RunCommit {
    return new RunCommit({
        id: new RunCommitId(id),
        run: ids.run,
        branch: ids.branch,
        kind: "merge",
        parents: [ids.root, source],
        pins: pins(),
        writer: controlWriter(),
        content: content("2"),
        resolution: { kind: "concat" },
        receipt: refs.receipt,
        ...optionals
    });
}

function mergePick(id: string): RunCommit {
    return merge(id, { resolution: { kind: "pick", parent: ids.root } });
}

function mergeSynthesize(id: string): RunCommit {
    return merge(id, {
        subjectTurn: ids.turn,
        resolution: {
            kind: "synthesize",
            token: { turn: ids.turn, holder: ids.holder, epoch: 1 },
            receipt: new ReceiptId("synthesis-receipt")
        }
    });
}

function mergeOurs(id: string): RunCommit {
    return merge(id, {
        treeResolution: {
            policy: "ours",
            side: ids.root,
            base: content("d"),
            environment: "environment"
        },
        treeCheckpoint: content("c")
    });
}

function mergePerPath(id: string): RunCommit {
    return merge(id, {
        treeResolution: {
            policy: "perPath",
            base: content("d"),
            environment: "environment",
            resolutions: [
                { path: "/kept", side: ids.root },
                { path: "/moved", side: source }
            ]
        },
        treeCheckpoint: content("c")
    });
}

describe("Run commit decode guards", () => {
    test("names each malformed scalar payload field exactly", { tags: "p2" }, () => {
        const cases: ReadonlyArray<{ readonly field: string; readonly message: string }> = [
            { field: "id", message: "Run commit ID must be a non-empty string" },
            { field: "run", message: "Run commit Run must be a non-empty string" },
            { field: "branch", message: "Run commit branch must be a non-empty string" },
            { field: "subjectTurn", message: "Run subject Turn must be a non-empty string" },
            { field: "content", message: "Run content must be a non-empty string" },
            { field: "selects", message: "Run selection must be a non-empty string" },
            { field: "treeCheckpoint", message: "Tree checkpoint must be a non-empty string" },
            { field: "invocation", message: "Run Invocation must be a non-empty string" },
            { field: "receipt", message: "Run Receipt must be a non-empty string" },
            { field: "reservation", message: "Run reservation must be a non-empty string" }
        ];
        for (const { field, message } of cases) {
            expectTypeError(
                field,
                decodeMutated(turnAuthored("scalar-fields", "message"), (data) => {
                    data[field] = 42;
                }),
                message
            );
        }
    });

    test("rejects the exact alien optional field at every decode site", { tags: "p2" }, () => {
        const cases: ReadonlyArray<{
            readonly label: string;
            readonly base: RunCommit;
            readonly update: (data: Record<string, unknown>) => void;
            readonly subject: string;
        }> = [
            {
                label: "commit payload",
                base: turnAuthored("alien-commit", "message"),
                update: (data) => {
                    data[alien] = true;
                },
                subject: "Run commit"
            },
            {
                label: "root writer",
                base: rootCommit(),
                update: (data) => {
                    writerOf(data)[alien] = true;
                },
                subject: "Root writer"
            },
            {
                label: "turn writer",
                base: turnAuthored("alien-turn-writer", "message"),
                update: (data) => {
                    writerOf(data)[alien] = true;
                },
                subject: "Turn writer"
            },
            {
                label: "system writer",
                base: invocation("alien-system-writer"),
                update: (data) => {
                    writerOf(data)[alien] = true;
                },
                subject: "System writer"
            },
            {
                label: "delivery cause",
                base: delivery("alien-delivery-cause"),
                update: (data) => {
                    causeOf(data)[alien] = true;
                },
                subject: "Delivery cause"
            },
            {
                label: "receipt cause",
                base: invocation("alien-receipt-cause"),
                update: (data) => {
                    causeOf(data)[alien] = true;
                },
                subject: "Receipt cause"
            },
            {
                label: "pick resolution",
                base: mergePick("alien-pick"),
                update: (data) => {
                    resolutionOf(data)[alien] = true;
                },
                subject: "Pick resolution"
            },
            {
                label: "concat resolution",
                base: merge("alien-concat", {}),
                update: (data) => {
                    resolutionOf(data)[alien] = true;
                },
                subject: "Concat resolution"
            },
            {
                label: "synthesis resolution",
                base: mergeSynthesize("alien-synthesis"),
                update: (data) => {
                    resolutionOf(data)[alien] = true;
                },
                subject: "Synthesis resolution"
            },
            {
                label: "tree side resolution",
                base: mergeOurs("alien-tree-side"),
                update: (data) => {
                    treeOf(data)[alien] = true;
                },
                subject: "Tree side resolution"
            },
            {
                label: "per-path resolution",
                base: mergePerPath("alien-per-path"),
                update: (data) => {
                    treeOf(data)[alien] = true;
                },
                subject: "Per-path resolution"
            },
            {
                label: "path resolution",
                base: mergePerPath("alien-path-entry"),
                update: (data) => {
                    (treeOf(data)["resolutions"] as [Record<string, unknown>])[0][alien] = true;
                },
                subject: "Path resolution"
            },
            {
                label: "migration",
                base: migrationCommit("alien-migration"),
                update: (data) => {
                    (data["migration"] as Record<string, unknown>)[alien] = true;
                },
                subject: "Run migration"
            }
        ];
        for (const { label, base, update, subject } of cases) {
            expectTypeError(
                label,
                decodeMutated(base, update),
                `${subject} contains missing or unknown fields`
            );
        }
    });

    test("names malformed writer, resolution, and tree payloads exactly", { tags: "p2" }, () => {
        const cases: ReadonlyArray<{
            readonly label: string;
            readonly base: RunCommit;
            readonly update: (data: Record<string, unknown>) => void;
            readonly message: string;
        }> = [
            {
                label: "non-string writer kind",
                base: turnAuthored("writer-kind-number", "message"),
                update: (data) => {
                    data["writer"] = { kind: 42 };
                },
                message: "Commit writer kind must be a non-empty string"
            },
            {
                label: "unknown writer kind",
                base: turnAuthored("writer-kind-unknown", "message"),
                update: (data) => {
                    data["writer"] = { kind: "unknown" };
                },
                message: "Commit writer kind is invalid"
            },
            {
                label: "unknown system cause kind",
                base: invocation("cause-kind-unknown"),
                update: (data) => {
                    writerOf(data)["cause"] = { kind: "bogus" };
                },
                message: "System cause kind is invalid"
            },
            {
                label: "non-string resolution kind",
                base: merge("resolution-kind-number", {}),
                update: (data) => {
                    data["resolution"] = { kind: 5 };
                },
                message: "Merge resolution kind must be a non-empty string"
            },
            {
                label: "unknown resolution kind",
                base: merge("resolution-kind-unknown", {}),
                update: (data) => {
                    data["resolution"] = { kind: "bogus" };
                },
                message: "Merge resolution kind is invalid"
            },
            {
                label: "non-string picked parent",
                base: mergePick("pick-parent-number"),
                update: (data) => {
                    resolutionOf(data)["parent"] = 42;
                },
                message: "Picked parent must be a non-empty string"
            },
            {
                label: "non-string synthesis receipt",
                base: mergeSynthesize("synthesis-receipt-number"),
                update: (data) => {
                    resolutionOf(data)["receipt"] = 42;
                },
                message: "Synthesis Receipt must be a non-empty string"
            },
            {
                label: "non-string tree policy",
                base: mergeOurs("tree-policy-number"),
                update: (data) => {
                    treeOf(data)["policy"] = 7;
                },
                message: "Tree resolution policy must be a non-empty string"
            },
            {
                label: "unknown tree policy",
                base: mergePerPath("tree-policy-unknown"),
                update: (data) => {
                    treeOf(data)["policy"] = "bogus";
                },
                message: "Tree resolution policy is invalid"
            },
            {
                label: "non-string tree base",
                base: mergeOurs("tree-base-number"),
                update: (data) => {
                    treeOf(data)["base"] = 42;
                },
                message: "Tree merge base must be a non-empty string"
            },
            {
                label: "non-string tree environment",
                base: mergeOurs("tree-environment-number"),
                update: (data) => {
                    treeOf(data)["environment"] = 42;
                },
                message: "Tree merge Environment must be a non-empty string"
            },
            {
                label: "non-string tree side",
                base: mergeOurs("tree-side-number"),
                update: (data) => {
                    treeOf(data)["side"] = 42;
                },
                message: "Tree side must be a non-empty string"
            }
        ];
        for (const { label, base, update, message } of cases) {
            expectTypeError(label, decodeMutated(base, update), message);
        }
    });

    test("rejects unknown commit kinds instead of admitting them", { tags: "p1" }, () => {
        expectTypeError(
            "unknown kind on a turn-authored payload",
            decodeMutated(turnAuthored("kind-unknown", "message"), (data) => {
                data["kind"] = "unknown";
            }),
            "Run commit kind is invalid"
        );
    });

    test("round-trips the verdict kind and every optional payload exactly", { tags: "p1" }, () => {
        const verdict = RunCommit.fromData(turnAuthored("verdict-round-trip", "verdict").toData());
        expect(verdict.kind).toBe("verdict");

        const decodedMessage = RunCommit.fromData(
            turnAuthored("message-round-trip", "message").toData()
        );
        expect(decodedMessage.kind).toBe("message");
        expect(decodedMessage.writer.kind).toBe("turn");
        expect(decodedMessage.subjectTurn?.value).toBe("turn-1");
        expect(decodedMessage.migration).toBeUndefined();
        expect(decodedMessage.parents.map((parent) => parent.value)).toEqual(["commit-root"]);

        const decodedMigration = RunCommit.fromData(migrationCommit("migration-round-trip").toData());
        expect(decodedMigration.kind).toBe("migration");
        expect(decodedMigration.writer.kind).toBe("system");
        expect(
            decodedMigration.writer.kind === "system"
                ? decodedMigration.writer.cause.kind
                : undefined
        ).toBe("control");
        expect(
            decodedMigration.migration === undefined
                ? false
                : decodedMigration.pins.equals(decodedMigration.migration.to)
        ).toBe(true);
        expect(
            decodedMigration.migration === undefined
                ? false
                : decodedMigration.migration.from.equals(pins())
        ).toBe(true);

        const explicitData = structuredClone(
            turnAuthored("migration-explicitly-undefined", "message").toData()
        ) as Record<string, unknown>;
        explicitData["migration"] = undefined;
        expect(RunCommit.fromData(explicitData as never).migration).toBeUndefined();

        const decodedMerge = RunCommit.fromData(mergePerPath("per-path-round-trip").toData());
        expect(decodedMerge.parents.map((parent) => parent.value)).toEqual([
            "commit-root",
            "merge-source"
        ]);
        if (decodedMerge.treeResolution?.policy !== "perPath") {
            throw new Error("Expected a per-path tree resolution");
        }
        expect(
            decodedMerge.treeResolution.resolutions.map((path) => [path.path, path.side.value])
        ).toEqual([
            ["/kept", "commit-root"],
            ["/moved", "merge-source"]
        ]);
    });
});
