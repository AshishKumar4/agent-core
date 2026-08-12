import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import ts from "typescript";
import {
    artifactRoot,
    assertExactKeys,
    assertString,
    collectFiles,
    packageRoot,
    portable,
    readCanonicalJson,
    repositoryRoot,
    reportRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";
import { profileLabels, specAtoms } from "./spec.mjs";

/**
 * §3.3 illustrates deny-Grant precedence with Workspaces literally named W1 and W2, which
 * collide with the development-wave codenames. The exemption is the exact example sentence
 * and must still match the document, so a wave codename anywhere else remains a finding.
 */
const waveCodenameExamples = [
    "Example: Team A holds `reader` on Project P, so its members read every Workspace in P; a deny-Grant for W2 removes W2 without touching W1."
];
const testCallees = ["describe", "it", "test", "suite", "bench"];
const atomLabel = /\[((?:C13|P11|AC|NC)-[A-Z0-9-]+)\]/gu;
const atomAnchor = /\*\*(?:C13|P11)-[A-Z0-9-]+\*\*/u;

const options = parseArguments(process.argv.slice(2));
const testRoots =
    options.root === repositoryRoot
        ? [
              resolve(repositoryRoot, "packages/agent-core/test"),
              resolve(repositoryRoot, "packages/agent-core-cloudflare/test")
          ]
        : [resolve(options.root, "test")];
const files = (await Promise.all(testRoots.map((root) => collectFiles(root, isTypeScript))))
    .flat()
    .sort();
const specSource = await readFile(options.spec, "utf8");
const specFile = portable(relative(options.root, options.spec));
const coverageFile = portable(relative(options.root, options.coverage));
const normativeMap = await readCanonicalJson(resolve(artifactRoot, "quality/normative-map.json"));
const traceability = await readCanonicalJson(resolve(packageRoot, "artifacts/traceability.yaml"));
const coverage = await readCanonicalJson(options.coverage);
const atoms = specAtoms(specSource, normativeMap);
const prose = maskCode(specSource);
const issues = [];
let sectionCache;
let vocabularyCache;
const known = new Set([
    ...atoms.map((atom) => atom.id),
    ...profileLabels(specSource),
    ...traceability.requirements.map((item) => item.id),
    ...traceability.nonClaims.map((item) => item.id)
]);

for (const path of files) {
    const source = await readFile(path, "utf8");
    const file = portable(relative(options.root, path));
    const parsed = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(path)
    );
    for (const title of testTitles(parsed)) {
        for (const [, label] of title.matchAll(atomLabel)) {
            if (!known.has(label)) {
                issue("COH-TEST-LABEL", file, label, `Test title labels undefined atom ${label}`);
            }
        }
    }
}
checkWaveCodenames();
checkNormativeSections();
const normative = checkNormativeUnits();
checkSharedBlocks();
checkCrossReferences();
checkAtomAnchors();

issues.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
const baseline = await loadBaseline(options.baseline);
const baselineFingerprints = new Set(baseline.issues.map((item) => item.fingerprint));
const currentFingerprints = new Set(issues.map((item) => item.fingerprint));
const additions = issues.filter((item) => !baselineFingerprints.has(item.fingerprint));
const resolved = baseline.issues.filter((item) => !currentFingerprints.has(item.fingerprint));
const report = {
    stage: options.stage,
    spec: specFile,
    files: files.map((path) => portable(relative(options.root, path))),
    normative,
    issues,
    additions,
    resolved,
    complete: issues.length === 0
};

// The baseline accepts a finding as debt; it may not accept a normative rule nobody has
// judged, because the judgement — exempt, or waiting on a named atom — is the whole gate.
const unjudged = new Set(normative.unrecorded);
if (options.writeBaseline) {
    if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
        throw new TypeError(
            "Writing the coherence baseline requires QUALITY_WRITE_BASELINE=1 outside CI"
        );
    }
    if (unjudged.size > 0) {
        fail(
            "Normative rules with no recorded disposition cannot be baselined",
            issues.filter((item) => unjudged.has(item.fingerprint))
        );
    }
    await writeCanonicalJson(options.baseline, { edition: "1.0.0", issues });
} else {
    await writeCanonicalJson(resolve(reportRoot, "coherence.json"), report);
    const accepted = baseline.issues.filter((item) => unjudged.has(item.fingerprint));
    if (accepted.length > 0) {
        fail("Baseline accepts normative rules with no recorded disposition", accepted);
    }
    if (additions.length > 0) fail("New SPEC coherence violations", additions);
    // The baseline is debt, not a permanent allowance: a finding that no longer reproduces
    // must leave it, or the gate silently re-accepts the defect when it returns.
    if (resolved.length > 0) fail("Coherence baseline retains resolved findings", resolved);
    console.log(
        `coherence ${report.complete ? "complete" : "incomplete"}: ${issues.length} issue(s), ${resolved.length} resolved`
    );
}

