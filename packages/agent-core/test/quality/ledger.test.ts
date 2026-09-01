import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalSpec, specRequirements } from "../../scripts/quality/spec.mjs";
import type { JsonValue } from "../../scripts/quality/project.mjs";
import {
    type QualitySubprocessResult,
    runQualitySubprocess,
    subprocessTestOptions
} from "./subprocess";
import { validateLiveEvidence } from "../../scripts/quality/live-substrate-evidence.mjs";
import { objectAt, objectsAt, readArtifact, stringAt, stringsAt } from "./artifacts";

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
    /** Optional at every status and read by no evidence check; see the bounds cases below. */
    bounds?: string[];
}

/**
 * A requirement record as `addFragment` writes it. The bound refusals below must write shapes a
 * `ConformanceRequirement` forbids — a non-array `bounds`, a duplicated list, a misspelled
 * `bound` — so the written record admits raw JSON in the two bound spellings and nowhere else,
 * which is what keeps a fixture from laundering an off-shape value through the record type.
 */
interface WrittenRequirement extends Omit<ConformanceRequirement, "bounds"> {
    readonly bounds?: JsonValue;
    readonly bound?: JsonValue;
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
        // The user's own authorization is what the gate list may spend: governance.mjs
        // binds index.externalGates to exactly these atoms, so the map above may neither
        // out-declare the authorization nor fall behind it. A gate that is declared but
        // unauthorized contributes no atom, and so gates nothing.
        const consent = objectAt(
            await readArtifact("artifacts/integration/user-authorization-requests.json"),
            "remoteConsent"
        );
        const consentedAtoms = stringsAt(consent, "atoms");
        expect(stringsAt(consent, "gates").toSorted()).toEqual(expectedGateIds);
        expect(expectedRequirements).toEqual(consentedAtoms.toSorted());
        // A consent-gated requirement resolves only through the consented live
        // substrate lane: verified, with hash-bound live evidence demanded.
        for (const requirement of profiles) {
            const id = stringAt(requirement, "id");
            if (expectedRequirements.includes(id) && !externalGates.includes(id)) {
                expect(stringAt(requirement, "status")).toBe("verified");
                expect(stringsAt(requirement, "checkerInvariants")).toContain("ACQ-LIVE");
            }
        }
        // The other regime, and the one the tree is in: a row that rests on the live lane
        // without an authorized gate behind it has nothing to be gated by. It may sit
        // below verified while the archive it cited awaits its re-run — that is what the
        // rows below are doing — but claiming external-gated would claim a consent that
        // does not exist, and claiming verified re-arms the hash-bound demand on the
        // archive, which the case below measures.
        const liveRows = profiles.filter((requirement) =>
            stringsAt(requirement, "checkerInvariants").includes("ACQ-LIVE")
        );
        const unauthorizedLiveRows = liveRows.filter(
            (requirement) => !consentedAtoms.includes(stringAt(requirement, "id"))
        );
        expect(unauthorizedLiveRows.length).toBeGreaterThan(0);
        for (const requirement of unauthorizedLiveRows) {
            expect(stringAt(requirement, "status")).not.toBe("external-gated");
        }
    });

    test("keeps a drifted live archive pending for waiting rows and fatal for a verified one", async () => {
        const root = await ledgerFixture(true);
        const evidence = resolve(root, "conformance/live-evidence");
        // Construct the drift regime: alter one recorded fingerprint so the archive no
        // longer matches its deployed sources, and retreat every live row below verified,
        // which is exactly the state a fingerprinted-source edit leaves the tree in.
        const manifestPath = resolve(evidence, "run.json");
        const manifest = await readFixtureJson<{
            sourceFingerprints: Record<string, string>;
        }>(manifestPath);
        const fingerprinted = Object.keys(manifest.sourceFingerprints);
        expect(fingerprinted.length).toBeGreaterThan(0);
        const drifted = fingerprinted[0]!;
        manifest.sourceFingerprints[drifted] = manifest.sourceFingerprints[drifted]!.replace(
            /[0-9a-f]$/u,
            (last) => (last === "0" ? "1" : "0")
        );
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");
        const fragmentPath = resolve(root, "conformance/profiles-cloudflare.json");
        const fragment = await readFixtureJson<ConformanceFragment>(fragmentPath);
        for (const requirement of fragment.requirements) {
            if (
                requirement.checkerInvariants.includes("ACQ-LIVE") &&
                requirement.status === "verified"
            ) {
                requirement.status = "implemented";
                requirement.remainingEvidence = [
                    "The archived live run no longer matches this tree; one operator re-run of the consented lane restores it."
                ];
            }
        }
        await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 4)}\n`, "utf8");
        const waiting = validateLiveEvidence(evidence);
        expect(waiting.selectors.size).toBeGreaterThan(0);
        expect(waiting.pending.sources.length).toBeGreaterThan(0);
        expect(waiting.pending.requirements.length).toBeGreaterThan(0);
        // Promote one waiting row back to verified without re-running the lane. Nothing
        // about the archive changed; what changed is that a claim now rests on it, and
        // the same drift that was pending is a false claim and fails closed.
        const promoted = fragment.requirements.find(
            (requirement) =>
                requirement.checkerInvariants.includes("ACQ-LIVE") &&
                requirement.status !== "verified"
        );
        expect(promoted).toBeDefined();
        expect(waiting.pending.requirements).toContain(promoted?.id);
        if (promoted === undefined) return;
        promoted.status = "verified";
        promoted.remainingEvidence = [];
        await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 4)}\n`, "utf8");
        expect(() => validateLiveEvidence(evidence)).toThrow(
            /Live evidence is stale for .*; re-run the live lane/u
        );
    });

    test("admits the tree's own ledger with its live substrate evidence retained", async () => {
        // The detached case below strips ACQ-LIVE, so nothing else runs the real fragments
        // through the checker while the archived lane is what their live selectors rest on.
        // That path is exactly where a drifted archive decides between a refusal and a
        // pending re-run, and where the index and the fragment have to agree on the gap.
        const fixture = await ledgerFixture(true);

        const building = runFixture(fixture);

        expect(building.status, building.stderr).toBe(0);
        expect(building.stderr).toBe("");
        const index = await readFixtureJson<{ externalGates: string[] }>(
            resolve(fixture, "conformance/index.json")
        );
        expect(building.stdout).toContain(`${index.externalGates.length} external gated`);
    });

    test("extracts a unique owner and digest for every §13 atom and §11 profile", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "agent-core-ledger-wrapped-profile-"));
        temporary.push(root);
        const specPath = resolve(root, "SPEC.md");
        const source = (await readFile(resolve(packageRoot, "SPEC.md"), "utf8")).replace(
            "- **P11-SHELL-CANCEL** Operation `cancel` has `mutate` impact.",
            "- [**P11-SHELL-CANCEL**](#cancel) Operation `cancel` has `mutate` impact."
        );
        expect(source).toContain("[**P11-SHELL-CANCEL**](#cancel)");
        await writeFile(specPath, source, "utf8");
        const parsed = await canonicalSpec(specPath);
        const requirements = parsed.requirements;
        expect(requirements.length).toBeGreaterThan(300);
        expect(new Set(requirements.map((item) => item.id)).size).toBe(requirements.length);
        expect(requirements.every((item) => /^W\d+$/.test(item.owner))).toBe(true);
        expect(requirements.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.digest))).toBe(true);
        const profileAnchorIds = parsed.anchors
            .filter((anchor) => anchor.id.startsWith("P11-"))
            .map((anchor) => anchor.id)
            .sort();
        expect(
            requirements.filter((item) => item.id.startsWith("P11-")).map((item) => item.id)
        ).toEqual(profileAnchorIds);
        expect(profileAnchorIds.some((id) => /^P11-\d/u.test(id))).toBe(false);
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
        // which means an atom with no prose anchor. Naming one and pasting its sentence in
        // couples the case to prose: C13-AUTH-PLANE stood here until its prose was bound,
        // at which point appending to its summary stopped moving its digest and the
        // assertion silently inverted, and a later rewording of the atom that replaced it
        // turned the replace into a no-op with the same result. So the subject is derived:
        // take an atom the parser reports as unanchored, and append to whatever line it
        // actually has.
        const anchored = new Set(
            stringsAt(
                await readArtifact("artifacts/quality/normative-map.json"),
                "authoritativeOutsideSection13"
            )
        );
        const unanchoredId = baseline
            .map((item) => item.id)
            .find((id) => id.startsWith("C13-") && !anchored.has(id));
        if (unanchoredId === undefined) {
            throw new TypeError("SPEC has no unanchored §13 atom to exercise summary hashing");
        }
        const summaryLine = original
            .split("\n")
            .find((line) => line.startsWith(`- **${unanchoredId}**`));
        if (summaryLine === undefined) {
            throw new TypeError(`No §13 summary line for ${unanchoredId}`);
        }
        const continuedPath = resolve(root, "continued.md");
        await writeFile(
            continuedPath,
            original.replace(summaryLine, `${summaryLine}\n\n  Additional exact evidence.`),
            "utf8"
        );
        const continued = await specRequirements(continuedPath);
        expect(continued.find((item) => item.id === unanchoredId)?.digest).not.toBe(
            baseline.find((item) => item.id === unanchoredId)?.digest
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

    test("hashes authoritative prose with its conformance summary and outside anchor", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "agent-core-normative-"));
        temporary.push(root);
        const originalPath = resolve(packageRoot, "SPEC.md");
        const original = await readFile(originalPath, "utf8");
        const baseline = await specRequirements(originalPath);
        const id = "C13-RUN-ADMISSION-REGISTRY";

        const summaryOnlyPath = resolve(root, "summary.md");
        const changedSummary = original.replace(
            "Every Run-associated asynchronous obligation uses canonical pre-remote identity reserve, completion, and close transitions in the Run-owner registry.",
            "Every Run-associated asynchronous obligation skips canonical pre-remote identity reserve, completion, and close transitions in the Run-owner registry."
        );
        expect(changedSummary).not.toBe(original);
        await writeFile(summaryOnlyPath, changedSummary, "utf8");
        const summaryOnly = await specRequirements(summaryOnlyPath);
        expect(summaryOnly.find((item) => item.id === id)?.digest).not.toBe(
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
        const fixture = await ledgerFixture(true, "detached");
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

    // conformance/schema.json declared the fragment shape while nothing compiled it, so
    // every pattern in it was documentation. These are the shapes it always claimed to
    // forbid, each of which reached the semantic checks instead of failing as a shape.
    test("rejects a fragment whose shape the conformance schema forbids", async () => {
        const fixture = await ledgerFixture();
        const seedPath = resolve(fixture, "conformance/seed.json");
        const originalSeed = await readFile(seedPath, "utf8");
        const malformed: ReadonlyArray<readonly [string, (seed: ConformanceFragment) => void]> = [
            [
                'must match pattern "^sha256:',
                (seed) => {
                    seed.requirements[0]!.specTextSha256 = "PENDING";
                }
            ],
            [
                'must match pattern "^sha256:',
                (seed) => {
                    seed.requirements[0]!.specTextSha256 = `sha256:${"A".repeat(64)}`;
                }
            ],
            [
                "must be equal to one of the allowed values",
                (seed) => {
                    seed.requirements[0]!.status = "almost-verified";
                }
            ],
            [
                "must NOT have duplicate items",
                (seed) => {
                    seed.requirements[0]!.remainingEvidence = ["same", "same"];
                }
            ],
            [
                'must match pattern "^W',
                (seed) => {
                    seed.requirements[0]!.owner = "w5";
                }
            ]
        ];
        for (const [expected, mutate] of malformed) {
            const seed: ConformanceFragment = JSON.parse(originalSeed);
            mutate(seed);
            await writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
            const result = runFixture(fixture);
            expect(result.status, expected).toBe(1);
            expect(result.stderr).toContain("Invalid conformance fragment seed.json");
            expect(result.stderr).toContain(expected);
        }
    });

    test("admits W9 composition and W0 cross-context requirement evidence", async () => {
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

        const qualityRequirement = seed.requirements.find(
            (item) => item.id === "C13-OWNERSHIP-ACTOR-CONTRACT"
        )!;
        const qualityFixture = await ledgerFixture();
        const qualitySelector =
            "test/conformance/ownership.test.ts#Actor ownership contract [C13-OWNERSHIP-ACTOR-CONTRACT] memory serializes, recovers, linearizes, and fences one command stream";
        markVerified(qualityRequirement, "src/actors/actor.ts#Actor", qualitySelector);
        await addFragment(qualityFixture, "quality-infrastructure.json", "W0", qualityRequirement);
        await writePassingSelectors(qualityFixture, [qualitySelector]);

        result = runFixture(qualityFixture);
        expect(result.status, result.stderr).toBe(0);
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

    // An `implemented` row's citations were examined by nothing: the deep checks ran over
    // `verified` and `external-gated` only, so a selector naming a test that did not exist —
    // or one that existed and failed — was as green as a citation that held. A citation is a
    // claim whichever status carries it.
    test("deep-checks an implemented row's citations exactly as a verified row's", async () => {
        const fixture = await ledgerFixture();
        const seed = await readFixtureJson<ConformanceFragment>(
            resolve(fixture, "conformance/seed.json")
        );
        const requirement = seed.requirements.find((item) => item.owner === "W1")!;
        const selector = "test/core/id.test.ts#TextId [C13-FIXTURE] refuses an empty identifier";

        // A gate observed only going red is indistinguishable from one that always does.
        markImplemented(requirement, "src/core/id.ts#TextId", selector);
        await addFragment(fixture, "foundation.json", "W1", requirement);
        await writePassingSelectors(fixture, [selector]);
        let result = runFixture(fixture);
        expect(result.status, result.stderr).toBe(0);

        // (a) The cited test does not exist. Exact string, not an aggregate: the report
        // executes a case in the same file, so any count-based check would still balance.
        markImplemented(requirement, "src/core/id.ts#TextId", `${selector} and a suffix`);
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("test did not pass");

        // (b) The cited test ran and failed, in the shape a real reporter emits it: the run
        // is unsuccessful and the assertion is not passing. Before the widening this fixture
        // never opened the report at all, because no row was verified or external-gated, so a
        // row could cite a test the report recorded as failed and stay green.
        markImplemented(requirement, "src/core/id.ts#TextId", selector);
        await addFragment(fixture, "foundation.json", "W1", requirement);
        await writeFile(
            resolve(fixture, "vitest.json"),
            `${JSON.stringify(
                {
                    success: false,
                    numTotalTests: 1,
                    numPassedTests: 0,
                    numFailedTests: 1,
                    numPendingTests: 0,
                    numTodoTests: 0,
                    testResults: [
                        {
                            name: selector.slice(0, selector.indexOf("#")),
                            assertionResults: [
                                {
                                    fullName: selector.slice(selector.indexOf("#") + 1),
                                    status: "failed"
                                }
                            ]
                        }
                    ]
                },
                null,
                2
            )}\n`,
            "utf8"
        );
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Test report is not successful");

        // (c) The cited source symbol no longer resolves.
        await writePassingSelectors(fixture, [selector]);
        markImplemented(requirement, "src/core/id.ts#MissingSymbol", selector);
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Stale source symbol");

        // (d) The cited test belongs to another wave.
        markImplemented(
            requirement,
            "src/core/id.ts#TextId",
            "test/facets/declarations.test.ts#a W3 case"
        );
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("test is owned by another wave");

        // (e) The cited symbol belongs to another wave.
        markImplemented(requirement, "src/facets/id.ts#BindingName", selector);
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("source is not owned by W1");
    });

    // The asymmetry between the two examined sets is deliberate. `implemented` MEANS
    // "declared incomplete" — validateStatus requires its remaining evidence to be
    // non-empty — so demanding a completed evidence run of it would collapse it into
    // `verified` rather than check it, and a row citing nothing is an honest declaration
    // rather than a false claim.
    test("keeps the implemented status distinct from verified while checking its claims", async () => {
        const fixture = await ledgerFixture();
        const seed = await readFixtureJson<ConformanceFragment>(
            resolve(fixture, "conformance/seed.json")
        );
        const requirement = seed.requirements.find((item) => item.owner === "W1")!;
        const selector = "test/core/id.test.ts#TextId [C13-FIXTURE] refuses an empty identifier";

        // An unexecuted checker invariant and a non-empty remainder are what make the row
        // incomplete; neither is held against it.
        markImplemented(requirement, "src/core/id.ts#TextId", selector);
        requirement.checkerInvariants = ["ACQ-ID"];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        await writePassingSelectors(fixture, [selector]);
        await writeFile(
            resolve(fixture, "invariants.json"),
            `${JSON.stringify({ passed: [] }, null, 2)}\n`,
            "utf8"
        );
        let result = runFixture(fixture);
        expect(result.status, result.stderr).toBe(0);
        const report = await readFixtureJson<{ uncitedImplemented: string[] }>(
            resolve(packageRoot, "reports/quality/conformance.json")
        );
        expect(report.uncitedImplemented).not.toContain(requirement.id);

        // A row citing nothing is enumerated, never failed.
        requirement.testSelectors = [];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status, result.stderr).toBe(0);
        expect(
            (
                await readFixtureJson<{ uncitedImplemented: string[] }>(
                    resolve(packageRoot, "reports/quality/conformance.json")
                )
            ).uncitedImplemented
        ).toContain(requirement.id);

        // The same evidence at `verified` still has to be complete, and its invariant still
        // has to have executed.
        markVerified(requirement, "src/core/id.ts#TextId", selector);
        requirement.remainingEvidence = ["Fixture: an unclosed obligation."];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("incomplete verified evidence");

        markVerified(requirement, "src/core/id.ts#TextId", selector);
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("invariant did not execute: ACQ-ID");
    });

    // `bounds` records what a rule deliberately does NOT claim. `remainingEvidence` records
    // what evidence is still owed. They are two facts, and the schema had one field for both:
    // because `verified` requires `remainingEvidence` empty, promotion to `verified` was
    // DESTRUCTIVE rather than additive — it erased a row's only prose channel, so raising a row
    // deleted what that row said about its own scope. These cases pin the two properties that
    // make the second field worth having, neither of which any absent constraint can express:
    // every status admits a bound, and no evidence check reads one.
    test("admits a bound at every status and reads it as evidence at none", async () => {
        const fixture = await ledgerFixture();
        const seed = await readFixtureJson<ConformanceFragment>(
            resolve(fixture, "conformance/seed.json")
        );
        const requirement = seed.requirements.find((item) => item.owner === "W1")!;
        const selector = "test/core/id.test.ts#TextId [C13-FIXTURE] refuses an empty identifier";
        const bound =
            "Fixture bound: the rule does not claim that a decoded identifier round-trips through " +
            "a foreign codec, and nothing downstream depends on that property holding.";

        // `verified` is the status the field exists for: it is the one status whose prose channel
        // is forced empty, so a bound surviving here is the whole point.
        markVerified(requirement, "src/core/id.ts#TextId", selector);
        requirement.bounds = [bound];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        await writePassingSelectors(fixture, [selector]);
        await writeFile(
            resolve(fixture, "invariants.json"),
            `${JSON.stringify({ passed: ["ACQ-ID"] }, null, 2)}\n`,
            "utf8"
        );
        let result = runFixture(fixture);
        expect(result.status, result.stderr).toBe(0);

        // The same row, same bound, at every other status. A bound costs nothing to carry, which
        // is exactly what makes promotion non-lossy.
        markImplemented(requirement, "src/core/id.ts#TextId", selector);
        requirement.bounds = [bound];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        expect(runFixture(fixture).status, runFixture(fixture).stderr).toBe(0);

        requirement.status = "external-gated";
        requirement.remainingEvidence = ["Fixture: gated on a consent this fixture never grants."];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        await gateExternally(fixture, requirement.id);
        result = runFixture(fixture);
        expect(result.status, result.stderr).toBe(0);

        // And `planned`, which carries prose and nothing else — so a bound rides alongside the
        // one field that status is defined by, without being confused for it.
        requirement.status = "planned";
        requirement.sourceSymbols = [];
        requirement.testSelectors = [];
        requirement.checkerInvariants = [];
        requirement.remainingEvidence = ["Fixture: the rule's remaining evidence is unwritten."];
        requirement.bounds = [bound];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        await gateExternally(fixture, undefined);
        result = runFixture(fixture);
        expect(result.status, result.stderr).toBe(0);

        // `bounds` does not relax the constraint beside it: a `verified` row still may not carry
        // remaining evidence, and carrying a bound does not buy it the right to.
        markVerified(requirement, "src/core/id.ts#TextId", selector);
        requirement.bounds = [bound];
        requirement.remainingEvidence = ["Fixture: an unclosed obligation."];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("incomplete verified evidence");

        // Nor does it satisfy one: a row whose only named symbol lives inside a bound has no
        // source evidence at all, because nothing reads the bound.
        markVerified(requirement, "src/core/id.ts#TextId", selector);
        requirement.sourceSymbols = [];
        requirement.bounds = [`${bound} The mechanism is src/core/id.ts#TextId.`];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        result = runFixture(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("incomplete verified evidence");
    });

    // The inverse of the case above, and the one that fails loudly if a later gate ever iterates
    // `bounds` the way it iterates `sourceSymbols`. Each string below would be refused by a
    // different evidence check if it were read as a citation: an unresolvable symbol by
    // `resolveSourceSymbol`, a foreign wave's path by `requireEvidenceOwner`, a selector naming
    // no executed test by `requirePassingTests`, and an unknown invariant by the execution check.
    // A bound naming any of them is prose, so the row must pass.
    test("never treats a bound's contents as a citation, a label, or a debt", async () => {
        const fixture = await ledgerFixture();
        const seed = await readFixtureJson<ConformanceFragment>(
            resolve(fixture, "conformance/seed.json")
        );
        const requirement = seed.requirements.find((item) => item.owner === "W1")!;
        const selector = "test/core/id.test.ts#TextId [C13-FIXTURE] refuses an empty identifier";

        markVerified(requirement, "src/core/id.ts#TextId", selector);
        requirement.bounds = [
            "Fixture bound naming a symbol that does not exist: the rule does not claim anything " +
                "about src/core/id.ts#NoSuchSymbolAnywhere, which resolveSourceSymbol would refuse.",
            "Fixture bound naming another wave's file: not claimed for src/slates/skeleton.ts#Slate " +
                "or cloudflare/src/index.ts#Adapter, either of which requireEvidenceOwner would refuse.",
            "Fixture bound naming an unexecuted test and an unknown invariant: no claim is made by " +
                "test/core/absent.test.ts#nothing ran this, nor by invariant ACQ-NO-SUCH-INVARIANT.",
            "Fixture bound naming a sibling atom id, C13-PROTOCOL-OUTCOMES, which is a reference in " +
                "prose and must not be read as this row's prerequisite, citation, or coherence label."
        ];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        await writePassingSelectors(fixture, [selector]);
        await writeFile(
            resolve(fixture, "invariants.json"),
            `${JSON.stringify({ passed: ["ACQ-ID"] }, null, 2)}\n`,
            "utf8"
        );
        const result = runFixture(fixture);
        expect(result.status, result.stderr).toBe(0);
    });

    // Shape is the only thing enforced, and it has to be enforced, or the field degrades into a
    // comment nothing can contradict. The floor rejects a non-statement; uniqueness stops one
    // sentence being spread across a row; the key set stops a typo becoming a silent no-op.
    test("enforces the bound's shape and nothing else about it", async () => {
        const fixture = await ledgerFixture();
        const seed = await readFixtureJson<ConformanceFragment>(
            resolve(fixture, "conformance/seed.json")
        );
        const requirement = seed.requirements.find((item) => item.owner === "W1")!;
        const selector = "test/core/id.test.ts#TextId [C13-FIXTURE] refuses an empty identifier";
        const bound =
            "Fixture bound: the rule does not claim that a decoded identifier round-trips through " +
            "a foreign codec, and nothing downstream depends on that property holding.";
        markVerified(requirement, "src/core/id.ts#TextId", selector);
        await writePassingSelectors(fixture, [selector]);
        await writeFile(
            resolve(fixture, "invariants.json"),
            `${JSON.stringify({ passed: ["ACQ-ID"] }, null, 2)}\n`,
            "utf8"
        );

        // An empty array is legal — the field is optional and defaults to nothing — so this
        // case is what keeps the refusals below from being vacuous.
        requirement.bounds = [];
        await addFragment(fixture, "foundation.json", "W1", requirement);
        expect(runFixture(fixture).status).toBe(0);

        const refusals: ReadonlyArray<readonly [JsonValue, string]> = [
            ["not an array at all", "bounds must be array"],
            [[bound, bound], "bounds must NOT have duplicate items"],
            [["Not covered."], "bounds/0 must NOT have fewer than 80 characters"],
            [[""], "bounds/0 must NOT have fewer than 80 characters"]
        ];
        for (const [value, message] of refusals) {
            await addFragment(fixture, "foundation.json", "W1", { ...requirement, bounds: value });
            const refused = runFixture(fixture);
            expect(refused.status, `${JSON.stringify(value)} was admitted`).toBe(1);
            expect(refused.stderr).toContain(message);
        }

        // A misspelled field is a shape error rather than a silently ignored one, because the
        // compiled schema forbids additional properties and runs before the exact-key check.
        delete requirement.bounds;
        await addFragment(fixture, "foundation.json", "W1", { ...requirement, bound: [bound] });
        const typo = runFixture(fixture);
        expect(typo.status).toBe(1);
        expect(typo.stderr).toContain("must NOT have additional properties");
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

async function ledgerFixture(
    preserveActiveFragments = false,
    liveEvidence: "retained" | "detached" = "retained"
): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-ledger-"));
    temporary.push(root);
    await cp(resolve(packageRoot, "artifacts/conformance"), resolve(root, "conformance"), {
        recursive: true
    });
    const indexPath = resolve(root, "conformance/index.json");
    const index = await readFixtureJson<ConformanceIndex>(indexPath);
    if (liveEvidence === "detached") {
        await Promise.all(
            index.fragments.map(async (name) => {
                const path = resolve(root, "conformance", name);
                const fragment = await readFixtureJson<ConformanceFragment>(path);
                for (const requirement of fragment.requirements) {
                    requirement.checkerInvariants = requirement.checkerInvariants.filter(
                        (invariant) => invariant !== "ACQ-LIVE"
                    );
                }
                await writeFile(path, `${JSON.stringify(fragment, null, 4)}\n`, "utf8");
            })
        );
    }
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
              // The ledger deep-checks a cited selector at `implemented` too, so the
              // fixture's report must execute those citations as well.
              .filter((requirement) =>
                  ["verified", "external-gated", "implemented"].includes(requirement.status)
              )
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
    requirement: WrittenRequirement
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

async function gateExternally(root: string, id: string | undefined): Promise<void> {
    const indexPath = resolve(root, "conformance/index.json");
    const index = await readFixtureJson<ConformanceIndex>(indexPath);
    index["externalGates"] = id === undefined ? [] : [id];
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
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

function run(args: string[]): QualitySubprocessResult {
    return runQualitySubprocess(process.execPath, [checker, ...args], packageRoot);
}

function runFixture(
    root: string,
    stage: "building" | "final" = "building",
    hermetic = false
): QualitySubprocessResult {
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

/**
 * Evidence a row cites while declaring itself incomplete: source symbols and test selectors
 * that must resolve, a non-empty remainder that keeps the row below `verified`, and no
 * checker invariants — validateStatus admits an `implemented` row only with remaining
 * evidence, so its invariants are never required to have executed.
 */
function markImplemented(
    requirement: ConformanceRequirement,
    source: string,
    testSelector: string
): void {
    requirement.status = "implemented";
    requirement.sourceSymbols = [source];
    requirement.testSelectors = [testSelector];
    requirement.checkerInvariants = [];
    requirement.remainingEvidence = ["Fixture: the rule's remaining evidence is unwritten."];
}
