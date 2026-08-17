import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { sourceFiles } from "./compiler.mjs";
import {
    artifactRoot,
    assertExactKeys,
    assertString,
    assertUniqueStrings,
    collectFiles,
    packageRoot,
    portable,
    readCanonicalJson,
    repositoryRoot,
    reportRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";
import { canonicalSpec, compareSectionIds } from "./spec.mjs";

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
const specFile = portable(relative(options.root, options.spec));
const coverageFile = portable(relative(options.root, options.coverage));
const traceability = await readCanonicalJson(resolve(packageRoot, "artifacts/traceability.yaml"));
const coverage = await readCanonicalJson(options.coverage);
const ledgerRows = await conformanceRows(options.conformance);
const exemptedCitations = citationLabelExemptions(
    await readCanonicalJson(options.citationExemptions)
);
const {
    requirements,
    atoms,
    anchors,
    units: structuralUnits,
    unsupportedBlocks,
    visibleBlocks,
    inlineCodePlaceholder,
    sections: specSections,
    normativeSections,
    normativeKeywords
} = await canonicalSpec(options.spec);
/** The exact §3.3 Workspace example is the sole collision with wave codenames. */
const waveCodenameExamples = [
    {
        prose: `Example: Team A holds ${inlineCodePlaceholder} on Project P, so its members read every Workspace in P; a deny-Grant for W2 removes W2 without touching W1.`,
        rendered:
            "Example: Team A holds reader on Project P, so its members read every Workspace in P; a deny-Grant for W2 removes W2 without touching W1."
    }
];
const normativeSectionIds = new Set(normativeSections);
const normativeKeyword = new RegExp(`\\b(?:${normativeKeywords.join("|")})\\b`, "u");
const issues = [];
/** Every atom §13 defines that some test title wears, whether or not its row cites one. */
const labelledAtoms = new Set();
const known = new Set([
    ...requirements.map((requirement) => requirement.id),
    ...traceability.requirements.map((item) => item.id),
    ...traceability.nonClaims.map((item) => item.id)
]);

for (const [path, parsed] of sourceFiles(files)) {
    const file = portable(relative(options.root, path));
    for (const title of testTitles(parsed)) {
        for (const [, label] of title.matchAll(atomLabel)) {
            if (known.has(label)) labelledAtoms.add(label);
            else issue("COH-TEST-LABEL", file, label, `Test title labels undefined atom ${label}`);
        }
    }
}
checkWaveCodenames();
checkNormativeSections();
const normative = checkNormativeUnits();
checkSharedBlocks();
checkCrossReferences();
checkAtomAnchors();
checkCitationLabels();

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
    const exemptions = waveCodenameExemptions();
    for (const block of visibleBlocks) {
        const exempt = exemptions.get(block.start) ?? [];
        for (const match of block.prose.matchAll(/\bW[0-9]+\b/gu)) {
            if (exempt.some(([start, end]) => match.index >= start && match.index < end)) continue;
            const section = sectionAt(block.start);
            issue(
                "COH-UNDEFINED-TOKEN",
                specFile,
                `${section} ${match[0]}`,
                `Undefined wave codename ${match[0]} in §${section} visible SPEC prose`
            );
        }
        for (const match of mixedInlineCodeMatches(block, /\bW[0-9]+\b/u)) {
            const section = sectionAt(block.start);
            issue(
                "COH-UNDEFINED-TOKEN",
                specFile,
                `${section} ${match[0]}`,
                `Undefined wave codename ${match[0]} in §${section} visible SPEC prose`
            );
        }
    }
}

/** Normative obligations that no atom binds cannot be verified, so they drift silently. */
function checkNormativeSections() {
    for (const section of specSections) {
        if (!section.id.includes(".") || !normativeSectionIds.has(section.id)) continue;
        const carriesKeyword = visibleBlocks.some(
            (block) =>
                block.start >= section.bodyStart &&
                block.start < section.end &&
                hasSemanticToken(block, normativeKeyword)
        );
        if (!carriesKeyword || hasRequirementAnchor(section.bodyStart, section.end)) continue;
        issue(
            "COH-SECTION-NO-ATOM",
            specFile,
            section.id,
            `Normative §${section.id} carries no conformance atom`
        );
    }
}

