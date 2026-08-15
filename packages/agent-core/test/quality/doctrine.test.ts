import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { deriveBacklog, validateSources } from "../../scripts/quality/backlog.mjs";
import type { DoctrinePolicy } from "../../scripts/quality/doctrine.mjs";
import {
    classifyChange,
    enforceNormativeFreeze,
    ownersForProtectedPath,
    parseChangeControlArguments,
    parseChangeMetadata,
    selectMergedPull,
    selectEffectivePolicy,
    validateIntegrityCorrection,
    validateReviewedBase,
    validateExactHeadApproval,
    validateVerifiedCommitApproval
} from "../../scripts/quality/change-control.mjs";
import { validateClaimText } from "../../scripts/quality/claims.mjs";
import {
    documentedRuleIds,
    readDoctrinePolicy,
    validateDoctrinePolicy,
    validateFormalBoundary,
    validateWorkflowSource
} from "../../scripts/quality/doctrine.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");

describe("agent operating doctrine", () => {
    test("keeps every doctrine rule classified and the formal scope registry exact", async () => {
        const doctrine = await readFile(
            resolve(repositoryRoot, "AGENT_OPERATING_DOCTRINE.md"),
            "utf8"
        );
        const policy = await readDoctrinePolicy();
        const traceability = {
            formalBoundary: {
                requiredAreaIds: ["L0", "L1"],
                areas: [{ id: "L0" }, { id: "L1" }]
            },
            requirements: [{ id: "AC-X", remainingEvidence: ["legacy free-text source"] }]
        };

        expect(documentedRuleIds(doctrine)).toEqual(policy.rules.map((rule) => rule.id));
        expect(() => validateDoctrinePolicy(policy, doctrine, traceability)).not.toThrow();
        expect(() =>
            validateDoctrinePolicy(
                {
                    ...policy,
                    rules: policy.rules.map((rule) =>
                        rule.id === "D-1" ? { ...rule, testSelectors: [] } : rule
                    )
                },
                doctrine,
                traceability
            )
        ).toThrow(/test selectors/);
        expect(() =>
            validateDoctrinePolicy(
                policy,
                doctrine.replace(
                    "`ASM-*` records stay reviewed boundary metadata.",
                    "Every `ASM-*` becomes a named Lean axiom."
                ),
                traceability
            )
        ).toThrow(/Lean axioms/);
        expect(() =>
            validateFormalBoundary({
                requiredAreaIds: ["L1"],
                areas: traceability.formalBoundary.areas
            })
        ).toThrow(/required areas/);
        expect(policy.rules.every((rule) => rule.checker.startsWith("scripts/"))).toBe(true);
    });

    test("pins the CI workflow to its reviewed fail-closed semantics", async () => {
        const workflow = await readFile(
            resolve(repositoryRoot, ".github/workflows/verify.yml"),
            "utf8"
        );
        expect(() => validateWorkflowSource(workflow)).not.toThrow();
        const qualityGraph = JSON.parse(
            await readFile(
                resolve(repositoryRoot, "packages/agent-core/artifacts/quality/check-dag.json"),
                "utf8"
            )
        );
        expect(qualityGraph.nodes.lint).toContain("anti-slop-integrity");
        expect(qualityGraph.hermetic["anti-slop-integrity"]).toBe(true);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    "          fetch-depth: 0\n          ref: ${{ github.event.pull_request.head.sha || github.sha }}",
                    "          ref: ${{ github.event.pull_request.head.sha || github.sha }}\n          fetch-depth: 0"
                )
            )
        ).not.toThrow();
        expect(() => validateWorkflowSource(workflow.replace(/@[a-f0-9]{40}/u, "@v4"))).toThrow(
            /unreviewed action/
        );
        expect(() =>
            validateWorkflowSource(workflow.replace("on:\n", "on:\n  pull_request_target:\n"))
        ).toThrow(/pull_request_target/);
        expect(() =>
            validateWorkflowSource(workflow.replace("  contents: read", "  contents: write"))
        ).toThrow(/write permissions/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
                    "attacker/action@1111111111111111111111111111111111111111"
                )
            )
        ).toThrow(/unreviewed action/);
        expect(() =>
            validateWorkflowSource(workflow.replace("    steps:", "    if: false\n    steps:"))
        ).toThrow(/unconditionally/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    "      - uses: actions/checkout",
                    "      - if: false\n        uses: actions/checkout"
                )
            )
        ).toThrow(/fail closed/);
        expect(() =>
            validateWorkflowSource(workflow.replace("  pull_request_review:", "  review:"))
        ).toThrow(/pull_request_review/);
        expect(() =>
            validateWorkflowSource(workflow.replace(", synchronize, edited]", ", synchronize]"))
        ).toThrow(/metadata-changing route/);
        expect(() =>
            validateWorkflowSource(workflow.replace("          fetch-depth: 0\n", ""))
        ).toThrow(/checkout inputs|history/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace("          GITHUB_TOKEN: ${{ github.token }}\n", "")
            )
        ).toThrow(/GITHUB_TOKEN/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace("  verify:\n", "      - run: echo unreviewed\n  verify:\n")
            )
        ).toThrow(/exactly three reviewed steps/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    "          GITHUB_TOKEN: ${{ github.token }}",
                    "          GITHUB_TOKEN: ${{ github.token }}\n          NODE_OPTIONS: --require ./attack.js"
                )
            )
        ).toThrow(/missing or unknown fields/);
        expect(() =>
            validateWorkflowSource(workflow.replace("        run: >-", "        run: |"))
        ).toThrow(/exact verifier command/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    '          --repository "$GITHUB_REPOSITORY"',
                    '          --repository "$GITHUB_REPOSITORY"\n          --token "$GITHUB_TOKEN"'
                )
            )
        ).toThrow(/exact verifier command/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace("        run: >-", "        shell: bash\n        run: >-")
            )
        ).toThrow(/missing or unknown fields/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    "      - name: Verify\n        run: pnpm verify",
                    "      - name: Verify\n        if: false\n        run: pnpm verify"
                )
            )
        ).toThrow(/missing or unknown fields/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace("        run: pnpm verify", "        run: echo skipped")
            )
        ).toThrow(/exact reviewed command/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    "    if: github.event_name != 'pull_request_review'",
                    "    if: false"
                )
            )
        ).toThrow(/unreviewed gate/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    "  verify:\n    if:",
                    "  verify:\n    continue-on-error: true\n    if:"
                )
            )
        ).toThrow(/missing or unknown fields/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    "pnpm install --frozen-lockfile",
                    "pnpm install --no-frozen-lockfile"
                )
            )
        ).toThrow(/exact reviewed command/);
        expect(() =>
            validateWorkflowSource(
                workflow.replace(
                    "df0b2b3a439961ffcbb3985214365ffe40f49bc871df04dff268c7d8e21ca8b2",
                    "0000000000000000000000000000000000000000000000000000000000000000"
                )
            )
        ).toThrow(/exact reviewed command/);
        expect(() =>
            parseChangeControlArguments(["--base", "base", "--head", "head", "--token", "secret"])
        ).toThrow(/Unknown change-control option --token/);
    });

    test("keeps M-2 gated while traceability sources remain untyped", async () => {
        const doctrine = await readFile(
            resolve(repositoryRoot, "AGENT_OPERATING_DOCTRINE.md"),
            "utf8"
        );
        const policy = await readDoctrinePolicy();
        const falselyActivePolicy = {
            ...policy,
            infrastructureObligations: policy.infrastructureObligations.filter(
                (obligation) => obligation.id !== "M-2"
            ),
            rules: policy.rules.map((rule) =>
                rule.id === "W-2" || rule.id === "M-2"
                    ? {
                          id: rule.id,
                          state: "active" as const,
                          checker: rule.checker,
                          testSelectors: rule.testSelectors
                      }
                    : rule
            )
        };
        expect(() =>
            validateDoctrinePolicy(falselyActivePolicy, doctrine, {
                formalBoundary: { requiredAreaIds: ["L0"], areas: [{ id: "L0" }] },
                requirements: [{ id: "AC-X", remainingEvidence: ["legacy free-text source"] }]
            })
        ).toThrow(/M-2 cannot be active while traceability contains untyped source obligations/);
    });

    test("binds every gated milestone to a non-circular machine oracle", async () => {
        const doctrine = await readFile(
            resolve(repositoryRoot, "AGENT_OPERATING_DOCTRINE.md"),
            "utf8"
        );
        const policy = await readDoctrinePolicy();
        const traceability = {
            formalBoundary: { requiredAreaIds: ["L0"], areas: [{ id: "L0" }] },
            requirements: [{ id: "AC-X", remainingEvidence: ["legacy free-text source"] }]
        };
        const alternative = policy.infrastructureObligations.find(
            (obligation) => obligation.id === "M-3"
        );
        if (alternative === undefined) throw new TypeError("M-3 fixture obligation is absent");
        const mismatched = {
            ...policy,
            infrastructureObligations: policy.infrastructureObligations.map((obligation) =>
                obligation.id === "M-1"
                    ? {
                          ...obligation,
                          oracle: alternative.oracle
                      }
                    : obligation
            )
        };
        expect(() => validateDoctrinePolicy(mismatched, doctrine, traceability)).toThrow(
            /infrastructure obligation M-1 oracle/
        );
    });

    test("rejects system-level formal claims and requires plane-correct citations", () => {
        expect(() => validateClaimText("Agent Core is formally verified.", "README.md")).toThrow(
            /banned/
        );
        expect(() =>
            validateClaimText("Agent Core provides formal verification.", "README.md")
        ).toThrow(/banned/);
        expect(() => validateClaimText("Lean proves Agent Core correct.", "README.md")).toThrow(
            /banned/
        );
        expect(() =>
            validateClaimText("Agent Core has machine-checked correctness guarantees.", "README.md")
        ).toThrow(/banned/);
        for (const claim of [
            "The authorization system is mathematically guaranteed correct.",
            "The authority layer is proven secure.",
            "The policy engine cannot make an incorrect decision.",
            "The dispatcher is mathematically correct."
        ]) {
            expect(() => validateClaimText(claim, "README.md")).toThrow(/banned/);
        }
        for (const boundary of [
            "The authority layer is not proven secure.",
            "The policy engine cannot guarantee correctness.",
            "The dispatcher is not mathematically correct."
        ]) {
            expect(() => validateClaimText(boundary, "README.md")).not.toThrow();
        }
        expect(() =>
            validateClaimText(
                "The authority layer is not proven secure, but the authority layer is proven secure.",
                "README.md"
            )
        ).toThrow(/banned/);
        expect(() => validateClaimText("Agent Core is formally—verified.", "README.md")).toThrow(
            /banned/
        );
        expect(() =>
            validateClaimText("Agent Core does not claim formal verification.", "README.md")
        ).not.toThrow();
        expect(() =>
            validateClaimText(
                "Agent Core is not formally verified, but Agent Core is formally verified.",
                "README.md"
            )
        ).toThrow(/banned/);
        expect(() =>
            validateClaimText("The resolver is formal-model-backed.", "README.md")
        ).toThrow(/uncited formal/);
        expect(() =>
            validateClaimText(
                "The resolver is formal-model-backed.\n\nA different claim cites AC-AUTH-001.",
                "README.md"
            )
        ).toThrow(/uncited formal/);
        expect(() =>
            validateClaimText("The resolver is formal-model-backed (AC-AUTH-001).", "README.md")
        ).not.toThrow();
        expect(() =>
            validateClaimText("The Cloudflare substrate is verified.", "README.md")
        ).toThrow(/uncited implementation/);
        expect(() =>
            validateClaimText("The Cloudflare substrate is not verified.", "README.md")
        ).not.toThrow();
        expect(() =>
            validateClaimText(
                "The Cloudflare substrate is verified by P11-BASE-STARTUP.",
                "README.md"
            )
        ).not.toThrow();
        expect(() =>
            validateClaimText(
                "```text\nprovably correct\n```\n\nThe implementation is not formally verified.",
                "policy-example.md"
            )
        ).not.toThrow();
        expect(() => validateClaimText("> Agent Core is formally verified.", "README.md")).toThrow(
            /banned/
        );
        for (const evasion of [
            "Agent Core is formally veri\u200bfied.",
            "Agent Core is [formally](https://example.test) verified.",
            "Agent Core is formally&#32;verified.",
            '[Agent Core](https://example.test "Agent Core is formally verified.")',
            '[Agent Core][claim]\n\n[claim]: https://example.test "Agent Core is formally verified."'
        ]) {
            expect(() => validateClaimText(evasion, "README.md")).toThrow(/banned/);
        }
        expect(() =>
            validateClaimText("Agent Core is formally <span>verified</span>.", "README.md")
        ).toThrow(/raw HTML/);
        expect(() =>
            validateClaimText(
                "<!-- Agent Core is formally verified. -->\nAgent Core is not formally verified.",
                "README.md"
            )
        ).not.toThrow();
    });

    test("classifies mixed diffs by maximum tier while preserving every category", () => {
        const claims = new Set(["README.md", "packages/agent-core-cloudflare/package.json"]);
        expect(
            classifyChange(["packages/agent-core/formal/AgentCore/Proof.lean"], false, claims)
        ).toEqual({ categories: ["P"], tier: "P" });
        expect(
            classifyChange(
                [
                    "packages/agent-core/formal/AgentCore/Proof.lean",
                    "packages/agent-core/test/example.test.ts"
                ],
                false,
                claims
            )
        ).toEqual({ categories: ["P", "I"], tier: "I" });
        expect(
            classifyChange(
                [
                    "packages/agent-core/artifacts/traceability.yaml",
                    "packages/agent-core/formal/AgentCore/Authority.lean"
                ],
                true,
                claims
            )
        ).toEqual({ categories: ["L", "D"], tier: "D" });
        expect(
            classifyChange(["packages/agent-core/SPEC.md", "src/tool.ts"], false, claims)
        ).toEqual({ categories: ["D", "S"], tier: "S" });
        expect(classifyChange([".github/workflows/verify.yml"], false, claims).tier).toBe("D");
        expect(classifyChange(["tools/oxlint/anti-slop/index.ts"], false, claims).tier).toBe("D");
        expect(classifyChange(["pnpm-lock.yaml"], false, claims).tier).toBe("D");
        expect(
            classifyChange(["packages/agent-core/vitest.quality.config.mjs"], false, claims).tier
        ).toBe("D");
        expect(
            classifyChange(["packages/agent-core-cloudflare/package.json"], false, claims)
        ).toEqual({ categories: ["L", "D"], tier: "D" });
        expect(classifyChange(["README.md"], false, claims)).toEqual({
            categories: ["L"],
            tier: "L"
        });
        expect(classifyChange(["packages/agent-core/src/core/id.ts"], false, claims)).toEqual({
            categories: ["I"],
            tier: "I"
        });
        expect(classifyChange(["docs/security-claims.md"], false, claims)).toEqual({
            categories: ["L"],
            tier: "L"
        });
        for (const path of [".npmrc", "pnpmfile.cjs", "packages/new-quality-plugin/index.mjs"]) {
            expect(classifyChange([path], false, claims)).toEqual({
                categories: ["D"],
                tier: "D"
            });
        }
        expect(() => validateReviewedBase("base", "base")).not.toThrow();
        expect(() => validateReviewedBase("stale", "base")).toThrow(/exact change-control base/);
    });

    test("uses the reviewed base policy except at the exact adoption boundary", () => {
        const bootstrapPolicy = {
            edition: "1.0.0",
            adoptionBase: "base",
            tierOrder: ["P", "I", "L", "D", "S"],
            approvalTiers: ["L", "D", "S"],
            trustRoot: {
                path: ".github/CODEOWNERS",
                protectedPath: "/AGENT_OPERATING_DOCTRINE.md",
                bootstrapPath: "/AGENTS.md"
            }
        };
        const basePolicy = { ...bootstrapPolicy, adoptionBase: "old" };
        const candidatePolicy = { ...bootstrapPolicy, approvalTiers: [] };
        expect(selectEffectivePolicy(basePolicy, candidatePolicy, "base")).toBe(basePolicy);
        expect(selectEffectivePolicy(undefined, bootstrapPolicy, "base")).toBe(bootstrapPolicy);
        expect(() =>
            selectEffectivePolicy(undefined, { ...bootstrapPolicy, adoptionBase: "other" }, "base")
        ).toThrow(/exact adoption base/);
        expect(() => selectEffectivePolicy(undefined, candidatePolicy, "base")).toThrow(
            /built-in trust root/
        );
    });

    test("treats contributor metadata as declarations, never approval", () => {
        const known = new Set(["D-3", "G-1"]);
        const body = [
            "Change-Tier: D",
            "Doctrine-Rules: D-3, G-1",
            "Approved-By: definitely-a-maintainer"
        ].join("\n");
        expect(parseChangeMetadata(body, known)).toEqual({
            tier: "D",
            ruleIds: ["D-3", "G-1"],
            integrityCorrection: undefined
        });
        expect(() => validateExactHeadApproval([], new Set(["maintainer"]), "head")).toThrow(
            /No trusted CODEOWNER/
        );
        expect(() => parseChangeMetadata(`${body}\nChange-Tier: I`, known)).toThrow(/exactly one/);
        expect(() => parseChangeMetadata("Change-Tier: D\nDoctrine-Rules: D-9", known)).toThrow(
            /unknown rule/
        );
    });

    test("binds trusted review state to the exact current head", () => {
        const trusted = new Set(["maintainer"]);
        const approval = {
            id: 1,
            state: "APPROVED",
            commit_id: "head",
            user: { login: "maintainer" }
        };
        expect(validateExactHeadApproval([approval], trusted, "head")).toBe("maintainer");
        expect(() =>
            validateExactHeadApproval([{ ...approval, commit_id: "stale" }], trusted, "head")
        ).toThrow(/exact reviewed head/);
        expect(() =>
            validateExactHeadApproval(
                [approval, { ...approval, id: 2, state: "CHANGES_REQUESTED" }],
                trusted,
                "head"
            )
        ).toThrow(/exact reviewed head/);
        expect(() =>
            validateExactHeadApproval(
                [{ ...approval, user: { login: "contributor" } }],
                trusted,
                "head"
            )
        ).toThrow(/trusted CODEOWNER/);
        expect(
            validateExactHeadApproval(
                [
                    { ...approval, id: 2, state: "APPROVED" },
                    { ...approval, id: 1, state: "CHANGES_REQUESTED" }
                ],
                trusted,
                "head"
            )
        ).toBe("maintainer");
        expect(() => validateExactHeadApproval([{ ...approval, id: 0 }], trusted, "head")).toThrow(
            /stable review id/
        );
        expect(
            selectMergedPull(
                [
                    { merged_at: "now", merge_commit_sha: "other", base: { sha: "base" } },
                    { merged_at: "now", merge_commit_sha: "head", base: { sha: "base" } }
                ],
                "head",
                "base"
            )?.merge_commit_sha
        ).toBe("head");
        expect(
            selectMergedPull(
                [{ merged_at: "now", merge_commit_sha: "other", base: { sha: "base" } }],
                "head",
                "base"
            )
        ).toBeUndefined();
        expect(() =>
            selectMergedPull(
                [
                    { merged_at: "now", merge_commit_sha: "head", base: { sha: "base" } },
                    { merged_at: "now", merge_commit_sha: "head", base: { sha: "base" } }
                ],
                "head",
                "base"
            )
        ).toThrow(/multiple merged pull requests/);
        expect(
            selectMergedPull(
                [{ merged_at: "now", merge_commit_sha: "head", base: { sha: "stale" } }],
                "head",
                "base"
            )
        ).toBeUndefined();
    });

    test("accepts only a trusted, exact-head, maintainer-controlled commit signature", () => {
        const trusted = new Set(["maintainer"]);
        const commit = {
            oid: "head",
            signature: {
                isValid: true,
                state: "VALID",
                wasSignedByGitHub: false,
                signer: { login: "Maintainer" },
                signature: "signed bytes",
                payload: "commit payload",
                verifiedAt: "2026-08-14T00:00:00Z"
            }
        };
        expect(validateVerifiedCommitApproval(commit, trusted, "head")).toBe("maintainer");
        expect(() =>
            validateVerifiedCommitApproval({ ...commit, oid: "stale" }, trusted, "head")
        ).toThrow(/exact reviewed head/);
        expect(() =>
            validateVerifiedCommitApproval(
                {
                    ...commit,
                    signature: { ...commit.signature, wasSignedByGitHub: true }
                },
                trusted,
                "head"
            )
        ).toThrow(/maintainer-controlled/);
        expect(() =>
            validateVerifiedCommitApproval(
                {
                    ...commit,
                    signature: { ...commit.signature, signer: { login: "contributor" } }
                },
                trusted,
                "head"
            )
        ).toThrow(/trusted CODEOWNER/);
        expect(() =>
            validateVerifiedCommitApproval(
                { ...commit, signature: { ...commit.signature, state: "INVALID" } },
                trusted,
                "head"
            )
        ).toThrow(/maintainer-controlled/);
    });

    test("reads the reviewer trust root from the base CODEOWNERS", () => {
        const source = [
            "/AGENTS.md @bootstrap",
            "/AGENT_OPERATING_DOCTRINE.md @maintainer @org/team"
        ].join("\n");
        expect(
            ownersForProtectedPath(source, "/AGENT_OPERATING_DOCTRINE.md", "/AGENTS.md", false)
        ).toEqual(new Set(["maintainer"]));
        expect(
            ownersForProtectedPath(
                `${source}\n/AGENT_OPERATING_DOCTRINE.md @replacement`,
                "/AGENT_OPERATING_DOCTRINE.md",
                "/AGENTS.md",
                false
            )
        ).toEqual(new Set(["replacement"]));
        expect(
            ownersForProtectedPath(
                "/AGENTS.md @bootstrap",
                "/AGENT_OPERATING_DOCTRINE.md",
                "/AGENTS.md",
                true
            )
        ).toEqual(new Set(["bootstrap"]));
        expect(() =>
            ownersForProtectedPath(
                "/AGENTS.md @bootstrap",
                "/AGENT_OPERATING_DOCTRINE.md",
                "/AGENTS.md",
                false
            )
        ).toThrow(/no trusted owner/);
        expect(() =>
            ownersForProtectedPath(
                `${source}\n* @attacker`,
                "/AGENT_OPERATING_DOCTRINE.md",
                "/AGENTS.md",
                false
            )
        ).toThrow(/non-pattern ownership rules/);
        expect(() =>
            ownersForProtectedPath(
                "AGENT_OPERATING_DOCTRINE.md @maintainer",
                "/AGENT_OPERATING_DOCTRINE.md",
                "/AGENTS.md",
                false
            )
        ).toThrow(/non-pattern ownership rules/);
    });

    test("freezes normative semantics until scenarios and adversary controls are active", () => {
        const freezeSelector =
            "test/quality/doctrine.test.ts#agent operating doctrine freezes normative semantics until scenarios and adversary controls are active";
        const policy: Pick<DoctrinePolicy, "adoptionBase" | "rules"> = {
            adoptionBase: "base",
            rules: [
                {
                    id: "M-5",
                    state: "milestone-gated",
                    checker: "scripts/quality/change-control.mjs",
                    testSelectors: [freezeSelector]
                },
                {
                    id: "A-2",
                    state: "milestone-gated",
                    checker: "scripts/quality/change-control.mjs",
                    testSelectors: [freezeSelector]
                }
            ]
        };
        expect(() =>
            enforceNormativeFreeze(
                ["packages/agent-core/formal/AgentCore/Authority.lean"],
                policy,
                { integrityCorrection: undefined },
                "later"
            )
        ).toThrow(/frozen/);
        expect(() =>
            enforceNormativeFreeze(
                [
                    "packages/agent-core/formal/AgentCore/Authority.lean",
                    "packages/agent-core/artifacts/stuck/claim-1.json"
                ],
                policy,
                { integrityCorrection: "claim-1" },
                "later"
            )
        ).not.toThrow();
        expect(() =>
            enforceNormativeFreeze(
                ["packages/agent-core/formal/AgentCore/Normative.lean"],
                policy,
                { integrityCorrection: undefined },
                "base"
            )
        ).not.toThrow();
        expect(() =>
            enforceNormativeFreeze(
                ["packages/agent-core/formal/AgentCore/Authority.lean"],
                policy,
                { integrityCorrection: undefined },
                "base"
            )
        ).toThrow(/bootstrap includes unrelated/);
        const correction = {
            edition: "1.0.0",
            id: "claim-1",
            task: "Correct an overbroad claim",
            ruleIds: ["D-4"],
            obstruction: "A counterexample refutes the current statement",
            weakeningRejected: "Do not narrow unrelated reachable states",
            alternatives: ["Quarantine the claim"],
            evidence: ["counterexample.json"],
            recommendation: "Replace the statement and preserve the counterexample",
            affectedClaimIds: ["AC-X"],
            beforeNormativeManifest: `sha256:${"0".repeat(64)}`,
            afterNormativeManifest: `sha256:${"1".repeat(64)}`,
            beforeSpec: `sha256:${"2".repeat(64)}`,
            afterSpec: `sha256:${"2".repeat(64)}`,
            adversaryReview: {
                mode: "human",
                report: "reviews/claim-1.md",
                verdict: "accepted-integrity-correction"
            }
        };
        const correctionDigests = {
            beforeNormativeManifest: correction.beforeNormativeManifest,
            afterNormativeManifest: correction.afterNormativeManifest,
            beforeSpec: correction.beforeSpec,
            afterSpec: correction.afterSpec
        };
        expect(() =>
            validateIntegrityCorrection(correction, "claim-1", new Set(["D-4"]), correctionDigests)
        ).not.toThrow();
        expect(() =>
            validateIntegrityCorrection(
                { ...correction, affectedClaimIds: [] },
                "claim-1",
                new Set(["D-4"]),
                correctionDigests
            )
        ).toThrow(/affectedClaimIds/);
        expect(() =>
            validateIntegrityCorrection(correction, "claim-1", new Set(["D-4"]), {
                ...correctionDigests,
                afterSpec: `sha256:${"3".repeat(64)}`
            })
        ).toThrow(/exact afterSpec/);
    });

    test("derives one stable task per typed source without promoting nonclaims or assumptions", () => {
        const policy = {
            rules: [{ id: "M-2", state: "milestone-gated", milestone: "M-2" }],
            infrastructureObligations: [
                {
                    id: "M-3",
                    disposition: "candidate",
                    owner: "W0",
                    priority: 1,
                    oracle: { kind: "milestone-evidence", selector: "M-3", expected: "active" }
                },
                {
                    id: "permanent",
                    disposition: "permanent-boundary",
                    owner: "W0",
                    priority: 1,
                    oracle: { kind: "never" }
                }
            ]
        };
        const traceability = {
            requirements: [
                { id: "AC-X", remainingEvidence: ["untyped evidence"] },
                {
                    id: "AC-TYPED",
                    remainingEvidence: [
                        {
                            id: "E-1",
                            summary: "Obtain exact conformance evidence",
                            disposition: "conformance",
                            owner: "W2",
                            priority: 2,
                            oracle: {
                                kind: "conformance-status",
                                selector: "C13-X",
                                expected: "verified"
                            }
                        }
                    ]
                },
                { id: "AC-COMPLETE", remainingEvidence: [] }
            ],
            assumptions: [{ id: "ASM-X" }],
            nonClaims: [{ id: "NC-X" }],
            releaseChain: {
                entries: [
                    {
                        requirementId: "AC-X",
                        liveScenario: { status: "open", reason: "not deployed" }
                    }
                ]
            }
        };
        const fragments = [
            {
                requirements: [
                    {
                        id: "C13-X",
                        owner: "W1",
                        status: "planned",
                        remainingEvidence: ["behavior"]
                    },
                    { id: "C13-DONE", owner: "W1", status: "verified", remainingEvidence: [] }
                ]
            }
        ];
        const first = deriveBacklog(policy, traceability, fragments);
        const second = deriveBacklog(policy, traceability, fragments);
        expect(second).toEqual(first);
        expect(first.items.map((item) => item.id)).toEqual([
            "T-INFRA:M-3",
            "T-FORMAL:E-1",
            "T-EVIDENCE:AC-X:liveScenario",
            "T-EVIDENCE:C13-X",
            "T-TRIAGE:AC-X:647809c793bcd1efc76500844b29b694be2b0506f60ba0f64765ec8dcdff881a"
        ]);
        expect(JSON.stringify(first)).not.toContain("ASM-X");
        expect(JSON.stringify(first)).not.toContain("NC-X");
        expect(first.items.at(-1)?.oracle.kind).toBe("typed-disposition");
        expect(() =>
            deriveBacklog(
                { ...policy, rules: [{ id: "M-2", state: "active" }] },
                traceability,
                fragments
            )
        ).toThrow(/only while M-2 is milestone-gated/);
        const firstItem = first.items[0];
        if (firstItem === undefined) throw new TypeError("Fixture backlog is unexpectedly empty");
        expect(() => validateSources([firstItem, { ...firstItem, id: "different-id" }])).toThrow(
            /duplicated/
        );
    });
});
