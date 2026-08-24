import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSpec } from "./spec.mjs";
import { isJsonObject } from "./project.mjs";
import { allowedBuiltInAxioms } from "../formal-policy.mjs";

/**
 * The controlled-language gate.
 *
 * Lean owns the grammar, the lexicon, the corpus, and every decision about sentences.
 * `formal/SpecCnl/Report.lean` emits one line of JSON describing all of it plus one axiom
 * designation per registered declaration; this script checks that output against the SPEC
 * and against the reviewed reachability record, then writes the ledger artifact.
 *
 * Nothing here re-parses a sentence, re-reads a category, or re-decides anything Lean
 * already decided. What this script adds is exactly what Lean cannot see:
 *
 * - whether each corpus unit's rule-unit digest still matches `scripts/quality/spec.mjs`
 *   (a stale pairing must return for review);
 * - whether the hard-exclusion list is exact, mechanically justified, and not a
 *   denominator shrink;
 * - whether every audited declaration is sorry-free and depends only on reviewed
 *   built-in axioms;
 * - whether the adversarial evidence stayed adversarial (every negative case refused,
 *   every scramble refused, every round trip exact); and
 * - whether the checked-in snapshot matches what Lean emitted this run.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const formalRoot = join(packageRoot, "formal");

/** The reviewed inputs this gate mutates checks against live under one directory, so a
 * fixture run can point the check at a scratch copy with `--artifact-root` while the
 * sources, the SPEC, and Lean stay exactly where they are. */
function artifactRootFromArgv(argv) {
    const flagIndex = argv.indexOf("--artifact-root");
    if (flagIndex === -1) return join(packageRoot, "artifacts", "cnl");
    const given = argv[flagIndex + 1];
    if (given === undefined || given.startsWith("--")) {
        throw new TypeError("--artifact-root requires a directory");
    }
    return resolve(given);
}

const lakeCommand = process.env.LEAN_LAKE?.trim() || "lake";

const failures = [];

function fail(message) {
    failures.push(message);
}

function reportFailures(exitCode = 1) {
    for (const failure of [...failures].sort()) {
        console.error(`cnl: ${failure}`);
    }
    process.exit(exitCode);
}

const AXIOM_DESIGNATION_PATTERN = /^'([A-Za-z_][A-Za-z0-9_.]*)' does not depend on any axioms$/u;
const AXIOM_LIST_PATTERN = /^'([A-Za-z_][A-Za-z0-9_.]*)' depends on axioms: \[(.*)\]$/u;

/** Runs the Lean report and splits its two outputs. */
function runLeanReport() {
    const result = spawnSync(lakeCommand, ["env", "lean", join("SpecCnl", "Report.lean")], {
        cwd: formalRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.status !== 0) {
        throw new TypeError(
            `lake env lean SpecCnl/Report.lean failed with status ${result.status}: ${result.stderr}`
        );
    }
    const designations = new Map();
    let ledgerLine = null;
    for (const rawLine of result.stdout.split(/\r?\n/u)) {
        const line = rawLine.trim();
        const plain = AXIOM_DESIGNATION_PATTERN.exec(line);
        if (plain !== null) {
            designations.set(plain[1], []);
            continue;
        }
        const listed = AXIOM_LIST_PATTERN.exec(line);
        if (listed !== null) {
            const axioms = listed[2]
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean);
            designations.set(listed[1], axioms);
            continue;
        }
        if (line.startsWith("cnl-ledger ")) {
            if (ledgerLine !== null) throw new TypeError("the Lean report printed two ledgers");
            ledgerLine = line.slice("cnl-ledger ".length);
        }
    }
    if (ledgerLine === null) throw new TypeError("the Lean report printed no cnl-ledger line");
    const ledger = JSON.parse(ledgerLine);
    if (!isJsonObject(ledger)) throw new TypeError("the Lean ledger is not an object");
    return { designations, ledger };
}

async function verifyControlledLanguage(artifactsRoot = join(packageRoot, "artifacts", "cnl")) {
    return verify(artifactsRoot);
}

// --- Verification ---------------------------------------------------------------

/** Runs the whole check and reports. Exits non-zero on any refusal; resolves with the
 * summary line otherwise, so the traceability gate can run this as one step. */
