// The inputs a mutation run of one area can read, and the fingerprint over them.
//
// The fingerprint decides when a pinned measurement has gone stale, so it must cover
// every input that can change a result and nothing else. Hashing more than that is not
// merely wasteful: it stales all 23 areas — roughly an hour and a half of measurement —
// for a provably identical outcome, which is how a ratchet stops being run. The
// equivalence register is one of those inputs, sliced per area so it stales only what it
// actually decides.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import mutationVitestConfig from "../../vitest.mutation.config.mjs";
import {
    equivalenceArea,
    equivalenceKey,
    readEquivalenceRegister
} from "./mutation-equivalence.mjs";
import {
    artifactRoot,
    canonicalJson,
    globMatches,
    packageRoot,
    parseCanonicalJson
} from "./project.mjs";

// An area is a src/ subdirectory, or a single root module such as errors.
export function sourceAreas() {
    return readdirSync(resolve(packageRoot, "src"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".ts")))
        .map((entry) => (entry.isDirectory() ? entry.name : entry.name.slice(0, -3)))
        .sort();
}

// The test files a mutation run is allowed to execute. The lanes
// vitest.mutation.config.mjs excludes never run under Stryker, so nothing in them can
// change a measurement. Their exclusion is read from that config rather than restated
// here, so the two cannot drift apart.
export function mutationTestFiles() {
    return walkTypeScript(resolve(packageRoot, "test")).filter((path) => {
        const portable = relative(packageRoot, path).replaceAll("\\", "/");
        return !mutationVitestConfig.test.exclude.some((pattern) => globMatches(pattern, portable));
    });
}

/**
 * The fingerprint of one area under one equivalence register. The register is an input
 * because it decides which survivors count as actionable: dropping an entry raises the
 * count an area's pinned baseline is holding down, and staling the area is what forces
 * that back through the ratchet instead of leaving the floor quietly loose.
 */
export function mutationFingerprint(area, register = committedRegister()) {
    const hash = createHash("sha256");
    digestFiles(hash, [
        ...typescriptFilesForArea(area),
        ...mutationTestFiles(),
        resolve(packageRoot, "package.json"),
        resolve(packageRoot, "stryker.conf.mjs"),
        // The mutation config spreads the default one and aliases the bun built-ins to
        // local shims; a run loads those shims, so they are inputs like any other.
        resolve(packageRoot, "vitest.config.mjs"),
        resolve(packageRoot, "vitest.mutation.config.mjs"),
        ...Object.values(mutationVitestConfig.resolve.alias),
        resolve(packageRoot, "../..", "pnpm-lock.yaml")
    ]);
    // Only entry identity is hashed, and only for this area: rewording a proof cannot
    // change a count, and an area with no entries hashes nothing extra, so no measurement
    // stales for a register slice it does not depend on.
    const keys = register
        .filter((entry) => equivalenceArea(entry.file) === area)
        .map(equivalenceKey)
        .sort();
    for (const key of keys) {
        hash.update(key);
        hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
}

// The installed packages whose code decides a mutant's verdict. Read from what is
// actually resolved rather than from the manifest that asked for it: a lockfile records
// an intention, and the sandbox symlinks node_modules, so only the installed version says
// what ran.
const RUNTIME_PACKAGES = [
    "@stryker-mutator/core",
    "@stryker-mutator/instrumenter",
    "@stryker-mutator/vitest-runner",
    "@vitest/coverage-v8",
    "typescript",
    "vite",
    "vitest"
];

// Environment that reaches module resolution, a transform, or a test's own answer.
// AGENT_CORE_ENFORCEMENT is the one that changes what the suite even loads:
// vitest.config.mjs resolves every import of src/facets/enforcement to the TSLean-lowered
// twin when it is set. The prefixes are there so a variable added to a config later is
// bound without anyone remembering to list it.
const RUNTIME_ENVIRONMENT = ["LANG", "LC_ALL", "NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "TZ"];
const RUNTIME_ENVIRONMENT_PREFIXES = ["AGENT_CORE_", "STRYKER", "VITE"];

/**
 * Everything outside the tree that decides what a run computes: the interpreter, its
 * ABI, the platform, the installed tool versions, and the environment the run inherits.
 * Recorded beside a measurement as well as hashed into its key, so a reader can see which
 * of these moved when a cache stops matching.
 */
export function mutationRunIdentity() {
    const packages = {};
    for (const name of RUNTIME_PACKAGES) {
        const manifest = resolve(packageRoot, "node_modules", name, "package.json");
        packages[name] = existsSync(manifest)
            ? String(JSON.parse(readFileSync(manifest, "utf8")).version)
            : "absent";
    }
    const environment = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        const bound =
            RUNTIME_ENVIRONMENT.includes(name) ||
            RUNTIME_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix));
        if (bound) environment[name] = value;
    }
    return {
        abi: process.versions.modules,
        environment,
        node: process.version,
        packages,
        platform: `${process.platform}-${process.arch}`,
        v8: process.versions.v8
    };
}

