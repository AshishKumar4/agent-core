// Proof repair ledger gate: the committed accepted state must be the reviewed tree.
//
// `artifacts/quality/proof-repair.json` is the one durable record the untrusted-LLM proof
// repair protocol owns: the closed obligations, the accepted artifact text, and the
// baseline digest the next candidate binds itself to. The protocol's own store is the
// only writer, and its compare-and-publish never lowers the closed set — but nothing
// else in the tree verifies that the committed bytes and the reviewed formal tree still
// agree. A ledger that drifts from `formal/` — an accepted artifact hand-edited after
// the fact, or a formal file rewritten without a new acceptance — would hand the next
// repair a baseline over text nobody reviewed.
//
// This gate's whole job: decode the committed record through the versioned codec — the
// store's own reader, with the unknown-major and newer-minor refusals that keep a
// doctored version from reading as a newer accepted state — then assert every accepted
// artifact's text is byte-identical to the reviewed formal tree at the same relative
// path. On the genesis ledger both halves are vacuous: no closures, no artifacts.
//
// The TS protocol modules use `.js` specifiers that only a bundler or this package's
// test runner resolves natively, so this entry registers the companion loader first and
// imports the record and store modules through it.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { register } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reportRoot, writeCanonicalJson } from "./project.mjs";

register(new URL("./ts-companion.mjs", import.meta.url));

const { FileProofRepairStore, proofRepairLedgerArtifact } = await import("./proof-repair-store.ts");

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const formalRoot = resolve(scriptRoot, "../../formal");
const options = parseArguments(process.argv.slice(2));
const issues = [];
const summary = { closed: 0, artifacts: 0, genesis: false };

// Both trees this gate reads are component-walked before anything in them is loaded.
// The formal root itself must be an ordinary directory — a symlinked `formal/` makes
// every child's lstat ordinary while realpath containment treats the external target as
// the root, so the gate would bless external bytes — and the committed record's own path
// is walked from the package root down, because the store realpaths the record's
// directory and a symlinked `artifacts` would redirect the committed record outside the
// package while still loading as an ordinary file.
requireOrdinaryTree(formalRoot, "the reviewed formal tree root", resolve(scriptRoot, "../.."));
requireOrdinaryTree(
    proofRepairLedgerArtifact,
    "the committed proof repair ledger",
    resolve(scriptRoot, "../..")
);

const ledger = new FileProofRepairStore(proofRepairLedgerArtifact).load();
verifyCommittedIntegrity(ledger);

await writeCanonicalJson(join(reportRoot, "nodes", "proof-repair-ledger.json"), {
    edition: "1.0.0",
    stage: options.stage,
    ...summary,
    complete: issues.length === 0
});

if (issues.length > 0) {
    throw new TypeError(
        [
            "the committed proof repair ledger is not intact:",
            ...issues.map((issue) => `  ${issue}`),
            // A drifted ledger is repaired by a new acceptance through the protocol, never
            // by hand-editing the record: the protocol's store is the only writer, and
            // the bytes it would publish are the bytes a completed verification judged.
            "restore the ledger through a verified repair acceptance (the store is the only writer), never by editing the record"
        ].join("\n")
    );
}
console.log(
    `proof repair ledger verified: ${summary.closed} closed obligation(s), ` +
        `${summary.artifacts} accepted artifact(s) byte-identical to the reviewed formal tree` +
        (summary.genesis ? " (genesis ledger)" : "")
);

/**
 * The two halves of the gate.
 *
 * *Decoding.* The store's own reader is used, so a tampered path, a symlinked record, or
 * a non-canonical parse is refused exactly the way every reader of the ledger would
 * refuse it — and the codec's version policy (unknown major, newer minor) is the one
 * this gate's refusal text inherits.
 *
 * *Byte identity.* Every accepted artifact must be byte-identical to the reviewed formal
 * tree at the same relative path. The ledger's own digest binds the record's internal
 * consistency; only the tree can say whether the accepted text is still the reviewed
 * text. An absent formal file, or one differing byte, is drift, and the gate names the
 * artifact and the digests on both sides.
 */
