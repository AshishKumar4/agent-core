import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { specRequirements } from "../../scripts/quality/spec.mjs";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";
import { objectsAt, readArtifact, stringAt, stringsAt } from "./artifacts";

/**
 * One conformance requirement as the fragments on disk record it. The ledger
 * fixtures rewrite these records field by field to drive the checker into each
 * refusal, so naming the record is what keeps a fixture from inventing a field
 * the checker never reads or silently dropping one it does.
 */
interface ConformanceRequirement {
    id: string;
    owner: string;
    specAnchor: string;
    specTextSha256: string;
    status: string;
    prerequisites: string[];
    sourceSymbols: string[];
    testSelectors: string[];
    checkerInvariants: string[];
    remainingEvidence: string[];
}

interface ConformanceFragment {
    edition: string;
    owner: string;
    requirements: ConformanceRequirement[];
}

interface ConformanceIndex {
    fragments: string[];
    pendingFragments?: string[];
    [field: string]: string | string[] | undefined;
}

async function readFixtureJson<Document>(path: string): Promise<Document> {
    return JSON.parse(await readFile(path, "utf8"));
}

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
        const remoteGates = await readArtifact(
            "artifacts/integration/request-archive/W8/remote-gates.json"
        );
        const index = await readArtifact("artifacts/conformance/index.json");
        const externalGates = stringsAt(index, "externalGates");
        const profiles = objectsAt(
            await readArtifact("artifacts/conformance/profiles-cloudflare.json"),
            "requirements"
        );
        const declaredGateIds = objectsAt(remoteGates, "gates")
            .map((gate) => stringAt(gate, "id"))
            .sort();
        const expectedGateIds = Object.keys(externalRequirementsByConsentGate).sort();
        const expectedRequirements: string[] = Object.values(externalRequirementsByConsentGate)
            .flat()
            .sort();

        expect(declaredGateIds).toEqual(expectedGateIds);
        // The index and the fragment must agree exactly on what remains gated, and
        // only explicitly consent-declared requirements may ever be external-gated.
        expect([...externalGates].sort()).toEqual(
            profiles
                .filter((requirement) => stringAt(requirement, "status") === "external-gated")
                .map((requirement) => stringAt(requirement, "id"))
                .sort()
        );
        for (const gated of externalGates) {
            expect(expectedRequirements).toContain(gated);
        }
        // A consent-gated requirement resolves only through the consented live
        // substrate lane: verified, with hash-bound live evidence demanded.
        for (const requirement of profiles) {
            const id = stringAt(requirement, "id");
            if (expectedRequirements.includes(id) && !externalGates.includes(id)) {
                expect(stringAt(requirement, "status")).toBe("verified");
                expect(stringsAt(requirement, "checkerInvariants")).toContain("ACQ-LIVE");
            }
        }
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
        // This case only says anything about an atom whose hash input IS its §13 summary,
        // which means an atom with no prose anchor. The C13-ADV-* family qualifies by
        // construction — those atoms state attack cases the suite must refuse rather than
        // obligations the prose declares, so no anchoring pass makes one authoritative.
        // C13-AUTH-PLANE stood here until its prose was bound, at which point appending to
        // its summary stopped moving its digest and this assertion silently inverted.
        const continuedPath = resolve(root, "continued.md");
        await writeFile(
            continuedPath,
            original.replace(
                "- **C13-ADV-STALE-LEASE** Adversarial tests cover a stale lease.",
                "- **C13-ADV-STALE-LEASE** Adversarial tests cover a stale lease.\n\n  Additional exact evidence."
            ),
            "utf8"
        );
        const continued = await specRequirements(continuedPath);
        expect(continued.find((item) => item.id === "C13-ADV-STALE-LEASE")?.digest).not.toBe(
            baseline.find((item) => item.id === "C13-ADV-STALE-LEASE")?.digest
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

        // A table is its own blank-line block, so an anchor in the prose beside one used
        // to stop at the blank line and a row could be rewritten with nothing restaling —
        // while the atoms claim exactly those rows. Both adjacencies are covered: the
        // lifecycle table follows its paragraph, the commit-kind matrix precedes its own.
        const rewrittenRowPath = resolve(root, "rewritten-row.md");
        await writeFile(
            rewrittenRowPath,
            original
                .replace(
                    "| `running` | suspend | `suspended` |",
                    "| `running` | suspend | `queued` |"
                )
                .replace("| `root` | `root` | atomic with Run creation |", "| `root` | `root` | |"),
            "utf8"
        );
        const rewritten = await specRequirements(rewrittenRowPath);
        for (const id of ["C13-TURN-LIFECYCLE", "C13-WRITER-MATRIX"]) {
            expect(rewritten.find((item) => item.id === id)?.digest).not.toBe(
                baseline.find((item) => item.id === id)?.digest
            );
        }
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
        await planOneRequirement(fixture);
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
        const traceability = await readArtifact("artifacts/traceability.yaml");
        const claims = new Map(
            objectsAt(traceability, "requirements").map((item) => [
                stringAt(item, "id"),
                {
                    definitions: stringsAt(item, "definitions"),
                    theorems: stringsAt(item, "theorems"),
                    boundary: stringAt(item, "boundary")
                }
            ])
        );
        const nonClaims = new Map(
            objectsAt(traceability, "nonClaims").map((item) => [
                stringAt(item, "id"),
                stringAt(item, "summary")
            ])
        );
        const run = claims.get("AC-RUN-001");
        const approval = claims.get("AC-APPROVAL-001");
        const authority = claims.get("AC-AUTH-RESOLUTION-001");
        const composed = claims.get("AC-COMPOSED-001");
        const structural = claims.get("AC-STRUCTURAL-001");
        expect(run?.definitions).toContain("AgentCore.CompleteAdmittedFrontier");
        expect(run?.definitions).toContain("AgentCore.RunAdmissionRegistry");
        expect(run?.theorems).toContain("AgentCore.forced_cancellation_is_system_fence");
        expect(run?.theorems).toContain("AgentCore.terminal_snapshot_has_no_omission_or_extra");
        expect(run?.theorems).toContain("AgentCore.migration_requires_valid_target_pins");
        expect(run?.boundary).toContain("remote reservation enforcement");
        expect(run?.theorems).toContain("AgentCore.acceptance_unsatisfied_not_settled");
        expect(run?.theorems).toContain("AgentCore.acceptance_verdict_only_for_its_subject");
        expect(approval?.definitions).toContain("AgentCore.ApprovalLedger.Continues");
        expect(approval?.theorems).toContain(
            "AgentCore.approval_continuation_validates_persisted_exact_intent"
        );
        expect(approval?.theorems).toContain("AgentCore.malformed_first_attempt_cannot_continue");
        expect(authority?.theorems).not.toContain(
            "AgentCore.post_issuance_watermark_cannot_cancel_permit"
        );
        expect(authority?.boundary).toContain("owned by AC-COMPOSED-001");
        expect(composed?.definitions).toContain("AgentCore.TargetPermitRequest");
        expect(composed?.definitions).toContain("AgentCore.PermitProtocolIntegrity");
        expect(composed?.theorems).toContain(
            "AgentCore.reachable_permit_protocol_has_historical_issuance"
        );
        expect(composed?.theorems).toContain(
            "AgentCore.reachable_consumption_has_exact_historical_issuance"
        );
        expect(composed?.theorems).toContain(
            "AgentCore.reachable_attempts_have_exact_issued_permits"
        );
        expect(composed?.boundary).toContain("No cross-Actor atomic premise");
        expect(composed?.boundary).toContain("without reading issuer storage");
        expect(composed?.boundary).toContain(
            "every reachable EffectAttempt therefore has an exact target request"
        );
        expect(composed?.boundary).toContain("No Actor-local boolean or claimed authority");
        expect(composed?.boundary).toContain("Live authority administration");
        expect(structural?.theorems).toContain("AgentCore.replay_preserves_item_order_and_keys");
        const interceptor = claims.get("AC-INTERCEPTOR-001");
        expect(interceptor?.theorems).toContain("AgentCore.run_attributes_last_rewriter");
        expect(interceptor?.theorems).toContain(
            "AgentCore.direct_admission_has_no_applicable_interceptor"
        );
        expect(interceptor?.boundary).toContain("are not modeled");
        expect(nonClaims.get("NC-INTERCEPTORS")).toContain("durable trace persistence");
        expect(nonClaims.get("NC-CLOUDFLARE-BEHAVIOR")).toContain(
            "not the concrete Cloudflare record"
        );

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
        const missing: ConformanceFragment = JSON.parse(originalSeed);
        missing.requirements.shift();
        await writeFile(seedPath, `${JSON.stringify(missing, null, 2)}\n`, "utf8");
        let result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("denominator mismatch");

        const stale: ConformanceFragment = JSON.parse(originalSeed);
        stale.requirements[0]!.specTextSha256 = `sha256:${"0".repeat(64)}`;
        await writeFile(seedPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("stale SPEC evidence");
    });

    test("admits exclusive W9 composition sources for cross-context requirement evidence", async () => {
        const fixture = await ledgerFixture();
        const seed = await readFixtureJson<ConformanceFragment>(
            resolve(fixture, "conformance/seed.json")
        );
        const requirement = seed.requirements.find((item) => item.id === "C13-AUTH-PRINCIPAL-REF")!;
        const selector =
            "test/composition/authority-state.test.ts#production authority state seams (memory) [C13-AUTH-PRINCIPAL-REF] rejects an exact cross-Tenant NUL collision without consulting or poisoning the local cache";
        markVerified(
            requirement,
            "src/composition/authority-state.ts#ActorAuthorityState",
            selector
        );
        await addFragment(fixture, "identity-authority.json", "W2", requirement);
        await writePassingSelectors(fixture, [selector]);

        let result = runFixture(fixture);
        expect(result.status, result.stderr).toBe(0);

        markVerified(requirement, "src/core/id.ts#TextId", selector);
        await addFragment(fixture, "identity-authority.json", "W2", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("source is not owned by W2");
    });

    test("rejects stale source symbols and tests that did not execute", async () => {
        const fixture = await ledgerFixture();
        const seedPath = resolve(fixture, "conformance/seed.json");
        const seed = await readFixtureJson<ConformanceFragment>(seedPath);
        const requirement = seed.requirements.find((item) => item.owner === "W1")!;
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

/**
 * Demote one leaf requirement to planned so the fixture exercises incompleteness
 * regardless of how complete the real conformance tree is. A leaf is chosen so no
 * verified requirement is left depending on an unverified prerequisite.
 */
async function planOneRequirement(root: string): Promise<void> {
    const indexPath = resolve(root, "conformance/index.json");
    const index = await readFixtureJson<ConformanceIndex>(indexPath);
    const fragments = await Promise.all(
        index.fragments.map(async (name) => ({
            name,
            document: await readFixtureJson<ConformanceFragment>(resolve(root, "conformance", name))
        }))
    );
    const prerequisites = new Set(
        fragments.flatMap(({ document }) =>
            document.requirements.flatMap((requirement) => requirement.prerequisites)
        )
    );
    for (const { name, document } of fragments) {
        const leaf = document.requirements.find(
            (requirement) => requirement.status === "verified" && !prerequisites.has(requirement.id)
        );
        if (leaf === undefined) continue;
        leaf.status = "planned";
        leaf.sourceSymbols = [];
        leaf.testSelectors = [];
        leaf.checkerInvariants = [];
        leaf.remainingEvidence = ["Fixture demotes this requirement to exercise incompleteness"];
        await writeFile(
            resolve(root, "conformance", name),
            `${JSON.stringify(document, null, 4)}\n`,
            "utf8"
        );
        return;
    }
    throw new TypeError("Ledger fixture found no leaf requirement to demote");
}

async function ledgerFixture(preserveActiveFragments = false): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-ledger-"));
    temporary.push(root);
    await cp(resolve(packageRoot, "artifacts/conformance"), resolve(root, "conformance"), {
        recursive: true
    });
    const indexPath = resolve(root, "conformance/index.json");
    const index = await readFixtureJson<ConformanceIndex>(indexPath);
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
                          (
                              await readFixtureJson<ConformanceFragment>(
                                  resolve(root, "conformance", name)
                              )
                          ).requirements
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
    const rules = await readFixtureJson<{ rules: Array<{ id: string }> }>(
        resolve(root, "quality/rules.json")
    );
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
    requirement: ConformanceRequirement
): Promise<void> {
    const indexPath = resolve(root, "conformance/index.json");
    const index = await readFixtureJson<ConformanceIndex>(indexPath);
    index.fragments = [name];
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await writeFile(
        resolve(root, "conformance", name),
        `${JSON.stringify({ edition: "1.0.0", owner, requirements: [requirement] }, null, 2)}\n`,
        "utf8"
    );
}

async function writePassingSelectors(root: string, selectors: readonly string[]): Promise<void> {
    await writeFile(
        resolve(root, "vitest.json"),
        `${JSON.stringify(
            {
                success: true,
                numTotalTests: selectors.length,
                numPassedTests: selectors.length,
                numFailedTests: 0,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: selectors.map((selector) => {
                    const separator = selector.indexOf("#");
                    return {
                        name: selector.slice(0, separator),
                        assertionResults: [
                            { fullName: selector.slice(separator + 1), status: "passed" }
                        ]
                    };
                })
            },
            null,
            2
        )}\n`,
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
    requirement: ConformanceRequirement,
    source: string,
    testSelector: string
): void {
    requirement.status = "verified";
    requirement.sourceSymbols = [source];
    requirement.testSelectors = [testSelector];
    requirement.checkerInvariants = ["ACQ-ID"];
    requirement.remainingEvidence = [];
}