async function verify(artifactsRoot) {
    const { designations, ledger } = (() => {
        try {
            return runLeanReport();
        } catch (error) {
            console.error(`cnl: ${error.message}`);
            process.exit(1);
        }
    })();

    // --- Ledger shape -------------------------------------------------------------

    for (const field of [
        "grammar",
        "lexicon",
        "unexercisedEntries",
        "units",
        "auditedNames",
        "divergenceNames",
        "adversarial",
        "negativeCorpus"
    ]) {
        if (!(field in ledger)) fail(`the Lean ledger is missing ${field}`);
    }
    if (!Array.isArray(ledger.units) || ledger.units.length === 0) {
        fail("the Lean ledger carries no units");
    }
    if (!Array.isArray(ledger.lexicon) || ledger.lexicon.length === 0) {
        fail("the Lean ledger carries no lexicon");
    }

    // --- Axiom hygiene ------------------------------------------------------------

    if (!Array.isArray(ledger.auditedNames) || ledger.auditedNames.length === 0) {
        fail("no declaration is designated for the axiom report");
    }
    const allowedAxiomSet = new Set(allowedBuiltInAxioms);
    for (const name of ledger.auditedNames) {
        if (!designations.has(name)) {
            fail(`registered declaration was never designated: ${name}`);
            continue;
        }
        for (const axiom of designations.get(name)) {
            if (!allowedAxiomSet.has(axiom)) {
                fail(`${name} depends on non-reviewed axiom ${axiom}`);
            }
        }
    }
    for (const name of designations.keys()) {
        if (!ledger.auditedNames.includes(name)) {
            fail(`designated declaration is not registered in the corpus: ${name}`);
        }
    }
    if (designations.has("sorryAx") || [...designations.values()].flat().includes("sorryAx")) {
        fail("a controlled-language declaration depends on sorryAx");
    }

    // --- Adversarial evidence -----------------------------------------------------

    const adversarial = ledger.adversarial ?? {};
    if (
        adversarial.negativeRefused !== adversarial.negativeCases ||
        adversarial.negativeCases < 1
    ) {
        fail(
            `only ${adversarial.negativeRefused} of ${adversarial.negativeCases} negative cases are refused`
        );
    }
    if (adversarial.ambiguityCases < 1) {
        fail("the negative corpus no longer exercises ambiguity refusal");
    }
    if (adversarial.scrambles < 1 || adversarial.scramblesAdmitted !== 0) {
        fail(
            `${adversarial.scramblesAdmitted} of ${adversarial.scrambles} scrambles were admitted; ` +
                "linearisation would be echoing surface order"
        );
    }
    if (adversarial.roundTripExact !== ledger.units.length) {
        fail(
            `only ${adversarial.roundTripExact} of ${ledger.units.length} units round-trip exactly`
        );
    }

    // --- Corpus integrity ---------------------------------------------------------

    if ((ledger.unexercisedEntries ?? []).length > 0) {
        fail(`unexercised lexicon entries: ${ledger.unexercisedEntries.join(", ")}`);
    }

    const spec = await canonicalSpec();
    const conformance = spec.sections.find((section) => section.id === "13");

    /** The distinct §1-12 rule units of the reviewed atoms, keyed by their digested body. */
    function reviewedRuleUnits() {
        const units = new Map();
        for (const atom of spec.atoms) {
            if (!atom.reviewed) continue;
            const anchor = spec.anchors.find(
                (candidate) =>
                    candidate.id === atom.id &&
                    (candidate.start < conformance.start || candidate.start >= conformance.end)
            );
            if (anchor === undefined) {
                fail(`reviewed atom has no §1-12 anchor: ${atom.id}`);
                continue;
            }
            const [ruleUnit] = atom.text.split(" §13 summary: ");
            const body = ruleUnit.replace(/\s*This maps to \*\*C13-[A-Z0-9-]+\*\*\.?$/u, "").trim();
            const digest = createHash("sha256").update(body).digest("hex");
            const entry = units.get(digest) ?? { body, digest, atoms: [] };
            entry.atoms.push(atom.id);
            units.set(digest, entry);
        }
        return units;
    }

    const ruleUnits = reviewedRuleUnits();

    /** A unit is hard-excluded only for a reason this script can itself verify from the
     * digested text. `embedded-table` means the unit's normative content includes a Markdown
     * table rendered as part of the prose; without a table-to-sentences preprocessor there is
     * nothing for a controlled sentence to carry. Every other reason ever proposed for an
     * exclusion — naming no model type, self-reference, cross-references — turned out to be a
     * heuristic over wording, so it excludes nothing here. */
    const exclusionReasons = Object.freeze(["embedded-table"]);

    function verifyExclusions(artifactsRoot) {
        const exclusionsPath = join(artifactsRoot, "exclusions.json");
        const parsed = JSON.parse(readFileSync(exclusionsPath, "utf8"));
        const keys = Object.keys(parsed).sort();
        if (
            JSON.stringify(keys) !==
            JSON.stringify(["exclusions", "measured", "note", "reachableFloor"])
        ) {
            fail("exclusions.json does not have exactly the expected fields");
            return null;
        }
        const excludedAtoms = new Set();
        for (const exclusion of parsed.exclusions) {
            if (Object.keys(exclusion).sort().join(",") !== "atoms,reason") {
                fail(`an exclusion does not name exactly atoms and reason`);
                continue;
            }
            if (!exclusionReasons.includes(exclusion.reason)) {
                fail(`unknown exclusion reason: ${exclusion.reason}`);
                continue;
            }
            const digests = [];
            for (const atomId of exclusion.atoms) {
                const unit = [...ruleUnits.values()].find((entry) => entry.atoms.includes(atomId));
                if (unit === undefined) {
                    fail(`exclusion names a non-reviewed atom: ${atomId}`);
                    continue;
                }
                digests.push(unit.digest);
                excludedAtoms.add(atomId);
                if (exclusion.reason === "embedded-table" && !/\|\s*-{3}/u.test(unit.body)) {
                    fail(`exclusion of ${atomId} is unjustified: the rule unit embeds no table`);
                }
            }
            const owners = new Set(
                exclusion.atoms.map((atomId) => {
                    const unit = [...ruleUnits.values()].find((entry) =>
                        entry.atoms.includes(atomId)
                    );
                    return unit === undefined ? null : unit.digest;
                })
            );
            if (owners.size !== 1) {
                fail("one exclusion spans several distinct rule units; split it");
            }
        }
        return { record: parsed, excludedAtoms };
    }

    mkdirSync(artifactsRoot, { recursive: true });
    let reachability = null;
    try {
        reachability = verifyExclusions(artifactsRoot);
    } catch (error) {
        fail(`could not check exclusions.json: ${error.message}`);
    }

    if (reachability !== null) {
        const totalUnits = ruleUnits.size;
        const excludedUnits = [...ruleUnits.values()].filter((unit) =>
            unit.atoms.some((atom) => reachability.excludedAtoms.has(atom))
        ).length;
        const reachable = totalUnits - excludedUnits;
        const measured = {
            distinctRuleUnits: totalUnits,
            hardExclusions: excludedUnits,
            reachable,
            provedBridges: ledger.units.length
        };
        if (reachable < reachability.record.reachableFloor) {
            fail(
                `the reachable denominator shrank: ${reachable} reachable units against a ` +
                    `recorded floor of ${reachability.record.reachableFloor}`
            );
        }
        reachability.measured = measured;
    }

    // --- Unit bindings ------------------------------------------------------------

    const seenKeys = new Set();
    const seenAtoms = new Set();
    for (const unit of ledger.units) {
        if (seenKeys.has(unit.key)) fail(`two ledger units share the key ${unit.key}`);
        seenKeys.add(unit.key);
        for (const required of [
            "atoms",
            "digest",
            "sentence",
            "ast",
            "lean",
            "heads",
            "dropped",
            "proposition",
            "handProposition",
            "bridge",
            "discharge"
        ]) {
            if (!(required in unit)) fail(`ledger unit ${unit.key} is missing ${required}`);
        }
        if (!Array.isArray(unit.dropped) || unit.dropped.length === 0) {
            fail(`${unit.key} records no dropped clause`);
        }
        for (const atom of unit.atoms) {
            if (seenAtoms.has(atom)) {
                fail(`two ledger units claim the atom ${atom}`);
            }
            seenAtoms.add(atom);
            const entry = [...ruleUnits.values()].find((candidate) =>
                candidate.atoms.includes(atom)
            );
            if (entry === undefined) {
                fail(`${unit.key} anchors to a non-reviewed atom: ${atom}`);
                continue;
            }
            if (entry.digest !== unit.digest) {
                fail(
                    `${unit.key} is stale: its rule-unit digest changed. The reviewed sentence ` +
                        "must be revisited against the new prose before it can stand."
                );
            }
            if (reachability !== null && reachability.excludedAtoms.has(atom)) {
                fail(`${unit.key} bridges a hard-excluded rule unit (${atom})`);
            }
        }
        for (const role of ["proposition", "handProposition", "bridge", "discharge"]) {
            if (!ledger.auditedNames.includes(unit[role])) {
                fail(`${unit.key} declares ${role} ${unit[role]} but it is not audited`);
            }
        }
    }

    // --- Snapshot -----------------------------------------------------------------

    const ledgerPath = join(artifactsRoot, "ledger.json");
    const rendered = `${JSON.stringify(ledger, null, 2)}\n`;
    if (!existsSync(ledgerPath)) {
        writeFileSync(ledgerPath, rendered, "utf8");
        console.log(`cnl: wrote ${ledgerPath}; review it and commit`);
    } else if (readFileSync(ledgerPath, "utf8") !== rendered) {
        fail(
            `artifacts/cnl/ledger.json is stale against the current Lean report; regenerate ` +
                "it, review the diff, and commit"
        );
    }

    if (failures.length > 0) reportFailures();

    const summary =
        `controlled language verified: ${ledger.units.length} bridged units, ` +
        `${designations.size} declarations sorry-free, ` +
        `${ledger.lexicon.length} exercised lexicon entries, ` +
        `${adversarial.negativeCases} negative cases and ${adversarial.scrambles} scrambles refused, ` +
        `${reachability?.measured.reachable}/${reachability?.measured.distinctRuleUnits} reachable rule units ` +
        `(floor ${reachability?.record.reachableFloor}, ${reachability?.measured.hardExclusions} enumerated exclusions)`;
    console.log(summary);
    return summary;
}

export { verifyControlledLanguage };

const invokedDirectly =
    process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) await verifyControlledLanguage(artifactRootFromArgv(process.argv));
