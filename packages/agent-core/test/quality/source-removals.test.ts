import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { loadOwnership } from "../../scripts/quality/ownership.mjs";
import {
    sourceRemovalDigest,
    validateSourceRemovalApprovals,
    type SourceRemovalApprovalDocument,
    type SourceRemovalValidationContext
} from "../../scripts/quality/source-removals.mjs";

const packageRoot = resolve(import.meta.dirname, "../..");
const artifactRoot = resolve(packageRoot, "artifacts");
const expectedPaths = [
    "packages/agent-core/src/authority/capability.ts",
    "packages/agent-core/src/content/record.ts",
    "packages/agent-core/src/core/value.ts",
    "packages/agent-core/src/core/version.ts"
];

let fixture: Awaited<ReturnType<typeof loadFixture>>;

beforeEach(async () => {
    fixture = await loadFixture();
    fixture.context.seed.baseCommit = fixture.document.approvals[0]!.original.baseCommit;
    for (const approval of fixture.document.approvals) {
        fixture.context.seed.files[approval.path] = {
            sha256: approval.original.sha256
        };
    }
});

describe("source-removal coverage governance", () => {
    test("validates exactly the reviewed removals without live request artifacts", () => {
        expect([...validate(fixture)].sort()).toEqual(expectedPaths);
        const referenced = new Set(
            fixture.document.approvals.map((approval) => approval.review.transition)
        );
        expect(
            fixture.context.transitions
                .filter((transition) => referenced.has(transition.id))
                .every((transition) =>
                    transition.acceptance.some((item) => item.startsWith("Packed"))
                )
        ).toBe(true);
    });

    test("rejects forged digests and duplicate approvals", () => {
        const forged = clone(fixture);
        forged.document.approvals[0]!.rationale = "forged";
        expect(() => validate(forged)).toThrow(/digest is stale/);

        const duplicated = clone(fixture);
        duplicated.document.approvals.push(structuredClone(duplicated.document.approvals[0]!));
        expect(() => validate(duplicated)).toThrow(/Duplicate source-removal approval/);
    });

    test("allows approvals only for exact baseline source identities", () => {
        const nonbaseline = clone(fixture);
        const approval = nonbaseline.document.approvals[0]!;
        approval.path = "packages/agent-core/src/core/not-a-baseline.ts";
        resign(approval);
        expect(() => validate(nonbaseline)).toThrow(/not a baseline file/);

        const staleIdentity = clone(fixture);
        staleIdentity.document.approvals[0]!.original.sha256 = "a".repeat(64);
        resign(staleIdentity.document.approvals[0]!);
        expect(() => validate(staleIdentity)).toThrow(/baseline identity is stale/);
    });

    test("rejects stale approvals for sources that still exist", () => {
        const stale = clone(fixture);
        stale.context.currentCoverage.add(stale.document.approvals[0]!.path);
        expect(() => validate(stale)).toThrow(/source exists/);
    });

    test("requires exact ownership and coordinated foreign replacement authorization", () => {
        const wrongOwner = clone(fixture);
        wrongOwner.document.approvals[1]!.owner = "W2";
        wrongOwner.document.approvals[1]!.review.disposition.owner = "W2";
        resign(wrongOwner.document.approvals[1]!);
        expect(() => validate(wrongOwner)).toThrow(/owned by W1, not W2/);

        const unauthorized = clone(fixture);
        const approval = unauthorized.document.approvals[1]!;
        approval.replacements = ["packages/agent-core/src/authority/grant.ts"];
        unauthorized.context.currentCoverage.add(approval.replacements[0]!);
        resign(approval);
        expect(() => validate(unauthorized)).toThrow(/lacks transition authorization/);
    });

    test("requires every replacement to exist in coverage", () => {
        const missing = clone(fixture);
        missing.context.currentCoverage.delete(missing.document.approvals[1]!.replacements[0]!);
        expect(() => validate(missing)).toThrow(/replacement is missing coverage/);
    });

    test("requires unique selectors that passed and immutable review links", () => {
        const duplicateSelector = clone(fixture);
        duplicateSelector.document.approvals[1]!.tests = [
            duplicateSelector.document.approvals[0]!.tests[0]!
        ];
        resign(duplicateSelector.document.approvals[1]!);
        expect(() => validate(duplicateSelector)).toThrow(/Duplicate source-removal test selector/);

        const failedSelector = clone(fixture);
        failedSelector.document.approvals[0]!.tests = ["test/missing.test.ts#did not pass"];
        resign(failedSelector.document.approvals[0]!);
        expect(() => validate(failedSelector)).toThrow(/test did not pass/);

        const staleReview = clone(fixture);
        staleReview.document.approvals[0]!.review.resolution.sha256 = "b".repeat(64);
        resign(staleReview.document.approvals[0]!);
        expect(() => validate(staleReview)).toThrow(/BOM resolution is stale/);
    });

    test("requires completed resolutions, transitions, and packed-negative evidence at final", () => {
        const complete = finalized(clone(fixture));
        expect([...validate(complete)].sort()).toEqual(expectedPaths);

        const pending = finalized(clone(fixture));
        const pendingResolution = pending.context.resolutions.entries.find(
            (entry) =>
                !Array.isArray(entry) &&
                entry.source === "packages/agent-core/artifacts/requests/W1/shared-integration.json"
        );
        if (pendingResolution === undefined || Array.isArray(pendingResolution)) {
            throw new TypeError("Missing finalized source-removal resolution fixture");
        }
        pendingResolution.state = "pending";
        pendingResolution.completion = null;
        expect(() => validate(pending)).toThrow(/resolution is not completed/);

        const ready = finalized(clone(fixture));
        transitionForFirstApproval(ready).state = "ready-for-coordinated-integration";
        expect(() => validate(ready)).toThrow(/transition does not admit/);

        const noNegative = finalized(clone(fixture));
        transitionForFirstApproval(noNegative).completion = { tests: [], checks: [] };
        expect(() => validate(noNegative)).toThrow(/lacks negative packed evidence/);
    });
});

