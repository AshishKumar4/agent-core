import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format as formatWithPrettier, resolveConfig } from "prettier";
import { canonicalSpec } from "./spec.mjs";
import { isJsonObject } from "./project.mjs";
import { allowedBuiltInAxioms } from "../formal-policy.mjs";

/**
 * The ratified-intent gate.
 *
 * Lean owns the intent language, the checker, and every verdict.
 * `formal/SpecCnl/Intent/Report.lean` emits one line of JSON describing all of it plus one
 * axiom designation per registered declaration; this script checks that output against the
 * SPEC and the normative manifest, then writes the ledger artifact that ratification pins.
 *
 * Nothing here re-parses a sentence, re-splits an intent, or re-decides a verdict. What it
 * adds is exactly what Lean cannot see:
 *
 * - the SHA-256 of each head's reviewed denotation text, so an edited entry re-opens review;
 * - whether each anchored §13 atom is reviewed and its rule-unit digest still matches
 *   `scripts/quality/spec.mjs` (a stale pairing must return for review);
 * - the `artifacts/normative.lock` declaration digest of every model constant a record's
 *   heads name, and of every declaration its ledger row binds;
 * - whether every audited declaration is sorry-free and depends only on reviewed built-in
 *   axioms;
 * - whether every decided verdict carries the witness or refutation its kind requires; and
 * - whether the checked-in snapshot matches what Lean emitted this run.
 *
 * The approval of the change that lands the snapshot is the ratification. A later change to
 * any pinned input fails this gate until a human re-approves a regenerated snapshot.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const formalRoot = join(packageRoot, "formal");

/** Reviewed inputs live under one directory so a fixture run can point the check at a
 * scratch copy with `--artifact-root` while the sources, the SPEC, and Lean stay where they
 * are. */
function artifactRootFromArgv(argv) {
    const flagIndex = argv.indexOf("--artifact-root");
    if (flagIndex === -1) return join(packageRoot, "artifacts", "intents");
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
        console.error(`intents: ${failure}`);
    }
    process.exit(exitCode);
}

const AXIOM_DESIGNATION_PATTERN = /^'([A-Za-z_][A-Za-z0-9_.]*)' does not depend on any axioms$/u;
const AXIOM_LIST_PATTERN = /^'([A-Za-z_][A-Za-z0-9_.]*)' depends on axioms: \[(.*)\]$/u;

/** The verdicts a record may hold, and the evidence each one owes.
 *
 * `UNPROVED` is absent on purpose: it is what the instrument returns when a proof is
 * missing, so a record holding it would be a record claiming nothing. A report that carries
 * it is a refusal here rather than a row in the artifact. */
const evidenceByVerdict = Object.freeze({
    CONSISTENT: Object.freeze(["witnessProof"]),
    INCONSISTENT: Object.freeze(["refutationProof"]),
    "OUTSIDE-MODEL": Object.freeze(["witnessProof", "refutationProof"])
});

/** Runs the Lean report and splits its outputs.
 *
 * The library is built first, and that is not a convenience. `Intent/Report.lean` asserts
 * every declaration shape and `Intent/Hostile.lean` asserts every refusal, and both run
 * while the *library* elaborates. Reading the report off a cold or stale cache would run
 * neither, so a tree whose guards fail could still produce a clean report. */