/**
 * Section coverage is too coarse to bind anything: every anchor belongs to one structural
 * rule unit, so a keyword rule in an unanchored unit is bound by nothing. Paragraphs, list
 * items, and table rows are separate units under the canonical Markdown model.
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
        if (!unit.supported) {
            issue(
                "ACQ-NORM",
                specFile,
                unit.symbol,
                `Normative §${unit.section} ${unit.kind} is not a supported rule unit (${unit.digest}): ${unit.excerpt}`
            );
            unrecorded.push(issues.at(-1).fingerprint);
            continue;
        }
        if (unit.anchors.length > 0) {
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
        if (!/^\d+(?:\.\d+)*$/u.test(entry.section)) {
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
    const units = [];
    for (const unit of structuralUnits) {
        const section = sectionAt(unit.start);
        if (!normativeSectionIds.has(section) || !hasSemanticToken(unit, normativeKeyword))
            continue;
        const full = normalize(unit.source);
        const digest = `sha256:${sha256(full)}`;
        units.push({
            ...unit,
            supported: true,
            section,
            full,
            excerpt: full.length > 90 ? `${full.slice(0, 90)}…` : full,
            digest,
            symbol: `${section}:${digest.slice(7, 19)}`
        });
    }
    for (const block of unsupportedBlocks) {
        const section = sectionAt(block.start);
        if (!normativeSectionIds.has(section) || !hasSemanticToken(block, normativeKeyword)) {
            continue;
        }
        const full = normalize(block.source);
        const digest = `sha256:${sha256(full)}`;
        units.push({
            ...block,
            supported: false,
            section,
            full,
            excerpt: full.length > 90 ? `${full.slice(0, 90)}…` : full,
            digest,
            symbol: `${section}:${digest.slice(7, 19)}`
        });
    }
    return units;
}

function hasRequirementAnchor(start, end) {
    return anchors.some((anchor) => anchor.start >= start && anchor.end <= end);
}

/** `none` records that §13 has no atom for the rule at all; anything else must be one. */
function anchorable(atom) {
    return atom === "none" || atoms.some((candidate) => candidate.id === atom);
}

function normalize(text) {
    return text.replaceAll(/\s+/gu, " ").trim();
}

/**
 * Atoms anchored in one structural rule unit share its digest by construction.
 */
function checkSharedBlocks() {
    const blocks = new Map();
    for (const atom of atoms) {
        if (atom.occurrences !== 1) continue;
        blocks.set(atom.sourceDigest, [...(blocks.get(atom.sourceDigest) ?? []), atom.id]);
    }
    for (const ids of blocks.values()) {
        if (ids.length <= options.maxSharedAtoms) continue;
        const sorted = [...ids].sort();
        issue(
            "COH-SHARED-BLOCK",
            specFile,
            sorted[0],
            `One structural rule unit is the hash input for ${sorted.length} atoms: ${sorted.join(", ")}`
        );
    }
}

