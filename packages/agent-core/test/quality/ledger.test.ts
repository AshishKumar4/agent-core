import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { specRequirements } from "../../scripts/quality/spec.mjs";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/ledger.mjs");
const temporary: string[] = [];
const externalRequirementsByConsentGate = {
    "W8-REMOTE-SANDBOX": [
        "P11-ENVIRONMENT-EPHEMERAL-DURABILITY",
        "P11-ENVIRONMENT-PREVIEW",
        "P11-ENVIRONMENT-SNAPSHOT"
    ],
    "W8-REMOTE-WORKERS-FOR-PLATFORMS": ["P11-SLATE-DEPLOY", "P11-SLATE-MEDIATED-DEPLOY"]
} as const;

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe("atomic SPEC ledger", subprocessTestOptions, () => {
    test("limits external conformance to explicitly declared W8 remote gates", async () => {
        const remoteGates = JSON.parse(
            await readFile(
                resolve(packageRoot, "artifacts/integration/request-archive/W8/remote-gates.json"),
                "utf8"
            )
        ) as { gates: Array<{ id: string }> };
        const index = JSON.parse(
            await readFile(resolve(packageRoot, "artifacts/conformance/index.json"), "utf8")
        ) as { externalGates: string[] };
        const profiles = JSON.parse(
            await readFile(
                resolve(packageRoot, "artifacts/conformance/profiles-cloudflare.json"),
                "utf8"
            )
        ) as { requirements: Array<{ id: string; status: string }> };
        const declaredGateIds = remoteGates.gates.map((gate) => gate.id).sort();
        const expectedGateIds = Object.keys(externalRequirementsByConsentGate).sort();
        const expectedRequirements = Object.values(externalRequirementsByConsentGate).flat().sort();

        expect(declaredGateIds).toEqual(expectedGateIds);
        expect([...index.externalGates].sort()).toEqual(expectedRequirements);
        expect(
            profiles.requirements
                .filter((requirement) => requirement.status === "external-gated")
                .map((requirement) => requirement.id)
                .sort()
        ).toEqual(expectedRequirements);
    });

    test("extracts a unique owner and digest for every §13 atom and §11 profile", async () => {
        const requirements = await specRequirements();
        expect(requirements.length).toBeGreaterThan(300);
        expect(new Set(requirements.map((item) => item.id)).size).toBe(requirements.length);
        expect(requirements.every((item) => /^W\d+$/.test(item.owner))).toBe(true);
        expect(requirements.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.digest))).toBe(true);
        const spec = await readFile(resolve(packageRoot, "SPEC.md"), "utf8");
        const explicitProfileLabels = [...spec.matchAll(/^- \*\*(P11-[A-Z0-9-]+)\*\*/gmu)]
            .map((match) => match[1]!)
            .sort();
        expect(
            requirements.filter((item) => item.id.startsWith("P11-")).map((item) => item.id)
        ).toEqual(explicitProfileLabels);
        expect(explicitProfileLabels.some((id) => /^P11-\d/u.test(id))).toBe(false);
        for (const id of [
            "C13-TURN-NO-RETRY",
            "C13-TURN-NO-RETRY-RUNTIME",
            "C13-TURN-NO-RETRY-PROTOCOL",
            "C13-TURN-NO-RETRY-EXPORT",
            "C13-TURN-NO-RETRY-RECORD"
        ]) {
            expect(requirements.some((item) => item.id === id)).toBe(true);
        }
        const profileTexts = requirements
            .filter((item) => item.id.startsWith("P11-"))
            .map((item) => item.text.replaceAll(/\s+/g, " ").trim());
        expect(new Set(profileTexts).size).toBe(profileTexts.length);
        const profileFamilies = [
            "FILESYSTEM",
            "SHELL",
            "MEMORY",
            "TASK",
            "WEB",
            "MCP",
            "APPROVAL-GATEWAY",
            "SELF",
            "ENVIRONMENT",
            "DEVICE",
            "SLATE",
            "SINGLE-TENANT"
        ];
        for (const profile of profileFamilies) {
            expect(
                requirements.filter((item) => item.id.startsWith(`P11-${profile}-`)).length
            ).toBeGreaterThan(2);
        }
        expect(
            requirements.some(
                (item) =>
                    item.text ===
                    "Shell: Unknown commands reject rather than implicitly handing off."
            )
        ).toBe(true);
        expect(
            requirements.some(
                (item) => item.text === "Shell: Standard input, output, and error are streamed."
            )
        ).toBe(true);
        expect(
            requirements.some(
                (item) =>
                    item.text ===
                    "Device: Consent is transport-attached, exact per device and Agent, and fail-closed."
            )
        ).toBe(true);
    });

    test("keeps explicit labels stable and rejects a changed profile denominator", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "agent-core-spec-"));
        temporary.push(root);
        const originalPath = resolve(packageRoot, "SPEC.md");
        const original = await readFile(originalPath, "utf8");
        const baseline = await specRequirements(originalPath);
        const continuedPath = resolve(root, "continued.md");
        await writeFile(
            continuedPath,
            original.replace(
                "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.",
                "- **C13-AUTH-PLANE** One durable allow/deny Grant plane.\n\n  Additional exact evidence."
            ),
            "utf8"
        );
        const continued = await specRequirements(continuedPath);
        expect(continued.find((item) => item.id === "C13-AUTH-PLANE")?.digest).not.toBe(
            baseline.find((item) => item.id === "C13-AUTH-PLANE")?.digest
        );

        const insertedPath = resolve(root, "inserted.md");
        await writeFile(
            insertedPath,
            original.replace(
                "- **P11-SHELL-CANCEL**",
                "- **P11-SHELL-ADDED-FIXTURE** Fixture-only added atom.\n- **P11-SHELL-CANCEL**"
            ),
            "utf8"
        );
        await expect(specRequirements(insertedPath)).rejects.toThrow(/reviewed ID-set digest/);

        const missingProfilePath = resolve(root, "missing-profile.md");
        await writeFile(
            missingProfilePath,
            original.replace("### 11.12 Single-tenant", "### Removed Single-tenant"),
            "utf8"
        );
        await expect(specRequirements(missingProfilePath)).rejects.toThrow(
            /profile denominator changed/
        );

        const duplicatePath = resolve(root, "duplicate-label.md");
        await writeFile(
            duplicatePath,
            original.replace(
                "- **P11-SHELL-CANCEL**",
                "- **P11-SHELL-RUN** Duplicate fixture.\n- **P11-SHELL-CANCEL**"
            ),
            "utf8"
        );
        await expect(specRequirements(duplicatePath)).rejects.toThrow(/duplicate atomic labels/);
    });

    test("hashes authoritative normalized prose and enforces reviewed outside anchors", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "agent-core-normative-"));
        temporary.push(root);
        const originalPath = resolve(packageRoot, "SPEC.md");
        const original = await readFile(originalPath, "utf8");
        const baseline = await specRequirements(originalPath);
        const id = "C13-RUN-ADMISSION-REGISTRY";

        const summaryOnlyPath = resolve(root, "summary.md");
        await writeFile(
            summaryOnlyPath,
            original.replace(
                "Every Run-associated asynchronous obligation reserves a canonical Run-owner registry entry before admission.",
                "Every Run-associated asynchronous obligation reserves a canonical Run-owner registry entry before remote or local admission."
            ),
            "utf8"
        );
        const summaryOnly = await specRequirements(summaryOnlyPath);
        expect(summaryOnly.find((item) => item.id === id)?.digest).toBe(
            baseline.find((item) => item.id === id)?.digest
        );

        const normativePath = resolve(root, "normative.md");
        await writeFile(
            normativePath,
            original.replace(
                "Before any Run-associated Approval, Invocation item, RouteReservation,",
                "Before each Run-associated Approval, Invocation item, RouteReservation,"
            ),
            "utf8"
        );
        const normative = await specRequirements(normativePath);
        expect(normative.find((item) => item.id === id)?.digest).not.toBe(
            baseline.find((item) => item.id === id)?.digest
        );

        const missingAnchorPath = resolve(root, "missing-anchor.md");
        await writeFile(
            missingAnchorPath,
            original.replace("**C13-RUN-ADMISSION-REGISTRY**", "`C13-RUN-ADMISSION-REGISTRY`"),
            "utf8"
        );
        await expect(specRequirements(missingAnchorPath)).rejects.toThrow(
            /must appear exactly once/
        );
    });

    test("reports building incomplete and rejects final incomplete", async () => {
        const fixture = await ledgerFixture(true);
        const building = runFixture(fixture);
        expect(building.status, building.stderr).toBe(0);
        await writeFile(
            resolve(fixture, "conformance/stage.json"),
            `${JSON.stringify({ edition: "1.0.0", stage: "building" }, null, 2)}\n`,
            "utf8"
        );
        const final = runFixture(fixture, "final");
        expect(final.status).toBe(1);
        expect(final.stderr).toContain("stage.json to be final");

        // Hermetic runs validate at final strictness while the campaign is still
        // building: completeness stays a reported note, not a failure.
        const hermetic = runFixture(fixture, "final", true);
        expect(hermetic.status, hermetic.stderr).toBe(0);
        expect(hermetic.stdout).toContain("conformance incomplete");

        await writeFile(
            resolve(fixture, "conformance/stage.json"),
            `${JSON.stringify({ edition: "1.0.0", stage: "final" }, null, 2)}\n`,
            "utf8"
        );
        const declaredFinal = runFixture(fixture, "final", true);
        expect(declaredFinal.status).toBe(1);
        expect(declaredFinal.stderr).toContain("incomplete requirement(s)");
    });

    test("rejects malformed conformance maturity before interpreting it", async () => {
        const fixture = await ledgerFixture(true);
        await writeFile(
            resolve(fixture, "conformance/stage.json"),
            `${JSON.stringify({ edition: "1.0.0", stage: "almost-final" }, null, 2)}\n`,
            "utf8"
        );

        const result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("must be building or final");
    });

    test("declares every SPEC/formal impact without extending formal claims", async () => {
        const traceability = JSON.parse(
            await readFile(resolve(packageRoot, "artifacts/traceability.yaml"), "utf8")
        ) as {
            requirements: Array<{
                id: string;
                definitions: string[];
                theorems: string[];
                boundary: string;
            }>;
            nonClaims: Array<{ id: string; summary: string }>;
        };
        const run = traceability.requirements.find((item) => item.id === "AC-RUN-001");
        const approval = traceability.requirements.find((item) => item.id === "AC-APPROVAL-001");
        const authority = traceability.requirements.find(
            (item) => item.id === "AC-AUTH-RESOLUTION-001"
        );
        const structural = traceability.requirements.find(
            (item) => item.id === "AC-STRUCTURAL-001"
        );
        expect(run?.definitions).toContain("AgentCore.CompleteAdmittedFrontier");
        expect(run?.definitions).toContain("AgentCore.RunAdmissionRegistry");
        expect(run?.theorems).toContain("AgentCore.forced_cancellation_is_system_fence");
        expect(run?.theorems).toContain("AgentCore.terminal_snapshot_has_no_omission_or_extra");
        expect(run?.theorems).toContain("AgentCore.migration_requires_valid_target_pins");
        expect(run?.boundary).toContain("Concrete remote reservation enforcement");
        expect(approval?.definitions).toContain("AgentCore.ApprovalLedger.Continues");
        expect(approval?.theorems).toContain(
            "AgentCore.approval_continuation_validates_persisted_exact_intent"
        );
        expect(approval?.theorems).toContain("AgentCore.malformed_first_attempt_cannot_continue");
        expect(authority?.theorems).not.toContain(
            "AgentCore.post_issuance_watermark_cannot_cancel_permit"
        );
        expect(authority?.boundary).toContain("have no theorem claim");
        expect(structural?.theorems).toContain("AgentCore.replay_preserves_item_order_and_keys");
        expect(
            traceability.nonClaims.find((item) => item.id === "NC-INTERCEPTORS")?.summary
        ).toContain("structural ordered per-item");
        expect(
            traceability.nonClaims.find((item) => item.id === "NC-CLOUDFLARE-BEHAVIOR")?.summary
        ).toContain("are not modeled");

        const runGraph = await readFile(
            resolve(packageRoot, "formal/AgentCore/RunGraph.lean"),
            "utf8"
        );
        expect(runGraph).not.toContain("retryTurn");
        const obligationSection = runGraph.slice(
            runGraph.indexOf("inductive OpenObligation"),
            runGraph.indexOf("structure TerminalSnapshot")
        );
        expect(obligationSection).not.toContain("ReceiptId");
        expect(obligationSection).not.toContain("AuditId");
        expect(runGraph).toContain("completeObligation");
        expect(runGraph).toContain("AdmissionReservation.ValidIn");

        const scopes = await readFile(resolve(packageRoot, "formal/AgentCore/Scopes.lean"), "utf8");
        expect(scopes).toContain("holderWatermark : PrincipalRef → Scope → Nat");

        const spec = await readFile(resolve(packageRoot, "SPEC.md"), "utf8");
        expect(spec).toMatch(
            /newer\s+target-local\s+watermark arriving after issuance MUST NOT reject/iu
        );
        expect(spec).not.toContain("stale local fence or\nwatermark");
        expect(spec).toMatch(/kind: "delegated"; readonly principal: PrincipalRef/u);
        expect(spec).toContain("snapshot exactly `reserved − completed`");
        expect(spec).toContain("every `itemIndex` equals its position");
    });

    test("rejects missing and stale requirement evidence", async () => {
        const fixture = await ledgerFixture();
        const seedPath = resolve(fixture, "conformance/seed.json");
        const originalSeed = await readFile(seedPath, "utf8");
        const missing = JSON.parse(originalSeed);
        missing.requirements.shift();
        await writeFile(seedPath, `${JSON.stringify(missing, null, 2)}\n`, "utf8");
        let result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("denominator mismatch");

        const stale = JSON.parse(originalSeed);
        stale.requirements[0].specTextSha256 = `sha256:${"0".repeat(64)}`;
        await writeFile(seedPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("stale SPEC evidence");
    });

    test("rejects stale source symbols and tests that did not execute", async () => {
        const fixture = await ledgerFixture();
        const seedPath = resolve(fixture, "conformance/seed.json");
        const seed = JSON.parse(await readFile(seedPath, "utf8"));
        const requirement = seed.requirements.find(
            (item: Record<string, unknown>) => item.owner === "W1"
        );
        markVerified(
            requirement,
            "src/core/id.ts#MissingSymbol",
            "test/core/missing.test.ts#describes the missing behavior"
        );
        await addFragment(fixture, "foundation.json", "W1", requirement);
        let result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Stale source symbol");

        markVerified(
            requirement,
            "src/core/id.ts#TextId",
            "test/core/missing.test.ts#describes the missing behavior"
        );
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("test did not pass");
    });
});

