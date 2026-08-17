import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertString, parseCanonicalJson } from "./quality/project.mjs";

/**
 * A conformance fragment's `specTextSha256` values are the one field in this repository
 * that several writers move concurrently, that nobody reviews in a diff, and that fails
 * only at the end of the campaign. A stale working copy, or a patch generated with a bare
 * `git diff` against an index other agents are writing, silently restores every digest a
 * peer changed since that copy was made. Both happened on this branch.
 *
 * So intent is declared rather than inferred. Every digest this run moves must be a digest
 * the caller named, and the default declaration is empty: most commits move none.
 *
 * A moved digest is not always vandalism, which is why this reports rather than judges.
 * Rewording an anchored paragraph moves its digest legitimately. So does landing a table
 * beside an anchored paragraph, because `sourceOwnedBy` absorbs an adjacent table into the
 * digested unit without the paragraph changing at all — invisible in a diff of the file and
 * in a diff of the paragraph. Declaring the move is how that becomes visible.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const conformanceDirectory = `${relative(repositoryRoot, resolve(packageRoot, "artifacts/conformance")).replaceAll("\\", "/")}`;
const notFragments = ["index.json", "schema.json", "stage.json"];
const options = parseArguments(process.argv.slice(2));

// A thrown error is invisible to a caller who pipes stdout, which is how the first users
// read "exit=0" beside a failure. Report on stderr and set the code explicitly instead.
const failure = options.since === undefined ? reportIntent() : reportReverts();
if (failure !== undefined) {
    process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
}

/**
 * The declared-intent check: exactly the digests the caller named may differ between the
 * base revision and the candidate. A new atom is an addition rather than a move and needs
 * no declaration, because no previous value existed to overwrite. A vanished row is neither
 * — a fragment losing a requirement it held is a regression whatever moved the digests, so
 * it fails unless `--allow-removals` says the atom left the SPEC.
 */
function reportIntent() {
    const base = rowsAt(options.base);
    const candidate =
        options.candidate === "worktree" ? rowsInWorktree(base.keys()) : rowsAt(options.candidate);
    const changed = [];
    const added = [];
    const removed = [];
    for (const [key, row] of base) {
        const now = candidate.get(key);
        if (now === undefined) removed.push(key);
        else if (now.source !== row.source) changed.push({ key, from: row, to: now });
    }
    for (const key of candidate.keys()) {
        if (!base.has(key)) added.push(key);
    }
    for (const entry of changed) {
        const declared = options.moves.has(idOf(entry.key));
        const fields = changedFields(entry.from.requirement, entry.to.requirement);
        console.log(`${declared ? "declared" : "UNDECLARED"} change ${entry.key} [${fields.join(", ")}]`);
        if (entry.from.requirement.specTextSha256 !== entry.to.requirement.specTextSha256) {
            console.log(
                `  digest ${entry.from.requirement.specTextSha256}\n      -> ${entry.to.requirement.specTextSha256}`
            );
        }
    }
    for (const key of added) console.log(`added   ${key}`);
    for (const key of removed) console.log(`REMOVED ${key}`);
    const undeclared = changed.filter((entry) => !options.moves.has(idOf(entry.key)));
    // A declaration that changed nothing is as wrong as an undeclared change: it means the
    // reword the caller believed they made did not land, or landed under another id. Both
    // are reported together, because seeing only one of them invites the wrong repair.
    const unchanged = [...options.moves].filter(
        (id) => !changed.some((entry) => idOf(entry.key) === id)
    );
    const problems = [
        ...undeclared.map((entry) => `undeclared change ${entry.key}`),
        ...unchanged.map((id) => `declared change that did not happen ${id}`),
        ...(options.allowRemovals ? [] : removed.map((key) => `removed requirement ${key}`))
    ];
    console.log(
        `${options.base} -> ${options.candidate}: ${changed.length} change(s), ${added.length} addition(s), ${removed.length} removal(s)`
    );
    if (problems.length > 0) return `Digest intent violated: ${problems.join("; ")}`;
    return undefined;
}

/**
 * The revert signature: a digest value that was abandoned and later resurrected. A reword
 * only ever introduces a new value once, so a value reappearing means a stale copy
 * overwrote a peer.
 *
 * This reports and does not gate unless asked. Repairing a revert restores the displaced
 * value, which is itself a reappearance, so history alone cannot separate the vandalism
 * from its repair — only the digest the SPEC currently derives can, and ledger.mjs already
 * makes that comparison. What this adds is the part that comparison cannot give: the commit
 * that did it. `--strict` is for a range believed clean.
 */