/**
 * The key a recorded measurement of one area may be reused under. What a measurement
 * costs, and why reuse is worth having, is mutation-run.mjs's story.
 *
 * Reuse is deliberately stricter than the fingerprint the baseline pins. The fingerprint
 * is what the gate already trusts to call a pinned measurement fresh, and it covers the
 * area's own sources and the test lanes; a run reads far more than that — SPEC.md and the
 * artifacts the conformance tests open, tsconfig.json, the quality scripts, the formal
 * model — so the key covers every file Stryker copies into its sandbox, plus the runtime
 * identity outside the tree. Reuse therefore never happens where a fresh run could have
 * disagreed with the pin, which is what stops the cache from being a second, weaker
 * freshness rule sitting beside the gate's.
 */
export function mutationRunKey(area, register = committedRegister()) {
    const hash = createHash("sha256");
    hash.update(mutationFingerprint(area, register));
    hash.update("\0");
    digestFiles(hash, sandboxFiles());
    hash.update(JSON.stringify(canonicalJson(mutationRunIdentity())));
    hash.update("\0");
    return `sha256:${hash.digest("hex")}`;
}

/**
 * Every file a run can read, by the predicate Stryker itself uses. Its sandbox is the
 * package minus what .gitignore excludes, so asking git for the same set is a reading of
 * that rule rather than a second guess at it — and the two agree exactly: Stryker reports
 * 1058 input files and `git ls-files -c -o --exclude-standard` lists 1058.
 */
function sandboxFiles() {
    const listed = spawnSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], {
        cwd: packageRoot,
        maxBuffer: 64 * 1024 * 1024
    });
    if (listed.status !== 0) {
        throw new TypeError("Mutation run inputs are unknowable: git ls-files failed");
    }
    return listed.stdout
        .toString("utf8")
        .split("\0")
        .filter((offset) => offset.length > 0)
        .map((offset) => resolve(packageRoot, offset));
}

// Path then content, both terminated: a rename changes the digest even when no byte of
// any file did, and no concatenation of two files can imitate a third. An input git lists
// but the tree no longer holds hashes as absent rather than throwing, so a deletion moves
// the digest instead of crashing the run that should have noticed it.
function digestFiles(hash, paths) {
    for (const path of [...paths].sort()) {
        hash.update(relative(packageRoot, path).replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(existsSync(path) ? readFileSync(path) : "absent");
        hash.update("\0");
    }
}

function committedRegister() {
    const offset = "quality/mutation-equivalence.json";
    const source = readFileSync(resolve(artifactRoot, offset), "utf8");
    return readEquivalenceRegister(parseCanonicalJson(source, `artifacts/${offset}`));
}

function typescriptFilesForArea(area) {
    const directory = resolve(packageRoot, "src", area);
    if (existsSync(directory) && statSync(directory).isDirectory())
        return walkTypeScript(directory);
    const file = resolve(packageRoot, "src", `${area}.ts`);
    return existsSync(file) ? [file] : [];
}

function walkTypeScript(root) {
    const files = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) files.push(...walkTypeScript(path));
        else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
    }
    return files;
}
