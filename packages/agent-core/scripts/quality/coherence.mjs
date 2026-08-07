import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import ts from "typescript";
import {
    artifactRoot,
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
const normativeMap = await readCanonicalJson(resolve(artifactRoot, "quality/normative-map.json"));
const traceability = await readCanonicalJson(resolve(packageRoot, "artifacts/traceability.yaml"));
const atoms = specAtoms(specSource, normativeMap);
const prose = maskCode(specSource);
const issues = [];
let sectionCache;
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
    issues,
    additions,
    resolved,
    complete: issues.length === 0
};

if (options.writeBaseline) {
    if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
        throw new TypeError(
            "Writing the coherence baseline requires QUALITY_WRITE_BASELINE=1 outside CI"
        );
    }
    await writeCanonicalJson(options.baseline, { edition: "1.0.0", issues });
} else {
    await writeCanonicalJson(resolve(reportRoot, "coherence.json"), report);
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
    for (const section of sections()) {
        const chapter = Number.parseInt(section.id, 10);
        if (!section.id.includes(".") || chapter < 2 || chapter > 10) continue;
        const body = prose.slice(section.start, section.end);
        if (!/\b(?:MUST NOT|MUST|MAY)\b/u.test(body)) continue;
        if (/\*\*(?:C13|P11)-[A-Z0-9-]+\*\*/u.test(body)) continue;
        issue(
            "COH-SECTION-NO-ATOM",
            specFile,
            section.id,
            `Normative §${section.id} carries no conformance atom`
        );
    }
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
    let maxSharedAtoms = 4;
    let writeBaseline = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--root") root = resolve(required(args, ++index, argument));
        else if (argument === "--spec") spec = resolve(required(args, ++index, argument));
        else if (argument === "--baseline") baseline = resolve(required(args, ++index, argument));
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
        maxSharedAtoms,
        writeBaseline
    };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
