// The equivalence register: the only way a surviving mutant is excused from the
// actionability ratchet.
//
// Some mutants are unkillable in principle. A mutation that leaves observable behavior
// byte-identical cannot be killed by any test that could ever be written, so demanding
// zero survivors without a way to record one would force either pointless rewrites or,
// far worse, someone weakening the ratchet to make the gate green. The wrong way to
// record it is a count-level override taking a sentence for a whole area: one paragraph
// can absorb a hundred genuine coverage gaps, nothing ever checks the paragraph against
// the mutants, and no future evidence can contradict it.
//
// So a register entry names exactly one mutant and carries its own proof, and the claim
// it makes is falsifiable in both directions:
//
//   refuted — the mutant is reported killed (or timed out, or failed to compile). Tests
//             distinguish the mutation from the original, so the proof is wrong. The
//             measurement fails naming the entry and the tests that refuted it.
//   stale   — the anchor no longer resolves to a live mutant. The code moved past the
//             proof, so the proof is no longer about anything and must be rewritten.
//   ambiguous — the anchor resolves to more than one mutant. One proof may not bless two
//             sites; the entry has to be split.
//
// Identity has to survive incidental code movement or the register decays into churn.
// Stryker's mutant id is assigned per run and is useless across runs, and a line number
// moves whenever an import is added above it. An entry is therefore anchored to
// (file, enclosing symbol, mutator, replacement, the exact source the mutator replaces),
// with the replaced source normalized so reindentation and rewrapping do not break a
// proof while any token change does. The enclosing symbol is what separates two
// identical throw sites in one file — see the two "Workspace scope requires a Workspace
// ID" literals in src/identity/scope.ts, one unreachable and one killed. A mutant at
// module scope has no enclosing symbol and so cannot be registered.
import ts from "typescript";
import { assertExactKeys, assertString, assertUniqueIds } from "./project.mjs";

const ENTRY_FIELDS = ["file", "mutated", "mutator", "proof", "replacement", "symbol"];

// A proof has to carry the argument, not assert the conclusion. The weak-type permits
// ask for 24 characters because "the substrate hands back JSON" is a whole reason there;
// an equivalence claim has to establish that no test could ever distinguish the mutant,
// which is a paragraph. Distinctness is the other half: identical text under two entries
// is the count-level override wearing a different hat.
const PROOF_FLOOR = 240;

// A mutant Stryker never executed is not thereby distinguished from the original. An
// unreachable guard is reported NoCoverage precisely because it is unreachable, so the
// strongest equivalence cases arrive under that status; every other status means some
// run told the mutant apart.
const LIVE_STATUSES = new Set(["Survived", "NoCoverage"]);

export function readEquivalenceRegister(document) {
    assertExactKeys(document, ["edition", "entries"], "mutation equivalence register");
    if (!Array.isArray(document.entries)) {
        throw new TypeError("mutation equivalence entries must be an array");
    }
    for (const entry of document.entries) {
        assertExactKeys(entry, ENTRY_FIELDS, "mutation equivalence entry");
        for (const field of ENTRY_FIELDS) assertString(entry[field], `equivalence entry ${field}`);
        const key = equivalenceKey(entry);
        if (!entry.file.startsWith("src/") || entry.file.includes("..")) {
            throw new TypeError(`Equivalence entry names a file outside src/: ${key}`);
        }
        if (normalizeSource(entry.mutated) !== entry.mutated) {
            throw new TypeError(`Equivalence entry mutated source is not normalized: ${key}`);
        }
        if (entry.proof.trim().length < PROOF_FLOOR) {
            throw new TypeError(
                `Equivalence entry states no proof of equivalence: ${key}. ` +
                    "A proof establishes why no test can distinguish the mutant; " +
                    `${PROOF_FLOOR} characters is the floor.`
            );
        }
    }
    assertUniqueIds(document.entries, equivalenceKey, "mutation equivalence register");
    const proofs = new Set();
    for (const entry of document.entries) {
        if (proofs.has(entry.proof.trim())) {
            throw new TypeError(
                `Equivalence entry reuses another entry's proof: ${equivalenceKey(entry)}. ` +
                    "One proof excuses one mutant."
            );
        }
        proofs.add(entry.proof.trim());
    }
    return document.entries;
}

export function equivalenceKey(entry) {
    return `${entry.file}#${entry.symbol} ${entry.mutator} -> ${entry.replacement} @ ${entry.mutated}`;
}

// Whitespace carries no meaning in the anchored source, so a proof survives a reindent
// and a rewrap. Every other character does, so a proof does not survive a token change.
export function normalizeSource(text) {
    return text.replaceAll(/\s+/gu, " ").trim();
}