async function ledgerFixture(preserveActiveFragments = false): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-ledger-"));
    temporary.push(root);
    await cp(resolve(packageRoot, "artifacts/conformance"), resolve(root, "conformance"), {
        recursive: true
    });
    const indexPath = resolve(root, "conformance/index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
        fragments: string[];
        pendingFragments?: string[];
    };
    if (!preserveActiveFragments) {
        await Promise.all(
            [...index.fragments, ...(index.pendingFragments ?? [])].map((name) =>
                rm(resolve(root, "conformance", name), { force: true })
            )
        );
        index.fragments = [];
        index.pendingFragments = [];
        await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    }
    await cp(
        resolve(packageRoot, "artifacts/quality/rules.json"),
        resolve(root, "quality/rules.json"),
        { recursive: true }
    );
    await cp(
        resolve(packageRoot, "artifacts/quality/ownership.json"),
        resolve(root, "quality/ownership.json"),
        { recursive: true }
    );
    const testSelectors = preserveActiveFragments
        ? (
              await Promise.all(
                  index.fragments.map(
                      async (name) =>
                          JSON.parse(await readFile(resolve(root, "conformance", name), "utf8"))
                              .requirements
                  )
              )
          )
              .flat()
              .filter((requirement) => ["verified", "external-gated"].includes(requirement.status))
              .flatMap((requirement) => requirement.testSelectors)
        : [];
    const testResults = testSelectors.map((selector) => {
        const separator = selector.indexOf("#");
        return {
            name: selector.slice(0, separator),
            assertionResults: [{ fullName: selector.slice(separator + 1), status: "passed" }]
        };
    });
    await writeFile(
        resolve(root, "vitest.json"),
        `${JSON.stringify(
            {
                success: true,
                numTotalTests: testResults.length,
                numPassedTests: testResults.length,
                numFailedTests: 0,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults
            },
            null,
            2
        )}\n`,
        "utf8"
    );
    const rules = JSON.parse(await readFile(resolve(root, "quality/rules.json"), "utf8")) as {
        rules: Array<{ id: string }>;
    };
    await writeFile(
        resolve(root, "invariants.json"),
        `${JSON.stringify({ passed: rules.rules.map((rule) => rule.id) }, null, 2)}\n`,
        "utf8"
    );
    return root;
}