function validate(value: typeof fixture): Set<string> {
    return validateSourceRemovalApprovals(value.document, value.context);
}

function clone(value: typeof fixture): typeof fixture {
    return {
        document: structuredClone(value.document),
        context: {
            ...structuredClone(value.context),
            patterns: value.context.patterns,
            currentCoverage: new Set(value.context.currentCoverage),
            executed: new Set(value.context.executed)
        }
    };
}

function resign(approval: SourceRemovalApprovalDocument["approvals"][number]): void {
    approval.digest = sourceRemovalDigest(approval);
}

function finalized(value: typeof fixture): typeof fixture {
    value.context.stage = "final";
    const legacy = value.context.resolutions.entries.some(Array.isArray);
    value.context.resolutions.entries = value.context.resolutions.entries.map((entry) => {
        if (!Array.isArray(entry)) return entry;
        const [source, sourceSha256] = entry;
        const archive = `packages/agent-core/artifacts/integration/request-archive/${source}`;
        return {
            source,
            sourceSha256,
            archive,
            archiveSha256: sourceSha256,
            state: "applied",
            completion: {
                commit: "a".repeat(40),
                tree: "b".repeat(40),
                artifacts: [{ path: archive, blob: "c".repeat(40), sha256: sourceSha256 }]
            }
        };
    });
    if (legacy) {
        for (const entry of value.context.bom.entries) {
            for (const artifact of entry.artifacts) {
                if (!artifact.source.includes("/artifacts/requests/")) continue;
                artifact.destination = `packages/agent-core/artifacts/integration/request-archive/${artifact.source}`;
            }
        }
    }
    for (const transition of value.context.transitions) {
        transition.state = "completed";
        transition.completion = { tests: [], checks: ["exports"] };
    }
    return value;
}

function transitionForFirstApproval(value: typeof fixture) {
    const id = value.document.approvals[0]!.review.transition;
    const transition = value.context.transitions.find((entry) => entry.id === id);
    if (transition === undefined) throw new TypeError(`Missing transition fixture ${id}`);
    return transition;
}

async function loadFixture(): Promise<{
    document: SourceRemovalApprovalDocument;
    context: SourceRemovalValidationContext & {
        currentCoverage: Set<string>;
        executed: Set<string>;
    };
}> {
    const document = await json<SourceRemovalApprovalDocument>(
        "quality/source-removal-approvals.json"
    );
    const transitionIndex = await json<{ manifests: string[] }>(
        "integration/transitions/index.json"
    );
    const transitions = await Promise.all(
        transitionIndex.manifests.map((name) =>
            json<SourceRemovalValidationContext["transitions"][number]>(
                `integration/transitions/${name}`
            )
        )
    );
    const { patterns } = await loadOwnership();
    return {
        document,
        context: {
            seed: await json<SourceRemovalValidationContext["seed"]>("quality/coverage-seed.json"),
            currentCoverage: new Set(
                document.approvals.flatMap((approval) => approval.replacements)
            ),
            patterns,
            executed: new Set(document.approvals.flatMap((approval) => approval.tests)),
            bom: await json<SourceRemovalValidationContext["bom"]>("integration/bom.json"),
            dispositions: await json<SourceRemovalValidationContext["dispositions"]>(
                "integration/dispositions.json"
            ),
            resolutions: await json<SourceRemovalValidationContext["resolutions"]>(
                "integration/resolutions.json"
            ),
            transitions
        }
    };
}

async function json<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(resolve(artifactRoot, path), "utf8")) as T;
}