/** A cross-reference to a heading that does not exist sends the reader nowhere. */
function checkCrossReferences() {
    const headings = new Set(specSections.map((section) => section.id));
    for (const block of visibleBlocks) {
        for (const token of block.prose.matchAll(/§[^\s,;:()[\]{}'"!?]*/gu)) {
            const reference = token[0];
            const parsed = /^§{1,2}(\d+(?:\.\d+)*)(?:[–-]§?(\d+(?:\.\d+)*))?\.?$/u.exec(reference);
            if (parsed === null) {
                issue("COH-XREF", specFile, reference, `Malformed cross-reference ${reference}`);
                continue;
            }
            const [, from, to] = parsed;
            if (to !== undefined && compareSectionIds(from, to) > 0) {
                issue("COH-XREF", specFile, reference, `Cross-reference ${reference} is reversed`);
                continue;
            }
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

/**
 * A test's atom label and a row's test citation are the two ends of one claim, and nothing
 * joined them. COH-TEST-LABEL above asks only that a label name an atom the document
 * defines; the ledger asks only that a cited test exist and pass; discrimination asks about
 * mutants, and only where mutation data is fresh. So a test labelled [C13-FOO] could
 * exercise something else entirely, and a row could cite a test wearing another atom's
 * label or none, and every gate stayed green. The join is what makes either end falsifiable.
 *
 * COH-CITATION-LABEL — a row's cited selector must carry that row's own label.
 * COH-LABEL-CITATION — an atom label a test title wears must be carried by at least one
 *                      selector the named row cites.
 *
 * The granularity, which is the hard part in both directions. A labelled `describe` must
 * contain ONE cited leaf, not all of them: a suite labelled [C13-FOO] holding twenty cases
 * does not oblige its row to cite twenty selectors, it obliges the label and the citation to
 * meet somewhere. Too strict and every multi-case suite fails; too loose and a label
 * floating above unrelated cases passes.
 *
 * The two directions land at different granularities, and the weaker one does not set the
 * bar for the stronger. COH-CITATION-LABEL is per selector: it is a predicate over the
 * citation string alone, so it reaches every citation. COH-LABEL-CITATION is per atom,
 * because a full test name is the ancestor titles plus the leaf title and this repository
 * composes 164 of its 661 citations across files — shared contract suites such as
 * test/invocations/ledger-contract.ts run from several spec files, and `describe.each`
 * titles substituted at run time — which no static parse can rebuild. Scoping the label
 * side per file measures 99 findings, a quarter of them against helper modules no selector
 * can ever name. Per atom is therefore the finest join this side can state without
 * executing the suite, and it is exactly the "meet somewhere" granularity above.
 *
 * A row citing no test at all is exempt from the label direction, because otherwise the
 * rule is unsatisfiable rather than strict: ledger.mjs#validateStatus requires a `planned`
 * row to carry empty testSelectors, so demanding a citation would leave only two moves,
 * promoting the row past its evidence or deleting a label that correctly names what the
 * test does. Both are worse than the finding. A row that cites nothing asserts nothing —
 * it cannot reach `verified`, which requires citations — so a label written ahead of
 * promotion is work in progress rather than misdirection. The exemption lifts the instant
 * the row cites anything, which is where the real defect lives: a row naming some tests
 * while another test claims the same atom and is silently not among them.
 *
 * COH-LABEL-CITATION therefore never fires without COH-CITATION-LABEL firing for the same
 * atom, and it is still not redundant. C13-EFFECT-WRITE-AHEAD is the worked case: it cites
 * one unlabelled test in test/invocations/reconciliation.test.ts while its label sits on an
 * uncited test in test/invocations/audit-relation.test.ts. The citation rule alone says
 * "label the test you cite", and a reader who does that leaves the labelled test still
 * uncited. Only the label rule says the evidence already exists and the row does not name it.
 *
 * One test may honestly answer two atoms while wearing one atom's label, so that stays
 * expressible: artifacts/quality/citation-label-exemptions.json names the exact
 * (atom, selector) pair and states why, one written justification per pair and no
 * count-level override. An entry whose pair stops resolving fails the run outright rather
 * than lingering as a permanent allowance.
 */
function checkCitationLabels() {
    const stale = [];
    for (const entry of exemptedCitations.values()) {
        const row = ledgerRows.get(entry.atom);
        if (row === undefined) stale.push(`${entry.atom} is no §13 row`);
        else if (!row.testSelectors.includes(entry.selector)) {
            stale.push(`${entry.atom} no longer cites ${entry.selector}`);
        } else if (entry.selector.includes(`[${entry.atom}]`)) {
            stale.push(`${entry.atom} now carries its own label in ${entry.selector}`);
        }
    }
    if (stale.length > 0) {
        throw new TypeError(
            `Citation label exemptions no longer resolve:\n${stale.map((item) => `  ${item}`).join("\n")}`
        );
    }
    const backed = new Set();
    for (const row of ledgerRows.values()) {
        for (const selector of row.testSelectors) {
            if (
                selector.includes(`[${row.id}]`) ||
                exemptedCitations.has(exemptionKey(row.id, selector))
            ) {
                backed.add(row.id);
                continue;
            }
            const separator = selector.indexOf("#");
            const worn = [...new Set([...selector.matchAll(atomLabel)].map(([, label]) => label))];
            // The two defects call for opposite repairs: an unlabelled test needs its
            // atom's label, while a test wearing another atom's is either a shared witness
            // that should wear both labels or evidence for a claim it does not answer.
            issue(
                "COH-CITATION-LABEL",
                selector.slice(0, separator),
                row.id,
                `Row ${row.id} cites a test carrying ${worn.length === 0 ? "no atom label" : `${worn.join(", ")} instead`}: ${selector.slice(separator + 1)}`
            );
        }
    }
    for (const label of [...labelledAtoms].sort()) {
        const row = ledgerRows.get(label);
        if (row === undefined || row.testSelectors.length === 0 || backed.has(label)) continue;
        issue(
            "COH-LABEL-CITATION",
            specFile,
            label,
            `Test titles carry the label of ${label}, whose row cites no test carrying it`
        );
    }
}

/**
 * Every §13 row by id, under the ledger's own fragment precedence: a wave's fragment holds
 * the live row and the seed holds only the rows no wave has claimed yet. Reading the
 * fragments in any other order replaces live rows with their planned seed shells, and every
 * measurement taken over the result is silently void.
 */
async function conformanceRows(indexPath) {
    const index = await readCanonicalJson(indexPath);
    const root = dirname(indexPath);
    const rows = new Map();
    for (const name of index.fragments ?? []) {
        for (const row of await conformanceFragment(resolve(root, name))) {
            if (rows.has(row.id))
                throw new TypeError(`Duplicate conformance requirement ${row.id}`);
            rows.set(row.id, row);
        }
    }
    for (const row of await conformanceFragment(resolve(root, index.seed))) {
        if (!rows.has(row.id)) rows.set(row.id, row);
    }
    return rows;
}

async function conformanceFragment(path) {
    const fragment = await readCanonicalJson(path);
    if (!Array.isArray(fragment.requirements))
        throw new TypeError(`Conformance fragment ${path} states no requirements`);
    for (const row of fragment.requirements) {
        assertString(row.id, "Conformance requirement id");
        assertUniqueStrings(row.testSelectors, `Requirement ${row.id} testSelectors`);
    }
    return fragment.requirements;
}

/**
 * The reviewed judgement that one test honestly answers an atom whose label it does not
 * wear, keyed on the exact pair it excuses.
 */
function citationLabelExemptions(artifact) {
    assertExactKeys(artifact, ["edition", "entries"], "Citation label exemptions");
    if (artifact.edition !== "1.0.0")
        throw new TypeError("Unsupported citation label exemption edition");
    if (!Array.isArray(artifact.entries))
        throw new TypeError("Citation label exemptions must be an array");
    const entries = new Map();
    for (const entry of artifact.entries) {
        assertExactKeys(entry, ["atom", "reason", "selector"], "Citation label exemption");
        for (const field of ["atom", "reason", "selector"]) {
            assertString(entry[field], `Citation label exemption ${field}`);
        }
        const key = exemptionKey(entry.atom, entry.selector);
        if (entries.has(key))
            throw new TypeError(`Citation label exemption ${entry.atom} is recorded twice`);
        entries.set(key, entry);
    }
    return entries;
}

function exemptionKey(atom, selector) {
    return `${atom}\u0000${selector}`;
}

function waveCodenameExemptions() {
    const exemptions = new Map();
    for (const example of waveCodenameExamples) {
        const semanticMatches = visibleMatches(example.prose, "prose");
        const renderedMatches = visibleMatches(example.rendered, "rendered");
        if (
            semanticMatches.length !== 1 ||
            renderedMatches.length !== 1 ||
            semanticMatches[0].block.start !== renderedMatches[0].block.start
        ) {
            throw new TypeError(
                `Wave codename exemption does not match SPEC prose once: ${example.rendered}`
            );
        }
        const [{ block, match }] = semanticMatches;
        const ranges = exemptions.get(block.start) ?? [];
        ranges.push([match.index, match.index + match[0].length]);
        exemptions.set(block.start, ranges);
    }
    return exemptions;
}

function visibleMatches(example, field) {
    const pattern = new RegExp(
        example.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&").replaceAll(/\s+/gu, "\\s+"),
        "gu"
    );
    return visibleBlocks.flatMap((block) =>
        [...block[field].matchAll(pattern)].map((match) => ({ block, match }))
    );
}

function hasSemanticToken(block, pattern) {
    const prosePattern = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    return prosePattern.test(block.prose) || mixedInlineCodeMatches(block, pattern).length > 0;
}

function mixedInlineCodeMatches(block, pattern) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    return [...block.rendered.matchAll(new RegExp(pattern.source, flags))].filter((match) => {
        const start = match.index;
        const end = start + match[0].length;
        const codeLength = block.inlineCodeRanges.reduce(
            (length, [codeStart, codeEnd]) =>
                length + Math.max(0, Math.min(end, codeEnd) - Math.max(start, codeStart)),
            0
        );
        return codeLength > 0 && codeLength < match[0].length;
    });
}

/** The innermost numbered section an offset falls in; "0" is the front matter before §1. */
function sectionAt(offset) {
    return (
        specSections.findLast((section) => section.start <= offset && offset < section.end)?.id ??
        "0"
    );
}

function testTitles(parsed) {
    const titles = [];
    visit(parsed, (node) => {
        if (!ts.isCallExpression(node) || !isTestCallee(node.expression)) return;
        const title = node.arguments[0];
        if (title !== undefined && ts.isStringLiteralLikeNode(title)) titles.push(title.text);
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
    let conformance = resolve(artifactRoot, "conformance/index.json");
    let citationExemptions = resolve(artifactRoot, "quality/citation-label-exemptions.json");
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
        else if (argument === "--conformance")
            conformance = resolve(required(args, ++index, argument));
        else if (argument === "--citation-exemptions")
            citationExemptions = resolve(required(args, ++index, argument));
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
        conformance,
        citationExemptions,
        maxSharedAtoms,
        writeBaseline
    };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