/**
 * Development-wave codenames name no concept the document defines, so prose that leans on
 * one is unreadable to anybody outside the fleet — and when it lands inside an atom's hash
 * input it silently re-digests the atom.
 */
function checkWaveCodenames() {
    const exempt = exemptSpans();
    const normative = prose.slice(0, prose.indexOf("## 13. Conformance"));
    for (const match of normative.matchAll(/\bW[0-9]\b/gu)) {
        if (exempt.some(([start, end]) => match.index >= start && match.index < end)) continue;
        const section = sectionAt(match.index);
        issue(
            "COH-UNDEFINED-TOKEN",
            specFile,
            `${section} ${match[0]}`,
            `Undefined wave codename ${match[0]} in §${section} normative prose`
        );
    }
}

/** Normative obligations that no atom binds cannot be verified, so they drift silently. */
function checkNormativeSections() {
    const { sections: normative, keyword } = vocabulary();
    for (const section of sections()) {
        if (!section.id.includes(".") || !normative.has(section.id)) continue;
        const body = prose.slice(section.start, section.end);
        if (!keyword.test(body) || atomAnchor.test(body)) continue;
        issue(
            "COH-SECTION-NO-ATOM",
            specFile,
            section.id,
            `Normative §${section.id} carries no conformance atom`
        );
    }
}

/**
 * Section coverage is too coarse to bind anything: an atom hashes only the blank-line
 * block its anchor sits in, so a keyword rule in an unanchored block is bound by nothing
 * — it can be weakened without restaling an atom — and a keyword rule beside an anchored
 * sibling in one numbered list is hashed by that atom without being required by it. Both
 * are the defect, so the unit is the block, split at its own list items and table rows.
 *
 * Units the review holds non-binding are exempted individually by the digest of their
 * exact source text, so rewording one reopens the question instead of inheriting the
 * verdict, and an exemption that stops matching the document is itself a finding.
 */
function checkNormativeUnits() {
    const dispositions = normativeDispositions();
    const seen = new Set();
    const units = normativeUnits();
    const counts = { units: units.length, anchored: 0, exempt: 0, unanchored: 0 };
    const unrecorded = [];
    for (const unit of units) {
        const recorded = dispositions.get(unit.digest);
        seen.add(unit.digest);
        if (atomAnchor.test(unit.text)) {
            counts.anchored += 1;
            continue;
        }
        if (recorded === undefined) {
            issue(
                "ACQ-NORM",
                specFile,
                unit.symbol,
                `Normative §${unit.section} rule is bound by no atom and no disposition judges it (${unit.digest}): ${unit.excerpt}`
            );
            unrecorded.push(issues.at(-1).fingerprint);
            continue;
        }
        if (recorded.section !== unit.section || recorded.excerpt !== unit.excerpt) {
            issue(
                "ACQ-NORM",
                coverageFile,
                unit.symbol,
                `Normative disposition labels its §${recorded.section} rule with prose the document does not carry: ${recorded.excerpt}`
            );
        }
        if (recorded.disposition === "exempt") {
            counts.exempt += 1;
            continue;
        }
        counts.unanchored += 1;
        issue(
            "ACQ-NORM",
            specFile,
            unit.symbol,
            `Normative §${unit.section} rule waits on ${recorded.atom === "none" ? "an atom §13 does not yet state" : `an anchor for ${recorded.atom}`}: ${unit.excerpt}`
        );
    }
    // Anchoring a rule rewrites the unit that carries it, so a disposition whose digest
    // matches nothing is the one signal for reworded, deleted, and finally anchored prose.
    for (const [digest, recorded] of dispositions) {
        if (seen.has(digest)) continue;
        issue(
            "ACQ-NORM",
            coverageFile,
            `${recorded.section}:${digest.slice(7, 19)}`,
            `Normative disposition matches no §${recorded.section} unit; the prose it judged was reworded, removed, or anchored: ${recorded.excerpt}`
        );
    }
    return { ...counts, unrecorded };
}