function reportReverts() {
    const commits = execFileSync(
        "git",
        ["-C", repositoryRoot, "rev-list", "--reverse", `${options.since}..HEAD`],
        { encoding: "utf8" }
    )
        .split("\n")
        .filter((line) => line.length > 0);
    const history = new Map();
    for (const commit of commits) {
        for (const [key, row] of rowsAt(commit)) {
            const value = row.requirement.specTextSha256;
            const seen = history.get(key) ?? [];
            if (seen.at(-1)?.value !== value) seen.push({ commit, value });
            history.set(key, seen);
        }
    }
    const reverts = [];
    for (const [key, sequence] of history) {
        for (let index = 0; index < sequence.length; index += 1) {
            const earlier = sequence.findIndex((entry) => entry.value === sequence[index].value);
            if (earlier >= 0 && earlier < index - 1) {
                reverts.push({ key, value: sequence[index].value, commit: sequence[index].commit });
            }
        }
    }
    for (const revert of reverts) {
        console.log(
            `resurrected ${revert.key}\n  value ${revert.value}\n  in    ${revert.commit.slice(0, 7)}`
        );
    }
    console.log(
        `${reverts.length} resurrected digest value(s) across ${commits.length} commit(s), ${history.size} tracked digest(s)`
    );
    if (options.strict && reverts.length > 0) {
        return `${reverts.length} resurrected digest value(s) in a range declared clean`;
    }
    return undefined;
}

/**
 * `<fragment>#<atom>` keyed rows for one revision, read from git rather than the tree, with
 * the canonical text of each row alongside it. The whole row is compared, not only the
 * digest: a stale whole-file write reverts `status`, `sourceSymbols`, `testSelectors`,
 * `checkerInvariants` and `prerequisites` without moving a digest at all, which is exactly
 * what a re-point or a demotion changes and what no digest-based check can see.
 */
function rowsAt(revision) {
    const rows = new Map();
    for (const name of fragmentNamesAt(revision)) {
        const source = execFileSync(
            "git",
            ["-C", repositoryRoot, "show", `${revision}:${conformanceDirectory}/${name}`],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
        );
        collect(rows, name, parseCanonicalJson(source, `${revision}:${name}`));
    }
    return rows;
}

/**
 * The same map for the files on disk. Fragment names come from the base revision so a
 * fragment a peer has staged but not committed cannot silently enter the comparison.
 */
function rowsInWorktree(baseKeys) {
    const names = new Set([...baseKeys].map((key) => key.slice(0, key.indexOf("#"))));
    const rows = new Map();
    for (const name of names) {
        const path = resolve(packageRoot, "artifacts/conformance", name);
        collect(rows, name, parseCanonicalJson(readFileSync(path, "utf8"), name));
    }
    return rows;
}

function collect(rows, name, fragment) {
    if (!Array.isArray(fragment?.requirements)) {
        throw new TypeError(`Conformance fragment ${name} has no requirements array`);
    }
    for (const requirement of fragment.requirements) {
        assertString(requirement?.id, `Conformance fragment ${name} requirement id`);
        assertString(
            requirement.specTextSha256,
            `Conformance fragment ${name} requirement ${requirement.id} digest`
        );
        rows.set(`${name}#${requirement.id}`, {
            requirement,
            source: JSON.stringify(requirement)
        });
    }
}

/** Which fields a changed row changed, so a reverted demotion reads as `status`. */
function changedFields(before, after) {
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return fields.filter(
        (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field])
    );
}

function fragmentNamesAt(revision) {
    return execFileSync(
        "git",
        ["-C", repositoryRoot, "ls-tree", "--name-only", `${revision}:${conformanceDirectory}`],
        { encoding: "utf8" }
    )
        .split("\n")
        .filter((name) => name.endsWith(".json") && !notFragments.includes(name))
        .sort();
}

function idOf(key) {
    return key.slice(key.indexOf("#") + 1);
}

function parseArguments(args) {
    let base;
    let candidate = "worktree";
    let since;
    let strict = false;
    let allowRemovals = false;
    const moves = new Set();
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--base") base = required(args, ++index, argument);
        else if (argument === "--candidate") candidate = required(args, ++index, argument);
        else if (argument === "--since") since = required(args, ++index, argument);
        else if (argument === "--strict") strict = true;
        else if (argument === "--allow-removals") allowRemovals = true;
        else if (argument === "--moves") {
            for (const id of required(args, ++index, argument).split(",")) {
                if (id.length > 0) moves.add(id);
            }
        } else throw new TypeError(`Unknown digest-intent argument ${argument}`);
    }
    if (since !== undefined && moves.size > 0) {
        throw new TypeError("--since scans history and takes no --moves declaration");
    }
    if (strict && since === undefined) {
        throw new TypeError("--strict applies to --since; the intent check always fails on a violation");
    }
    // Auditing a commit means comparing it with its parent. Defaulting the base to HEAD here
    // silently ran the comparison backwards and reported every later commit as damage, which
    // named other people's atoms and invited an accusation — the exact false positive this
    // exists to prevent.
    return {
        base: base ?? (candidate === "worktree" ? "HEAD" : `${candidate}^`),
        candidate,
        since,
        moves,
        strict,
        allowRemovals
    };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
