import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { globMatches } from "../../scripts/quality/project.mjs";
import {
    candidateManifestSha256,
    changedPathsBetween,
    loadTransitionAuthorization,
    loadOwnership,
    ownersForPath,
    validateClosureManifest,
    validateCompleteOwnership,
    validateCandidateChangeManifest,
    validateCandidateWorktreeManifest,
    validateCompletedCandidateManifest,
    validateOwnershipPaths
} from "../../scripts/quality/ownership.mjs";
import { runQualitySubprocess } from "./subprocess";

const transitionId = "TRANSITION-FOUNDATION-PUBLIC-CONTRACT";
const candidateTransitionId = "TRANSITION-W9-INTEGRATION-CANDIDATE";
const candidateBase = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const completionBase = "8d8ce1debed562c0d35d993fb47ccc7041cc0c70";
const completionCommit = "e841e800f563774b03d638dd7b1a15f11813cfb5";
type CandidateEntry = {
    path: string;
    owner: string;
    sourceBlob: string;
    candidateBlob: string;
    disposition: "added" | "modified" | "deleted";
};

describe("exclusive worktree ownership", () => {
    test("matches exact and recursive paths without cross-owner overlap", async () => {
        const { patterns } = await loadOwnership();
        expect(ownersForPath("packages/agent-core/src/identity/id.ts", patterns)).toEqual(["W2"]);
        expect(
            ownersForPath("packages/agent-core/src/facets/filesystem/facet.ts", patterns)
        ).toEqual(["W8"]);
        expect(ownersForPath("packages/agent-core/src/facets/manifest.ts", patterns)).toEqual([
            "W3"
        ]);
        expect(
            ownersForPath("packages/agent-core/artifacts/requests/W6/errors.json", patterns)
        ).toEqual(["W6"]);
        expect(ownersForPath("artifacts/requests/W8/shared-integration.json", patterns)).toEqual([
            "W8"
        ]);
        expect(
            ownersForPath("packages/agent-core/src/execution-references/id.ts", patterns)
        ).toEqual(["W5"]);
        expect(
            ownersForPath(
                "packages/agent-core/test/substrates/sqlite/invocations/persistence.test.ts",
                patterns
            )
        ).toEqual(["W6"]);
        expect(
            ownersForPath("packages/agent-core/src/interaction-references/id.ts", patterns)
        ).toEqual(["W7"]);
        expect(
            ownersForPath("packages/agent-core-cloudflare/scripts/check-consumer.mjs", patterns)
        ).toEqual(["W8"]);
    });

    test("implements single-segment and recursive wildcards", () => {
        expect(globMatches("src/*.ts", "src/index.ts")).toBe(true);
        expect(globMatches("src/*.ts", "src/nested/index.ts")).toBe(false);
        expect(globMatches("src/**", "src/nested/index.ts")).toBe(true);
    });

    test("[C13-OWNERSHIP-MAP] covers every tracked path", async () => {
        await expect(validateCompleteOwnership()).resolves.toBeGreaterThan(200);
    });

    test("admits only normal W1 paths and exact transition-listed W0 paths", async () => {
        const { patterns } = await loadOwnership();
        const authorization = await loadTransitionAuthorization(transitionId, "W1", patterns);
        expect(authorization.canonicalOwner).toBe("W0");
        expect(authorization.participants).toEqual(new Set(["W0", "W1"]));
        expect(
            validateOwnershipPaths(
                "W1",
                [
                    "packages/agent-core/src/core/index.ts",
                    "packages/agent-core/artifacts/quality/exports.json"
                ],
                patterns,
                authorization
            )
        ).toEqual([]);
        expect(
            validateOwnershipPaths(
                "W1",
                ["packages/agent-core/tsconfig.json"],
                patterns,
                authorization
            )
        ).toEqual([
            {
                path: "packages/agent-core/tsconfig.json",
                owners: ["W0"],
                reason: "owned by W0, not W1"
            }
        ]);
    });

    test("rejects unowned and overlapping paths even when authorization lists them", () => {
        const patterns = new Map([
            ["owned/**", "W1"],
            ["foreign/**", "W0"],
            ["foreign/overlap.ts", "W2"]
        ]);
        const authorization = {
            id: transitionId,
            canonicalOwner: "W0",
            participants: new Set(["W0", "W1"]),
            allowedForeignPaths: new Set(["foreign/overlap.ts", "missing.ts"]),
            allowedForeignOwners: new Map([
                ["foreign/overlap.ts", "W0"],
                ["missing.ts", "W0"]
            ])
        };
        expect(
            validateOwnershipPaths(
                "W1",
                ["foreign/overlap.ts", "missing.ts"],
                patterns,
                authorization
            )
        ).toEqual([
            {
                path: "foreign/overlap.ts",
                owners: ["W0", "W2"],
                reason: "overlapping ownership"
            },
            { path: "missing.ts", owners: [], reason: "unowned" }
        ]);
    });

    test("rejects foreign deletions without exact archive proof authorization", () => {
        const path = "foreign/deleted.ts";
        const patterns = new Map([[path, "W1"]]);
        const authorization = {
            id: candidateTransitionId,
            canonicalOwner: "W9",
            participants: new Set(["W0", "W1", "W9"]),
            allowedForeignPaths: new Set([path]),
            allowedForeignOwners: new Map([[path, "W1"]]),
            deletedPaths: new Set([path]),
            allowedForeignDeletions: new Set<string>()
        };
        expect(validateOwnershipPaths("W0", [path], patterns, authorization)).toEqual([
            { path, owners: ["W1"], reason: "owned by W1, not W0" }
        ]);
        authorization.allowedForeignDeletions.add(path);
        expect(validateOwnershipPaths("W0", [path], patterns, authorization)).toEqual([]);
    });

    test("rejects unknown transitions and callers outside the exact participants", async () => {
        const { patterns } = await loadOwnership();
        await expect(
            loadTransitionAuthorization("TRANSITION-NOT-INDEXED", "W1", patterns)
        ).rejects.toThrow("Unknown coordinated transition");
        await expect(loadTransitionAuthorization(transitionId, "W2", patterns)).rejects.toThrow(
            "W2 is not a participant"
        );
    });

    test("binds a closure manifest to reachable commit objects and exact owners", async () => {
        const { patterns } = await loadOwnership();
        const entries = entriesBetween(completionBase, completionCommit, patterns);
        const transition = {
            id: candidateTransitionId,
            inputs: [{ owner: "W0" }, { owner: "W9" }],
            completion: { commit: completionBase },
            closureManifest: {
                base: completionBase,
                commit: completionCommit,
                tree: git(["show", "-s", "--format=%T", completionCommit]),
                sha256: candidateManifestSha256(entries),
                paths: entries
            }
        };

        expect(validateClosureManifest(transition, patterns)).toEqual(entries);
        transition.closureManifest.tree = "0".repeat(40);
        expect(() => validateClosureManifest(transition, patterns)).toThrow(
            "closure commit or tree is unavailable"
        );
    });

    test("rejects omitted and extra candidate paths", () => {
        const patterns = candidatePatterns();
        const exact = candidateEntries();
        expect(() =>
            validateCandidateChangeManifest(
                candidateTransition(exact.slice(0, 1)),
                exact.map((entry) => entry.path),
                patterns,
                candidateBase
            )
        ).toThrow("paths differ from the base diff");
        const extra = [
            ...exact,
            {
                path: "z/w9.ts",
                owner: "W9",
                sourceBlob: "absent",
                candidateBlob: "c".repeat(40),
                disposition: "added" as const
            }
        ];
        expect(() =>
            validateCandidateChangeManifest(
                candidateTransition(extra),
                exact.map((entry) => entry.path),
                new Map([...patterns, ["z/**", "W9"]]),
                candidateBase
            )
        ).toThrow("paths differ from the base diff");
    });

    test("rejects candidate blob claims that differ from the worktree", () => {
        const transition = candidateTransition(candidateEntries());
        expect(() => validateCandidateWorktreeManifest(transition)).toThrow(
            "candidate index or worktree blob is stale"
        );
    });

    test(
        "binds completed candidates to every immutable commit blob",
        { timeout: 60_000 },
        async () => {
            const base = completionBase;
            const candidate = completionCommit;
            const paths = changedPathsBetween(base, candidate);
            const { patterns } = await loadOwnership();
            const entries = entriesBetween(base, candidate, patterns);
            const transition = {
                id: candidateTransitionId,
                inputs: Array.from({ length: 10 }, (_, index) => ({ owner: `W${index}` })),
                changeManifest: {
                    base,
                    sha256: candidateManifestSha256(entries),
                    paths: entries
                },
                completion: { commit: candidate }
            };
            expect(validateCompletedCandidateManifest(transition, patterns)).toHaveLength(
                paths.length
            );

            const changed = transition.changeManifest.paths.find(
                (entry) => entry.candidateBlob !== "deleted"
            );
            if (changed === undefined) throw new TypeError("Missing retained candidate fixture");
            changed.candidateBlob = "f".repeat(40);
            transition.changeManifest.sha256 = candidateManifestSha256(
                transition.changeManifest.paths
            );
            expect(() => validateCompletedCandidateManifest(transition, patterns)).toThrow(
                "completion blob is stale"
            );
        }
    );

    test("rejects wrong owners, unknown participants, and stale digests", () => {
        const exact = candidateEntries();
        const patterns = candidatePatterns();
        const wrongOwner = exact.map((entry) =>
            entry.path === "shared/w0.ts" ? { ...entry, owner: "W9" } : entry
        );
        expect(() =>
            validateCandidateChangeManifest(
                candidateTransition(wrongOwner),
                exact.map((entry) => entry.path),
                patterns,
                candidateBase
            )
        ).toThrow("path has wrong owner");

        const staleSource = exact.map((entry) =>
            entry.path === "owned/w9.ts"
                ? { ...entry, sourceBlob: "a".repeat(40), disposition: "modified" as const }
                : entry
        );
        const staleSourceTransition = candidateTransition(staleSource);
        expect(() =>
            validateCandidateChangeManifest(
                staleSourceTransition,
                exact.map((entry) => entry.path),
                patterns,
                candidateBase
            )
        ).toThrow("source blob is stale");

        const unknown = [
            ...exact,
            {
                path: "unknown/w2.ts",
                owner: "W2",
                sourceBlob: "absent",
                candidateBlob: "c".repeat(40),
                disposition: "added" as const
            }
        ].sort((left, right) => left.path.localeCompare(right.path));
        expect(() =>
            validateCandidateChangeManifest(
                candidateTransition(unknown),
                unknown.map((entry) => entry.path),
                new Map([...patterns, ["unknown/**", "W2"]]),
                candidateBase
            )
        ).toThrow("path owner is not a participant");

        const stale = candidateTransition(exact);
        stale.changeManifest.sha256 = "0".repeat(64);
        expect(() =>
            validateCandidateChangeManifest(
                stale,
                exact.map((entry) => entry.path),
                patterns,
                candidateBase
            )
        ).toThrow("manifest digest is stale");
    });
});

