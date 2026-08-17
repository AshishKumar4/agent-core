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
// module scope has no enclosing symbol and so cannot be registered. Two identical sites
// inside one symbol need `occurrence`/`sites` as well; see POSITION_FIELDS below.
import ts from "typescript-api";
import { assertExactKeys, assertString, assertUniqueIds } from "./project.mjs";

const ENTRY_FIELDS = ["file", "mutated", "mutator", "proof", "replacement", "symbol"];

// Two identical expressions inside one symbol produce a byte-identical anchor, so the
// register cannot say which one a proof is about — `sibling.lease.holder !== undefined`
// appears twice in validateTerminalSiblings, and both mutants carry the same mutator and
// replacement. `occurrence` selects the Nth in source order, and `sites` records how many
// there were when the proof was written.
//
// `sites` is not bookkeeping. Without it, a third identical expression appearing later
// would silently shift what "occurrence 2" names, leaving a proof anchored, resolving,
// and about the wrong expression — the one failure this register exists to prevent. With
// it, any change to the number of identical sites stales every entry that names them.
const POSITION_FIELDS = ["occurrence", "sites"];

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
        const positioned = POSITION_FIELDS.some((field) => field in entry);
        assertExactKeys(
            entry,
            positioned ? [...ENTRY_FIELDS, ...POSITION_FIELDS] : ENTRY_FIELDS,
            "mutation equivalence entry"
        );
        for (const field of ENTRY_FIELDS) assertString(entry[field], `equivalence entry ${field}`);
        const key = equivalenceKey(entry);
        if (positioned) {
            for (const field of POSITION_FIELDS) {
                if (!Number.isSafeInteger(entry[field]) || entry[field] < 1) {
                    throw new TypeError(
                        `Equivalence entry ${field} must be a positive integer: ${key}`
                    );
                }
            }
            // One site needs no ordinal, and admitting one would give a single anchor two
            // spellings — the drift the register refuses everywhere else.
            if (entry.sites < 2) {
                throw new TypeError(
                    `Equivalence entry names ${entry.sites} site and so must omit occurrence: ${key}`
                );
            }
            if (entry.occurrence > entry.sites) {
                throw new TypeError(
                    `Equivalence entry selects occurrence ${entry.occurrence} of ${entry.sites}: ${key}`
                );
            }
        }
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
    const at = entry.occurrence === undefined ? "" : ` [${entry.occurrence}/${entry.sites}]`;
    return `${entry.file}#${entry.symbol} ${entry.mutator} -> ${entry.replacement} @ ${entry.mutated}${at}`;
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
        const sites = anchoredNodes(source, declarations, entry.mutated).length;
        if (entry.occurrence === undefined) {
            if (sites !== 1) {
                failures.push(
                    `equivalence entry anchors ${sites} sites in its symbol, not one: ${key}`
                );
            }
        } else if (sites !== entry.sites) {
            failures.push(
                `equivalence entry was written against ${entry.sites} identical sites and its ` +
                    `symbol now has ${sites}: ${key}`
            );
        }
    }
    return failures;
}

/**
 * Both halves of the register have to mean the same thing by "in this symbol", so both
 * ask `anchoredNodes` — the auditor to count the sites, this to find the one a mutant
 * occupies. They did not always: this asked whether the mutant's innermost enclosing
 * declaration path *equalled* the entry's symbol, while the auditor searched *inside* the
 * named declaration. An entry naming a method whose mutant sat inside a `const` within it
 * therefore passed the audit and reconciled as stale forever — the symbol path carries
 * the variable, so `RunRepository.loadExecutionScope` never matched
 * `RunRepository.loadExecutionScope.unpairedTransition`. Naming the enclosing declaration
 * is what an author reasonably writes, and scoping is all the symbol was ever for.
 */
function anchors(entry, mutant, source, text) {
    if (mutant.mutatorName !== entry.mutator || mutant.replacement !== entry.replacement) {
        return false;
    }
    const start = offsetOf(source, mutant.location.start);
    const end = offsetOf(source, mutant.location.end);
    if (normalizeSource(text.slice(start, end)) !== entry.mutated) return false;
    const nodes = anchoredNodes(source, declarationsNamed(source, entry.symbol), entry.mutated);
    // A positioned entry resolves only against the site count it was written for, so a
    // symbol that gained or lost an identical expression reports stale rather than
    // silently re-pointing the proof at a different one.
    if (entry.occurrence !== undefined) {
        if (nodes.length !== entry.sites) return false;
        const selected = nodes[entry.occurrence - 1];
        return selected !== undefined && selected.getStart(source) === start;
    }
    return nodes.some((node) => node.getStart(source) === start);
}

/**
 * Every node inside `declarations` whose normalized text is exactly `mutated`, in source
 * order. Nodes rather than substring matches: a mutant replaces an expression, so text
 * that happens to appear inside a larger one is not a site a mutant could occupy.
 *
 * The enumeration is syntactic, not type-aware, so a string-literal type annotation
 * counts — `validateLineage` holds four `"revokedGrant"` sites where a reader sees three,
 * the extra pair coming from its return type. That is deliberate: the count exists to
 * detect drift, and an edit to the annotation is drift worth staling a proof over. It
 * does mean an ordinal cannot be counted by eye; derive it from this resolver.
 */
function anchoredNodes(source, declarations, mutated) {
    const found = [];
    const walk = (node) => {
        if (normalizeSource(node.getText(source)) === mutated) found.push(node);
        ts.forEachChild(node, walk);
    };
    for (const declaration of declarations) ts.forEachChild(declaration, walk);
    return found.sort((left, right) => left.getStart(source) - right.getStart(source));
}

function parseSource(file, text) {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function offsetOf(source, position) {
    return ts.getPositionOfLineAndCharacter(source, position.line - 1, position.column - 1);
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