async function addFragment(
    root: string,
    name: string,
    owner: string,
    requirement: Record<string, unknown>
): Promise<void> {
    const indexPath = resolve(root, "conformance/index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.fragments = [name];
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await writeFile(
        resolve(root, "conformance", name),
        `${JSON.stringify({ edition: "1.0.0", owner, requirements: [requirement] }, null, 2)}\n`,
        "utf8"
    );
}

function run(args: string[]): ReturnType<typeof runQualitySubprocess> {
    return runQualitySubprocess(process.execPath, [checker, ...args], packageRoot);
}

function runFixture(
    root: string,
    stage: "building" | "final" = "building",
    hermetic = false
): ReturnType<typeof runQualitySubprocess> {
    return run([
        ...(hermetic ? ["--hermetic"] : []),
        "--stage",
        stage,
        "--artifact-root",
        root,
        "--spec",
        resolve(packageRoot, "SPEC.md"),
        "--test-report",
        resolve(root, "vitest.json"),
        "--invariants-report",
        resolve(root, "invariants.json")
    ]);
}

function markVerified(
    requirement: Record<string, unknown>,
    source: string,
    testSelector: string
): void {
    requirement.status = "verified";
    requirement.sourceSymbols = [source];
    requirement.testSelectors = [testSelector];
    requirement.checkerInvariants = ["ACQ-ID"];
    requirement.remainingEvidence = [];
}