function candidateEntries(): CandidateEntry[] {
    return [
        {
            path: "owned/w9.ts",
            owner: "W9",
            sourceBlob: "absent",
            candidateBlob: "a".repeat(40),
            disposition: "added"
        },
        {
            path: "shared/w0.ts",
            owner: "W0",
            sourceBlob: "absent",
            candidateBlob: "b".repeat(40),
            disposition: "added"
        }
    ];
}

function candidatePatterns() {
    return new Map([
        ["owned/**", "W9"],
        ["shared/**", "W0"]
    ]);
}

function entriesBetween(
    base: string,
    candidate: string,
    patterns: ReadonlyMap<string, string>
): CandidateEntry[] {
    return changedPathsBetween(base, candidate).map((path) => {
        const sourceBlob = git(["rev-parse", `${base}:${path}`], false) ?? "absent";
        const candidateBlob = git(["rev-parse", `${candidate}:${path}`], false) ?? "deleted";
        const owners = ownersForPath(path, patterns);
        const [owner, ...additionalOwners] = owners;
        if (owner === undefined || additionalOwners.length > 0) {
            throw new TypeError(`Fixture path has no exact owner: ${path}`);
        }
        return {
            path,
            owner,
            sourceBlob,
            candidateBlob,
            disposition:
                sourceBlob === "absent"
                    ? "added"
                    : candidateBlob === "deleted"
                      ? "deleted"
                      : "modified"
        };
    });
}

function candidateTransition(entries: CandidateEntry[]) {
    return {
        id: candidateTransitionId,
        inputs: [{ owner: "W0" }, { owner: "W9" }],
        changeManifest: {
            base: candidateBase,
            sha256: candidateManifestSha256(entries),
            paths: entries
        }
    };
}

function git(args: string[], required?: true): string;
function git(args: string[], required: false): string | undefined;
function git(args: string[], required = true): string | undefined {
    const result = runQualitySubprocess("git", args, resolve(import.meta.dirname, "../../../.."));
    if (result.status !== 0) {
        if (!required) return undefined;
        throw new TypeError(result.stderr);
    }
    return result.stdout.trim();
}