/**
 * The reviewed judgement for each normative unit no atom anchors, keyed by the digest of
 * the exact prose it judges. `exempt` records prose that binds nothing — an advisory field,
 * a permission the document itself denies correctness semantics. `unanchored` records real
 * debt: `atom` names the conformance atom whose obligation the rule is, or `none` when the
 * document states an obligation §13 has no atom for at all.
 */
function normativeDispositions() {
    if (coverage.edition !== "1.0.0" || !Array.isArray(coverage.dispositions)) {
        throw new TypeError("Normative coverage artifact is malformed");
    }
    const dispositions = new Map();
    for (const entry of coverage.dispositions) {
        const keys =
            entry.disposition === "exempt"
                ? ["disposition", "excerpt", "reason", "section", "sha256"]
                : ["atom", "disposition", "excerpt", "reason", "section", "sha256"];
        assertExactKeys(entry, keys, "normative disposition");
        assertString(entry.reason, `normative disposition ${entry.sha256} reason`);
        assertString(entry.excerpt, `normative disposition ${entry.sha256} excerpt`);
        if (entry.disposition !== "exempt" && entry.disposition !== "unanchored") {
            throw new TypeError(`Normative disposition ${entry.sha256} is neither kind`);
        }
        if (entry.disposition === "unanchored" && !anchorable(entry.atom)) {
            throw new TypeError(`Normative disposition ${entry.sha256} names no atom`);
        }
        if (!/^\d+(?:\.\d+)?$/u.test(entry.section)) {
            throw new TypeError(`Normative disposition ${entry.sha256} names no section`);
        }
        if (!/^sha256:[0-9a-f]{64}$/u.test(entry.sha256)) {
            throw new TypeError(`Normative disposition in §${entry.section} has no digest`);
        }
        if (dispositions.has(entry.sha256)) {
            throw new TypeError(`Normative disposition ${entry.sha256} is recorded twice`);
        }
        dispositions.set(entry.sha256, entry);
    }
    return dispositions;
}

/**
 * Every unit of declared-normative prose carrying a declared keyword, with the digest of
 * its exact source text. Offsets survive masking, so the digest covers the inline code an
 * exemption would otherwise let anyone rewrite.
 */
function normativeUnits() {
    const { sections: normative, keyword } = vocabulary();
    const units = [];
    for (const section of sections()) {
        if (!normative.has(section.id)) continue;
        for (const block of proseBlocks(section.start, section.end)) {
            for (const [start, end] of blockUnits(block)) {
                const text = prose.slice(start, end);
                if (!keyword.test(text)) continue;
                const full = normalize(specSource.slice(start, end));
                const digest = `sha256:${sha256(full)}`;
                units.push({
                    section: section.id,
                    text,
                    full,
                    excerpt: full.length > 90 ? `${full.slice(0, 90)}…` : full,
                    digest,
                    symbol: `${section.id}:${digest.slice(7, 19)}`
                });
            }
        }
    }
    return units;
}