function verifyCommittedIntegrity(ledger) {
    summary.closed = ledger.closed.length;
    summary.artifacts = ledger.artifacts.length;
    summary.genesis = ledger.candidate === undefined;
    if (summary.genesis && (summary.closed > 0 || summary.artifacts > 0)) {
        issues.push("a genesis ledger carries accepted state");
    }
    for (const artifact of ledger.artifacts) {
        const reviewed = reviewedArtifact(artifact.path);
        if (reviewed.refusal !== undefined) {
            issues.push(
                `accepted artifact ${artifact.path} is not an ordinary file inside the ` +
                    `reviewed formal tree: ${reviewed.refusal}`
            );
            continue;
        }
        // Byte identity is over bytes, not over decoded text: the `utf8` codec is lossy,
        // so a ledger text carrying a U+FFFD and a formal file carrying an invalid byte
        // at that position decode to the same JavaScript string. Reading the raw buffer
        // and re-encoding the accepted text keeps every byte difference observable.
        if (readFileSync(reviewed.path).equals(Buffer.from(artifact.text, "utf8"))) continue;
        issues.push(
            `accepted artifact ${artifact.path} is not byte-identical to the reviewed ` +
                `formal tree (ledger digest ${artifact.digest}, the tree bytes differ)`
        );
    }
    for (const entry of ledger.closed) {
        for (const path of entry.artifacts) {
            if (!ledger.artifacts.some((artifact) => artifact.path === path)) {
                issues.push(
                    `a closed obligation names artifact ${path} the ledger does not accept`
                );
            }
        }
    }
}

/**
 * The reviewed formal tree file one accepted artifact names, or the reason it cannot be
 * read as one.
 *
 * A symlink — as the final component or anywhere in a parent directory — resolves
 * outside `formal/`, so reading through it would compare the ledger's text against bytes
 * the reviewed tree does not contain at that path. Both are refused before anything is
 * read: the artifact's own path is checked with `lstat` (so a link is a link even when
 * its target is in-tree), and the fully resolved path is required to stay under the
 * resolved `formal` root (so a parent-directory link cannot redirect the read).
 */
function reviewedArtifact(path) {
    // Every component below the formal root is lstat-walked, so a symlink anywhere on
    // the way — not only the final one — is refused even when its target is a perfectly
    // ordinary file elsewhere inside the tree. The reviewed tree is the set of ordinary
    // files at their reviewed paths; a retargetable name, in-tree or not, is not one,
    // because the same path can be made to name different bytes without the ledger
    // changing a single byte of its own.
    const segments = path.split("/");
    let walked = formalRoot;
    for (const segment of segments) {
        walked = join(walked, segment);
        let entry;
        try {
            entry = lstatSync(walked);
        } catch (error) {
            return { refusal: `no reviewed formal tree file: ${error.message}` };
        }
        if (entry.isSymbolicLink()) {
            return { refusal: `it passes through the symlink ${relative(formalRoot, walked)}` };
        }
    }
    const entry = lstatSync(walked);
    if (!entry.isFile()) {
        return { refusal: `it is not an ordinary file: ${walked}` };
    }
    const resolved = realpathSync(walked);
    const contained = relative(realpathSync(formalRoot), resolved);
    if (contained.startsWith("..") || isAbsolute(contained)) {
        return { refusal: `it resolves outside the reviewed formal tree: ${resolved}` };
    }
    return { path: resolved };
}

/**
 * Refuses unless every component of one tree path, from a fixed base down, is an
 * ordinary directory (and, for the final component, an ordinary file when the path is a
 * file). A symlink at any depth — including the root of the tree itself — retargets the
 * path without changing anything the ledger records, so the gate reads the tree it was
 * given rather than whatever a link currently points at.
 */
function requireOrdinaryTree(target, described, fromBase) {
    const below = relative(fromBase, target);
    if (below.startsWith("..") || isAbsolute(below)) {
        throw new TypeError(`${described} escapes the package: ${target}`);
    }
    let walked = fromBase;
    for (const segment of below.split("/").filter((part) => part.length > 0)) {
        walked = join(walked, segment);
        const entry = lstatSync(walked);
        if (entry.isSymbolicLink()) {
            throw new TypeError(
                `${described} passes through the symlink ${relative(fromBase, walked)}: ${walked}`
            );
        }
    }
    const entry = lstatSync(walked);
    const isFile = target === proofRepairLedgerArtifact;
    if (isFile && !entry.isFile()) {
        throw new TypeError(`${described} is not an ordinary file: ${walked}`);
    }
    if (!isFile && !entry.isDirectory()) {
        throw new TypeError(`${described} is not an ordinary directory: ${walked}`);
    }
}

function parseArguments(args) {
    let stage = "building";
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else throw new TypeError(`Unknown proof-repair-ledger argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") {
        throw new TypeError(`Unknown quality stage ${stage}`);
    }
    return { stage };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
