// The inputs a mutation run of one area can read, and the fingerprint over them.
//
// The fingerprint decides when a pinned measurement has gone stale, so it must cover
// every input that can change a result and nothing else. Hashing more than that is not
// merely wasteful: it stales all 23 areas — roughly an hour and a half of measurement —
// for a provably identical outcome, which is how a ratchet stops being run. The
// equivalence register is one of those inputs, sliced per area so it stales only what it
// actually decides.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import strykerConfig from "../../stryker.conf.mjs";
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
 *
 * Environment values are digested, never kept. The bound names are matched by prefix and
 * `STRYKER_DASHBOARD_API_KEY` is a real Stryker variable, so a run in a credentialed
 * shell would otherwise write a token into a report that lives on disk for the rest of
 * the campaign. A digest distinguishes two values, which is all a key needs, and names a
 * variable that changed, which is all a reader needs.
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
        if (bound) {
            environment[name] = `sha256:${createHash("sha256").update(value).digest("hex")}`;
        }
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
 * artifacts the conformance and integration lanes open, tsconfig.json, the quality
 * scripts, the formal model — so the key covers every file Stryker crawls into its
 * sandbox, plus the runtime identity outside the tree. Reuse therefore never happens
 * where a fresh run could have disagreed with the pin, which is what stops the cache from
 * being a second, weaker freshness rule sitting beside the gate's.
 */
export function mutationRunKey(area, register = committedRegister()) {
    const hash = createHash("sha256");
    hash.update(mutationFingerprint(area, register));
    hash.update("\0");
    digestFiles(hash, sandboxFiles(packageRoot));
    hash.update(JSON.stringify(canonicalJson(mutationRunIdentity())));
    hash.update("\0");
    return `sha256:${hash.digest("hex")}`;
}

// What Stryker 9.6.1's ProjectReader skips no matter what it is told: its own
// ALWAYS_IGNORE list, matched by basename at any depth. It reads no .gitignore —
// `resolveInputFileNames` crawls `process.cwd()` and prunes by these names and by
// `ignorePatterns` alone — so a rule derived from git would have been a different set that
// happened, once, to have the same size.
const ALWAYS_IGNORED = [".git", ".next", ".nuxt", ".svelte-kit", "node_modules"];

// The version this mirror was read from. Its crawl and its ignore semantics are not API,
// so an upgrade has to be re-read rather than assumed: a release that adds a name to
// ALWAYS_IGNORE only stales measurements that could not have changed, but one that stops
// pruning node_modules would have the key covering less than a run reads, and a cache is
// only as sound as that containment. Refusing is the fail-closed answer.
const MIRRORED_STRYKER = "9.6.1";

/**
 * Every file a run can read: Stryker's crawl, mirrored. The pruning is read from the
 * committed Stryker configuration rather than restated, so the sandbox and the key cannot
 * disagree about `reports/` — and they must not, because this runner's own scratch, ledger
 * and cache live there.
 *
 * Two details decide whether the mirror is exact rather than approximately right. A
 * leading-slash pattern is anchored at the crawl root, so `/reports` prunes `reports/` and
 * leaves a nested `src/x/reports/` in the sandbox — treating it as a bare name would omit
 * from the key a directory Stryker copies. And `readdir` does not follow links, so
 * Stryker's `dirent.isDirectory()` is false for a symlink and it copies it as a file;
 * anything that is not a directory is therefore a file here too.
 */
function sandboxFiles(root) {
    return crawl(root, "", ignoreRules());
}

function crawl(root, at, rules) {
    const files = [];
    for (const entry of readdirSync(resolve(root, at), { withFileTypes: true })) {
        const offset = at.length === 0 ? entry.name : `${at}/${entry.name}`;
        if (rules.anywhere.has(entry.name)) continue;
        if (at.length === 0 && rules.atRoot.has(entry.name)) continue;
        if (entry.name.endsWith(".tsbuildinfo")) continue;
        if (entry.isDirectory()) files.push(...crawl(root, offset, rules));
        else files.push(resolve(root, offset));
    }
    return files;
}

/**
 * The configured pruning, parsed exactly. Only the two shapes this project uses are
 * understood — a leading slash anchors a name at the crawl root, a leading double star
 * and slash matches it at any depth — and
 * anything else refuses the run rather than being guessed at. A pattern this cannot read
 * would silently drop from the key a file Stryker copies, and the whole value of the key
 * is that it cannot do that.
 */
function ignoreRules() {
    const installed = resolve(packageRoot, "node_modules/@stryker-mutator/core/package.json");
    const version = String(JSON.parse(readFileSync(installed, "utf8")).version);
    if (version !== MIRRORED_STRYKER) {
        throw new TypeError(
            `Mutation reuse mirrors @stryker-mutator/core@${MIRRORED_STRYKER}'s file crawl ` +
                `and ${version} is installed. Re-read ProjectReader.resolveInputFileNames ` +
                "and its ALWAYS_IGNORE list, then move MIRRORED_STRYKER."
        );
    }
    const atRoot = new Set([strykerConfig.tempDirName]);
    const anywhere = new Set(ALWAYS_IGNORED);
    for (const pattern of strykerConfig.ignorePatterns) {
        if (/^[/][^*/]+$/u.test(pattern)) atRoot.add(pattern.slice(1));
        else if (/^[*][*][/][^*/]+$/u.test(pattern)) anywhere.add(pattern.slice(3));
        else {
            throw new TypeError(
                `Mutation reuse cannot mirror the Stryker ignore pattern ${pattern}. ` +
                    "Express it as /name or **/name, or teach ignoreRules to read it."
            );
        }
    }
    return { anywhere, atRoot };
}

// Path then content, both terminated: a rename changes the digest even when no byte of any
// file did, and no concatenation of two files can imitate a third. A path the crawl listed
// but cannot be read — deleted between the two, or a link to a directory, both of which
// Stryker would also choke on — digests as the reason instead of crashing the run that
// should have noticed it.
function digestFiles(hash, paths) {
    for (const path of [...paths].sort()) {
        hash.update(relative(packageRoot, path).replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(fileBytes(path));
        hash.update("\0");
    }
}

function fileBytes(path) {
    try {
        return readFileSync(path);
    } catch (error) {
        return `unreadable:${error instanceof Error ? error.message : "unknown"}`;
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