/** The blank-line-delimited blocks of one section body, excluding headings and rules. */
function proseBlocks(from, to) {
    const blocks = [];
    let lines = [];
    const close = () => {
        const start = lines[0]?.start;
        const end = lines.at(-1)?.end;
        lines = [];
        if (start === undefined) return;
        if (/^\s*(?:#|-{3,}\s*$|!\[)/u.test(prose.slice(start, end))) return;
        blocks.push({ start, end });
    };
    for (const line of lineSpans(from, to)) {
        if (prose.slice(line.start, line.end).trim().length === 0) close();
        else lines.push(line);
    }
    close();
    return blocks;
}

/**
 * A block's normative units: its own list items and table rows, which state separate
 * rules that separate atoms must name, and otherwise the whole block.
 */
function blockUnits(block) {
    const boundaries = [block.start];
    for (const line of lineSpans(block.start, block.end)) {
        const text = prose.slice(line.start, line.end);
        if (/^\s{0,3}(?:\d+\.|[-*|])\s/u.test(text)) boundaries.push(line.start);
    }
    const unique = [...new Set(boundaries)].sort((left, right) => left - right);
    return unique.map((start, index) => [start, unique[index + 1] ?? block.end]);
}

function lineSpans(from, to) {
    const spans = [];
    let start = from;
    while (start < to) {
        const next = prose.indexOf("\n", start);
        const end = next < 0 || next > to ? to : next;
        spans.push({ start, end });
        start = end + 1;
    }
    return spans;
}

/**
 * §1.3 declares which sections bind and which keywords carry an obligation. The gates
 * read that declaration rather than a copy of it, so widening the document's normative
 * reach widens theirs instead of silently leaving prose ungated.
 */
function vocabulary() {
    if (vocabularyCache !== undefined) return vocabularyCache;
    const declaration = /\bSections ([^;]+?) are normative;/u.exec(prose);
    const keywords = /\b([A-Z]+(?:, [A-Z]+)*,? and [A-Z]+) are RFC 2119 keywords\b/u.exec(prose);
    if (declaration === null || keywords === null) {
        throw new TypeError("SPEC §1.3 no longer declares its normative sections and keywords");
    }
    const normative = new Set();
    for (const token of terms(declaration[1])) {
        const range = /^(\d+(?:\.\d+)?)(?:[–-](\d+))?$/u.exec(token);
        if (range === null) throw new TypeError(`SPEC §1.3 names an unreadable section ${token}`);
        const to = range[2] === undefined ? range[1] : range[2];
        for (const section of sections()) {
            if (inRange(section.id, range[1], to)) normative.add(section.id);
        }
    }
    vocabularyCache = {
        sections: normative,
        keyword: new RegExp(`\\b(?:${terms(keywords[1]).join("|")})\\b`, "u")
    };
    return vocabularyCache;
}

/** `none` records that §13 has no atom for the rule at all; anything else must be one. */
function anchorable(atom) {
    return atom === "none" || atoms.some((candidate) => candidate.id === atom);
}

/** The members of one of §1.3's comma-and-`and` lists. */
function terms(list) {
    return list
        .split(/,|\band\b/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 0);
}

/** A section id falls in a §1.3 range when the range is exact or spans its chapter. */
function inRange(id, from, to) {
    if (from.includes(".")) return id === from;
    const chapter = Number.parseInt(id, 10);
    return chapter >= Number.parseInt(from, 10) && chapter <= Number.parseInt(to, 10);
}

function normalize(text) {
    return text.replaceAll(/\s+/gu, " ").trim();
}

/**
 * Atoms anchored in one blank-line-delimited block all hash that whole block, so an edit
 * anywhere inside it re-digests every one of them at once.
 */
function checkSharedBlocks() {
    const blocks = new Map();
    for (const atom of atoms) {
        if (atom.occurrences !== 1) continue;
        blocks.set(atom.digest, [...(blocks.get(atom.digest) ?? []), atom.id]);
    }
    for (const ids of blocks.values()) {
        if (ids.length <= options.maxSharedAtoms) continue;
        const sorted = [...ids].sort();
        issue(
            "COH-SHARED-BLOCK",
            specFile,
            sorted[0],
            `One prose block is the hash input for ${sorted.length} atoms: ${sorted.join(", ")}`
        );
    }
}

/** A cross-reference to a heading that does not exist sends the reader nowhere. */
function checkCrossReferences() {
    const headings = new Set(sections().map((section) => section.id));
    for (const match of prose.matchAll(/§{1,2}(\d+(?:\.\d+)?)(?:[–-](\d+(?:\.\d+)?))?/gu)) {
        const [reference, from, to] = match;
        const targets =
            to === undefined
                ? [from]
                : from.includes(".") || to.includes(".")
                  ? [from, to]
                  : range(Number.parseInt(from, 10), Number.parseInt(to, 10));
        for (const target of targets) {
            if (headings.has(target)) continue;
            issue(
                "COH-XREF",
                specFile,
                reference,
                `Cross-reference ${reference} resolves to no §${target} heading`
            );
        }
    }
}

/**
 * The normative map and the document must agree on which atoms are authoritative outside
 * §13. The ledger refuses to parse past a disagreement; reporting it names the atom.
 */
function checkAtomAnchors() {
    for (const atom of atoms) {
        if (atom.reviewed && atom.occurrences !== 1) {
            issue(
                "COH-ATOM-UNBOUND",
                specFile,
                atom.id,
                `Reviewed authoritative atom ${atom.id} is anchored ${atom.occurrences} times outside §13`
            );
        }
        if (!atom.reviewed && atom.occurrences > 0) {
            issue(
                "COH-ATOM-UNBOUND",
                specFile,
                atom.id,
                `§13-only summary ${atom.id} is anchored ${atom.occurrences} times outside §13`
            );
        }
    }
}

function exemptSpans() {
    return waveCodenameExamples.map((example) => {
        const pattern = new RegExp(
            example.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&").replaceAll(/\s+/gu, "\\s+"),
            "gu"
        );
        // Masking preserves offsets, so the unmasked document locates spans the prose shares.
        const matches = [...specSource.matchAll(pattern)];
        if (matches.length !== 1) {
            throw new TypeError(
                `Wave codename exemption does not match SPEC prose once: ${example}`
            );
        }
        return [matches[0].index, matches[0].index + matches[0][0].length];
    });
}

/** Every numbered `##` chapter and `###` section, with the offsets its body spans. */
function sections() {
    if (sectionCache === undefined) {
        const found = [];
        for (const match of prose.matchAll(/^#{2,3} (\d+(?:\.\d+)?)[.\s]/gmu)) {
            found.push({ id: match[1], start: match.index + match[0].length, end: prose.length });
            if (found.length > 1) found[found.length - 2].end = match.index;
        }
        sectionCache = found;
    }
    return sectionCache;
}

/** The innermost numbered section an offset falls in; "0" is the front matter before §1. */
function sectionAt(offset) {
    return sections().findLast((section) => section.start <= offset)?.id ?? "0";
}

/**
 * The document with every fenced and inline code region blanked, preserving offsets and
 * line structure so prose rules never fire on an example or a type signature.
 */
function maskCode(source) {
    const blank = (text) => text.replaceAll(/[^\n]/gu, " ");
    const masked = source.replaceAll(/^```[\s\S]*?^```/gmu, blank);
    return masked.replaceAll(/`[^`\n]+`/gu, blank);
}

function testTitles(parsed) {
    const titles = [];
    visit(parsed, (node) => {
        if (!ts.isCallExpression(node) || !isTestCallee(node.expression)) return;
        const title = node.arguments[0];
        if (title !== undefined && ts.isStringLiteralLike(title)) titles.push(title.text);
    });
    return titles;
}

function isTestCallee(expression) {
    let current = expression;
    while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
        current = current.expression;
    }
    return ts.isIdentifier(current) && testCallees.includes(current.text);
}

function visit(node, inspect) {
    inspect(node);
    node.forEachChild((child) => visit(child, inspect));
}

function range(from, to) {
    return Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
}

function issue(rule, file, symbol, message) {
    const base = `${rule}:${file}:${symbol}:${sha256(message).slice(0, 12)}`;
    const ordinal =
        issues.filter(
            (item) => item.fingerprint === base || item.fingerprint.startsWith(`${base}:`)
        ).length + 1;
    const fingerprint = ordinal === 1 ? base : `${base}:${ordinal}`;
    issues.push({ rule, file, symbol, message, fingerprint });
}

function isTypeScript(path) {
    return /\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

function scriptKind(path) {
    return path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

async function loadBaseline(path) {
    try {
        return await readCanonicalJson(path);
    } catch (error) {
        if (error?.code === "ENOENT") return { edition: "1.0.0", issues: [] };
        throw error;
    }
}

function fail(title, values) {
    throw new TypeError(
        `${title}:\n${values.map((item) => `  ${item.fingerprint} ${item.message}`).join("\n")}`
    );
}

function parseArguments(args) {
    let stage = "building";
    let root = repositoryRoot;
    let spec;
    let baseline = resolve(artifactRoot, "quality/coherence-baseline.json");
    let coverage = resolve(artifactRoot, "quality/normative-coverage.json");
    let maxSharedAtoms = 4;
    let writeBaseline = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--root") root = resolve(required(args, ++index, argument));
        else if (argument === "--spec") spec = resolve(required(args, ++index, argument));
        else if (argument === "--baseline") baseline = resolve(required(args, ++index, argument));
        else if (argument === "--normative-coverage")
            coverage = resolve(required(args, ++index, argument));
        else if (argument === "--max-shared-atoms")
            maxSharedAtoms = Number.parseInt(required(args, ++index, argument), 10);
        else if (argument === "--write-baseline") writeBaseline = true;
        else throw new TypeError(`Unknown coherence argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    if (!Number.isInteger(maxSharedAtoms) || maxSharedAtoms < 1)
        throw new TypeError("--max-shared-atoms requires a positive integer");
    return {
        stage,
        root,
        spec: spec ?? resolve(packageRoot, "SPEC.md"),
        baseline,
        coverage,
        maxSharedAtoms,
        writeBaseline
    };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