function runLeanReport() {
    const build = spawnSync(lakeCommand, ["build", "SpecCnl"], {
        cwd: formalRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
    });
    if (build.status !== 0) {
        throw new TypeError(
            `lake build SpecCnl failed with status ${build.status}: ` +
                `${[build.stdout, build.stderr].filter(Boolean).join("\n")}`
        );
    }
    const result = spawnSync(
        lakeCommand,
        ["env", "lean", join("SpecCnl", "Intent", "Report.lean")],
        { cwd: formalRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    if (result.status !== 0) {
        throw new TypeError(
            `lake env lean SpecCnl/Intent/Report.lean failed with status ${result.status}: ` +
                `${result.stderr}`
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
            designations.set(
                listed[1],
                listed[2]
                    .split(",")
                    .map((name) => name.trim())
                    .filter(Boolean)
            );
            continue;
        }
        if (line.startsWith("intent-ledger ")) {
            if (ledgerLine !== null) throw new TypeError("the Lean report printed two ledgers");
            ledgerLine = line.slice("intent-ledger ".length);
        }
    }
    if (ledgerLine === null) throw new TypeError("the Lean report printed no intent-ledger line");
    const ledger = JSON.parse(ledgerLine);
    if (!isJsonObject(ledger)) throw new TypeError("the Lean intent ledger is not an object");
    return { designations, ledger };
}

async function verifyRatifiedIntents(artifactsRoot = join(packageRoot, "artifacts", "intents")) {
    return verify(artifactsRoot);
}

/** Artifact JSON is written in the repository's prettier style, so this gate's byte
 * comparison and the format gate accept the same bytes from one serialization. */
async function renderJsonArtifact(path, value) {
    const source = `${JSON.stringify(value, null, 2)}\n`;
    const config = await resolveConfig(join(packageRoot, "package.json"));
    return formatWithPrettier(source, { ...config, filepath: path });
}

function sha256(text) {
    return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** The reviewed §1-12 rule units of the reviewed atoms, keyed by their digested body. This
 * is the derivation `scripts/quality/cnl.mjs` uses, unchanged: an intent and a corpus unit
 * may anchor one atom, and the digest they both carry is what keeps them in step. */
function reviewedRuleUnits(spec) {
    const conformance = spec.sections.find((section) => section.id === "13");
    const units = new Map();
    for (const atom of spec.atoms) {
        if (!atom.reviewed) continue;
        const anchor = spec.anchors.find(
            (candidate) =>
                candidate.id === atom.id &&
                (candidate.start < conformance.start || candidate.start >= conformance.end)
        );
        if (anchor === undefined) continue;
        const [ruleUnit] = atom.text.split(" §13 summary: ");
        const body = ruleUnit.replace(/\s*This maps to \*\*C13-[A-Z0-9-]+\*\*\.?$/u, "").trim();
        const digest = createHash("sha256").update(body).digest("hex");
        const entry = units.get(digest) ?? { body, digest, atoms: [] };
        entry.atoms.push(atom.id);
        units.set(digest, entry);
    }
    return units;
}

/** The normative manifest's per-name digests, so a record's pin moves when a model
 * definition's type or value changes, or when a bound theorem's statement does.
 *
 * The manifest keeps two surfaces and a name lives in exactly one of them: a *definition*
 * is in `declarations[]` with a `sha256` over its type and value, and a *claim* — every
 * theorem, including the executable mirror's soundness and completeness — is in
 * `designations[]` with a `typeSha256`, a `semanticClosureSha256`, and its axiom list. A
 * ledger row binds both kinds, so both are resolved here and the row's theorems get their
 * axioms cross-checked against the same reviewed set this gate applies to its own. */
function normativeManifest() {
    const path = join(packageRoot, "artifacts", "normative.lock");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const digests = new Map();
    for (const declaration of parsed.declarations ?? []) {
        digests.set(declaration.name, {
            digest: declaration.sha256,
            kind: "definition",
            axioms: null
        });
    }
    for (const designation of parsed.designations ?? []) {
        digests.set(designation.name, {
            digest: designation.typeSha256,
            closure: designation.semanticClosureSha256,
            kind: designation.kind ?? "claim",
            axioms: designation.axioms ?? []
        });
    }
    return { digests, pins: parsed.pins ?? {} };
}

// --- Verification ---------------------------------------------------------------

/** Runs the whole check and reports. Exits non-zero on any refusal; resolves with the
 * summary line otherwise. */
async function verify(artifactsRoot) {
    const { designations, ledger } = (() => {
        try {
            return runLeanReport();
        } catch (error) {
            console.error(`intents: ${error.message}`);
            process.exit(1);
        }
    })();

    // --- Ledger shape -------------------------------------------------------------

    for (const field of [
        "grammar",
        "ledgers",
        "connectives",
        "conjunction",
        "entries",
        "unexercisedEntries",
        "atoms",
        "records",
        "adversarialRecords",
        "auditedNames",
        "lemmaNames",
        "adversarial",
        "negativeCorpus"
    ]) {
        if (!(field in ledger)) fail(`the Lean intent ledger is missing ${field}`);
    }
    if (!Array.isArray(ledger.records) || ledger.records.length === 0) {
        fail("the Lean intent ledger carries no ratifiable record");
    }
    if (!Array.isArray(ledger.adversarialRecords) || ledger.adversarialRecords.length === 0) {
        fail("the Lean intent ledger carries no adversarial record");
    }
    if ((ledger.unexercisedEntries ?? []).length > 0) {
        fail(`unexercised intent entries: ${ledger.unexercisedEntries.join(", ")}`);
    }

    // --- Axiom hygiene ------------------------------------------------------------

    if (!Array.isArray(ledger.auditedNames) || ledger.auditedNames.length === 0) {
        fail("no intent declaration is designated for the axiom report");
    }
    const allowedAxiomSet = new Set(allowedBuiltInAxioms);
    for (const name of ledger.auditedNames ?? []) {
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
            fail(`designated declaration is not registered in the intent corpus: ${name}`);
        }
    }
    if (designations.has("sorryAx") || [...designations.values()].flat().includes("sorryAx")) {
        fail("an intent declaration depends on sorryAx");
    }
    for (const name of ledger.lemmaNames ?? []) {
        if (!ledger.auditedNames.includes(name)) {
            fail(`the algorithm's lemma ${name} is not audited`);
        }
    }

    // --- Adversarial evidence -----------------------------------------------------

    const adversarial = ledger.adversarial ?? {};
    if (
        adversarial.negativeRefused !== adversarial.negativeCases ||
        adversarial.negativeCases < 1
    ) {
        fail(
            `only ${adversarial.negativeRefused} of ${adversarial.negativeCases} negative intent ` +
                "sentences are refused"
        );
    }
    if (adversarial.ambiguityCases < 1) {
        fail("the negative intent corpus no longer exercises ambiguity refusal");
    }
    if (adversarial.scrambles < 1 || adversarial.scramblesAdmitted !== 0) {
        fail(
            `${adversarial.scramblesAdmitted} of ${adversarial.scrambles} scrambles were admitted; ` +
                "linearisation would be echoing surface order"
        );
    }
    const allRecords = [...(ledger.records ?? []), ...(ledger.adversarialRecords ?? [])];
    if (adversarial.roundTripExact !== allRecords.length) {
        fail(
            `only ${adversarial.roundTripExact} of ${allRecords.length} intent records ` +
                "round-trip exactly"
        );
    }

    // --- Ledger table binding -----------------------------------------------------

    const { digests, pins } = normativeManifest();
    const ledgerRows = new Map();
    for (const row of ledger.ledgers ?? []) {
        ledgerRows.set(row.key, row);
        for (const name of [
            row.state,
            row.label,
            row.step,
            row.exec,
            ...(row.initial === null ? [] : [row.initial])
        ]) {
            const known = digests.get(name);
            if (known === undefined) {
                fail(
                    `ledger row ${row.key} binds ${name}, which the normative manifest does not ` +
                        "declare; a ledger may only bind a reviewed model declaration"
                );
            } else if (known.kind !== "definition") {
                fail(
                    `ledger row ${row.key} binds ${name} as a definition, but the normative ` +
                        `manifest records it as a ${known.kind}`
                );
            }
        }
        // The mirror's two theorems are claims, not definitions, so the manifest pins them
        // under `designations[]` with a statement digest and an axiom list. Both are read:
        // a ledger row whose soundness theorem grew an axiom this repository does not review
        // would otherwise pass every other check here.
        for (const name of [row.soundness, row.completeness]) {
            const known = digests.get(name);
            if (known === undefined) {
                fail(
                    `ledger row ${row.key} binds theorem ${name}, which the normative manifest ` +
                        "does not designate; the executable mirror's soundness and completeness " +
                        "have to be reviewed claims"
                );
                continue;
            }
            if (known.kind === "definition") {
                fail(`ledger row ${row.key} binds ${name} as a theorem, but it is a definition`);
                continue;
            }
            for (const axiom of known.axioms ?? []) {
                if (!allowedAxiomSet.has(axiom)) {
                    fail(
                        `ledger row ${row.key} binds ${name}, which depends on non-reviewed ` +
                            `axiom ${axiom}`
                    );
                }
            }
        }
        if (!Array.isArray(row.bounds) || row.bounds.length === 0) {
            fail(`ledger row ${row.key} declares no search bounds`);
        }
        if ((row.order ?? "").length === 0) {
            fail(`ledger row ${row.key} declares no enumeration order`);
        }
    }

    // --- Connective polarity ------------------------------------------------------

    for (const connective of ledger.connectives ?? []) {
        if (!ledger.auditedNames.includes(connective.polarityTheorem)) {
            fail(
                `connective ${connective.entry} names polarity theorem ` +
                    `${connective.polarityTheorem}, which is not audited`
            );
        }
    }
    for (const name of ledger.conjunction?.polarityTheorems ?? []) {
        if (!ledger.auditedNames.includes(name)) {
            fail(`the conjunction's polarity theorem ${name} is not audited`);
        }
    }

    // --- Heads and model constants ------------------------------------------------

    const heads = [];
    for (const entry of ledger.entries ?? []) {
        heads.push({
            category: entry.category,
            denotation: sha256(entry.denotation),
            id: entry.id
        });
        for (const constant of entry.constants ?? []) {
            if (!digests.has(constant)) {
                fail(
                    `entry ${entry.id} names model constant ${constant}, which the normative ` +
                        "manifest does not record"
                );
            }
        }
    }
    /** Every model name a record's meaning depends on, with the digest the manifest holds
     * for it. A change to any of these re-opens ratification, which is the whole point of
     * recording them beside the sentence rather than trusting the name. */
    const modelConstants = [];
    function pinConstant(name) {
        if (modelConstants.some((named) => named.name === name)) return;
        const known = digests.get(name);
        modelConstants.push({
            closure: known?.closure ?? null,
            digest: known?.digest ?? null,
            kind: known?.kind ?? null,
            name
        });
    }
    for (const entry of ledger.entries ?? []) {
        for (const constant of entry.constants ?? []) pinConstant(constant);
    }
    for (const row of ledger.ledgers ?? []) {
        for (const name of [
            row.state,
            row.label,
            row.step,
            row.exec,
            row.soundness,
            row.completeness,
            ...(row.initial === null ? [] : [row.initial])
        ]) {
            pinConstant(name);
        }
    }
    modelConstants.sort((left, right) => {
        if (left.name < right.name) return -1;
        return left.name > right.name ? 1 : 0;
    });

    // --- Atoms --------------------------------------------------------------------

    const atomKeys = new Set();
    for (const atom of ledger.atoms ?? []) {
        if (atomKeys.has(atom.key)) fail(`two intent atoms share the key ${atom.key}`);
        atomKeys.add(atom.key);
        if (!ledgerRows.has(atom.ledger)) {
            fail(`atom ${atom.key} names no registered ledger ${atom.ledger}`);
        }
        // The atom's declared polarity is the polarity of the connective its reading heads
        // with, and a named theorem proves it of the denotation. Checking the table here
        // means a polarity cannot be true of the entry and wrong on the record.
        const connective = (ledger.connectives ?? []).find((candidate) =>
            (atom.heads ?? []).includes(candidate.entry)
        );
        if (connective === undefined) {
            fail(`atom ${atom.key} heads with no reviewed intent connective`);
        } else if (connective.polarity !== atom.polarity) {
            fail(
                `atom ${atom.key} declares polarity ${atom.polarity} but its connective ` +
                    `${connective.entry} is ${connective.polarity}`
            );
        }
        for (const declaration of atom.declarations ?? []) {
            if (declaration.type === null) {
                fail(`atom ${atom.key} declares ${declaration.name}, which does not exist`);
            }
            if (!ledger.auditedNames.includes(declaration.name)) {
                fail(`atom ${atom.key} declares ${declaration.name} but it is not audited`);
            }
        }
    }

    // --- Records ------------------------------------------------------------------

    const spec = await canonicalSpec();
    const ruleUnits = reviewedRuleUnits(spec);
    const recordKeys = new Set();
    const readingKeys = new Set();
    const claimedAtoms = new Set();

    for (const record of allRecords) {
        const ratifiable = (ledger.records ?? []).includes(record);
        if (recordKeys.has(record.key)) fail(`two intent records share the key ${record.key}`);
        recordKeys.add(record.key);
        for (const required of [
            "ledger",
            "sentence",
            "atoms",
            "specAtoms",
            "digest",
            "readingKey",
            "ast",
            "lean",
            "heads",
            "expected",
            "verdict",
            "order",
            "bounds",
            "explored",
            "declarations"
        ]) {
            if (!(required in record)) fail(`intent record ${record.key} is missing ${required}`);
        }
        if (readingKeys.has(record.readingKey)) {
            fail(
                `intent record ${record.key} has the reading key of another record; two names ` +
                    "for one intent would pin the same reading twice"
            );
        }
        readingKeys.add(record.readingKey);
        if (!ledgerRows.has(record.ledger)) {
            fail(`intent record ${record.key} names no registered ledger ${record.ledger}`);
        }
        for (const key of record.atoms ?? []) {
            if (!atomKeys.has(key)) {
                fail(`intent record ${record.key} names no reviewed atom ${key}`);
            }
        }

        // A verdict either carries the evidence its kind owes, or it is not a verdict.
        if (record.expected !== record.verdict) {
            fail(
                `intent record ${record.key} expects ${record.expected} but the instrument ` +
                    `decided ${record.verdict}`
            );
        }
        const owed = evidenceByVerdict[record.verdict];
        if (owed === undefined) {
            fail(
                `intent record ${record.key} holds verdict ${record.verdict}, which is not a ` +
                    "decided verdict; UNPROVED is the absence of a claim, not one"
            );
        } else {
            for (const field of owed) {
                const name = record[field];
                if ((name ?? "").length === 0) {
                    fail(
                        `intent record ${record.key} is ${record.verdict} but names no ${field}; ` +
                            "a decided verdict is a kernel-checked witness or refutation"
                    );
                    continue;
                }
                if (!ledger.auditedNames.includes(name)) {
                    fail(
                        `intent record ${record.key} names ${field} ${name} but it is not audited`
                    );
                }
            }
            for (const field of ["witnessProof", "refutationProof"]) {
                if (owed.includes(field)) continue;
                if (record[field] !== null) {
                    fail(
                        `intent record ${record.key} is ${record.verdict} and must name no ` +
                            `${field}`
                    );
                }
            }
        }
        if (record.verdict !== "CONSISTENT" && (record.core ?? []).length === 0) {
            fail(
                `intent record ${record.key} is ${record.verdict} but reports no minimal core; ` +
                    "the refutation has to be stated at one"
            );
        }
        if (record.verdict !== "CONSISTENT" && record.excludedInstance === null) {
            fail(
                `intent record ${record.key} is ${record.verdict} but reports no smallest ` +
                    "instance the failed permission accepts under its bound alone"
            );
        }
        if (record.verdict === "CONSISTENT" && (record.witnesses ?? []).length === 0) {
            fail(
                `intent record ${record.key} is CONSISTENT but exhibits no witness transition; ` +
                    "a CONSISTENT verdict is an exhibited instance, never bounded exhaustion"
            );
        }
        for (const declaration of record.declarations ?? []) {
            if (declaration.type === null) {
                fail(
                    `intent record ${record.key} declares ${declaration.name}, which does not exist`
                );
            }
            if (!ledger.auditedNames.includes(declaration.name)) {
                fail(
                    `intent record ${record.key} declares ${declaration.name} but it is not audited`
                );
            }
        }

        // --- Anchoring -------------------------------------------------------------

        if (ratifiable) {
            if ((record.specAtoms ?? []).length === 0) {
                fail(`ratifiable intent record ${record.key} anchors no conformance atom`);
            }
            if (record.verdict !== "CONSISTENT") {
                fail(
                    `ratifiable intent record ${record.key} is ${record.verdict}; only a ` +
                        "CONSISTENT intent is a requirement a maintainer can approve"
                );
            }
            if (record.corpusUnit === null || record.bridgedAtom === null) {
                fail(
                    `ratifiable intent record ${record.key} bridges no corpus unit; without one ` +
                        "the two languages can drift"
                );
            }
        } else if ((record.specAtoms ?? []).length > 0) {
            fail(
                `adversarial intent record ${record.key} anchors conformance atoms; an ` +
                    "adversarial verdict must not look like a claim about a reviewed requirement"
            );
        }

        for (const atom of record.specAtoms ?? []) {
            if (claimedAtoms.has(atom)) {
                fail(`two intent records claim the conformance atom ${atom}`);
            }
            claimedAtoms.add(atom);
            const entry = [...ruleUnits.values()].find((candidate) =>
                candidate.atoms.includes(atom)
            );
            if (entry === undefined) {
                fail(`${record.key} anchors a non-reviewed atom: ${atom}`);
                continue;
            }
            if (entry.digest !== record.digest) {
                fail(
                    `${record.key} is stale: its rule-unit digest changed. The ratified intent ` +
                        "must be revisited against the new prose before it can stand."
                );
            }
        }

        // Bounds are pinned per record because a bounded no-witness report means nothing
        // without them.
        const row = ledgerRows.get(record.ledger);
        if (row !== undefined && JSON.stringify(row.bounds) !== JSON.stringify(record.bounds)) {
            fail(`intent record ${record.key} reports bounds its ledger row does not declare`);
        }
    }

    // --- Snapshot -----------------------------------------------------------------

    // A missing snapshot is a refusal, not a bootstrap. Writing one silently would mean
    // deleting the artifact is a way to make drift undetectable, so a fresh snapshot is only
    // ever written when the caller asks for one with `--update`. The approval of the change
    // that lands it is the ratification.
    mkdirSync(artifactsRoot, { recursive: true });
    const updating = process.argv.includes("--update");
    const snapshot = {
        heads,
        ledger,
        modelConstants,
        pins,
        schemaVersion: 1
    };
    const ledgerPath = join(artifactsRoot, "ledger.json");
    const rendered = await renderJsonArtifact(ledgerPath, snapshot);
    if (updating) {
        writeFileSync(ledgerPath, rendered, "utf8");
        console.log(`intents: refreshed ${artifactsRoot}; review the diff and commit`);
        return "ratified intent artifacts refreshed";
    }
    if (!existsSync(ledgerPath)) {
        fail(
            "artifacts/intents/ledger.json is absent; run this checker with --update to write " +
                "it, then review the diff and commit"
        );
    } else if (readFileSync(ledgerPath, "utf8") !== rendered) {
        fail(
            "artifacts/intents/ledger.json is stale against the current Lean report; the " +
                "ratified pin no longer matches what the instrument decides. Regenerate it with " +
                "--update, review the diff, and have it re-approved"
        );
    }

    if (failures.length > 0) reportFailures();

    const verdicts = allRecords.map((record) => record.verdict);
    const summary =
        `ratified intents verified: ${ledger.records.length} ratifiable and ` +
        `${ledger.adversarialRecords.length} adversarial records ` +
        `(${verdicts.filter((verdict) => verdict === "CONSISTENT").length} consistent, ` +
        `${verdicts.filter((verdict) => verdict === "INCONSISTENT").length} inconsistent, ` +
        `${verdicts.filter((verdict) => verdict === "OUTSIDE-MODEL").length} outside-model), ` +
        `${designations.size} declarations sorry-free, ` +
        `${ledger.atoms.length} atoms over ${ledger.ledgers.length} ledger, ` +
        `${adversarial.negativeCases} negative sentences and ${adversarial.scrambles} scrambles ` +
        `refused`;
    console.log(summary);
    return summary;
}

export { verifyRatifiedIntents };

const invokedDirectly =
    process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) await verifyRatifiedIntents(artifactRootFromArgv(process.argv));