// Which source area a registered file belongs to, matching mutation-inputs.sourceAreas().
export function equivalenceArea(file) {
    const offset = file.slice("src/".length);
    const separator = offset.indexOf("/");
    return separator === -1 ? offset.replace(/\.ts$/u, "") : offset.slice(0, separator);
}

/**
 * Resolves the register against one area's Stryker report. Entries for files outside this
 * report belong to other areas and are left for their own measurement.
 */
export function reconcileEquivalence(report, entries) {
    const equivalent = new Map();
    const refuted = [];
    const stale = [];
    const ambiguous = [];
    const parsed = new Map();
    for (const entry of entries) {
        const file = report.files[entry.file];
        if (file === undefined) continue;
        let source = parsed.get(entry.file);
        if (source === undefined) {
            source = parseSource(entry.file, file.source);
            parsed.set(entry.file, source);
        }
        const matches = file.mutants.filter(
            (mutant) => mutant.status !== "Ignored" && anchors(entry, mutant, source, file.source)
        );
        if (matches.length === 0) stale.push(entry);
        else if (matches.length > 1) ambiguous.push({ entry, matches });
        else if (LIVE_STATUSES.has(matches[0].status)) equivalent.set(matches[0].id, entry);
        else refuted.push({ entry, mutant: matches[0] });
    }
    return { equivalent, refuted, stale, ambiguous };
}

/**
 * Verifies every entry's anchor against the working tree, without a mutation run. This is
 * what keeps a register entry honest between measurements: an entry whose file, symbol,
 * or anchored source has moved on is reported here rather than surviving until whichever
 * area happens to be measured next. `readSource` returns a file's text, or undefined.
 */
export function auditEquivalenceAnchors(entries, areas, readSource) {
    const failures = [];
    for (const entry of entries) {
        const key = equivalenceKey(entry);
        if (!areas.includes(equivalenceArea(entry.file))) {
            failures.push(`equivalence entry names a file outside the measured areas: ${key}`);
            continue;
        }
        const text = readSource(entry.file);
        if (text === undefined) {
            failures.push(`equivalence entry names a missing file: ${key}`);
            continue;
        }
        const source = parseSource(entry.file, text);
        const declarations = declarationsNamed(source, entry.symbol);
        if (declarations.length === 0) {
            failures.push(`equivalence entry names a symbol that no longer exists: ${key}`);
            continue;
        }
        const sites = declarations.reduce(
            (total, declaration) =>
                total + occurrences(normalizeSource(declaration.getText(source)), entry.mutated),
            0
        );
        if (sites !== 1) {
            failures.push(
                `equivalence entry anchors ${sites} sites in its symbol, not one: ${key}`
            );
        }
    }
    return failures;
}

function anchors(entry, mutant, source, text) {
    if (mutant.mutatorName !== entry.mutator || mutant.replacement !== entry.replacement) {
        return false;
    }
    const start = offsetOf(source, mutant.location.start);
    const end = offsetOf(source, mutant.location.end);
    return (
        normalizeSource(text.slice(start, end)) === entry.mutated &&
        symbolPathAt(source, start, end) === entry.symbol
    );
}

function parseSource(file, text) {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function offsetOf(source, position) {
    return ts.getPositionOfLineAndCharacter(source, position.line - 1, position.column - 1);
}

// The dotted path of named declarations enclosing a span: `encodeScopeRef` for a function,
// `ScopeRef.equals` for a method. Empty at module scope.
function symbolPathAt(source, start, end) {
    const path = [];
    let node = source;
    for (;;) {
        const child = ts.forEachChild(node, (candidate) =>
            candidate.getStart(source) <= start && end <= candidate.getEnd() ? candidate : undefined
        );
        if (child === undefined) return path.join(".");
        const name = declarationName(source, child);
        if (name !== undefined) path.push(name);
        node = child;
    }
}

// Every declaration reachable at exactly `symbol`. Overload signatures share one path, so
// the caller weighs their texts together.
function declarationsNamed(source, symbol) {
    const found = [];
    const walk = (node, path) => {
        ts.forEachChild(node, (child) => {
            const name = declarationName(source, child);
            const next = name === undefined ? path : [...path, name];
            if (name !== undefined && next.join(".") === symbol) found.push(child);
            else walk(child, next);
        });
    };
    walk(source, []);
    return found;
}

function declarationName(source, node) {
    if (ts.isConstructorDeclaration(node)) return "constructor";
    if (
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isVariableDeclaration(node)
    ) {
        return node.name === undefined ? undefined : node.name.getText(source);
    }
    return undefined;
}

function occurrences(haystack, needle) {
    let count = 0;
    for (
        let index = haystack.indexOf(needle);
        index !== -1;
        index = haystack.indexOf(needle, index + 1)
    ) {
        count += 1;
    }
    return count;
}
