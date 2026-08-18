// Supply-chain gate: an install must not be able to run code nobody reviewed.
//
// A dependency's lifecycle script runs arbitrary code at install time, with the developer's
// or the runner's credentials, before a single type, lint or test gate has read a byte. pnpm
// 10 blocks those scripts by default and `pnpm ignored-builds` reports none, which is why
// nothing here has ever run one — but a default is not a policy. It moves with the package
// manager, `pnpm approve-builds` writes an allowlist entry with no ceremony, and on the
// pinned version an ignored script is a warning that leaves the install green, so CI would
// not go red the day one arrives. The allowlist is therefore declared empty, and this gate
// holds it there alongside the rest of what an install's integrity actually rests on: one
// exact package manager, a frozen lockfile, and third-party code named by immutable
// identities rather than tags that can be moved under us after review.
//
// The universe is the workspace pnpm itself reads — the root manifest plus the `packages`
// patterns — so a new package cannot arrive outside the gate's view, and no directory the
// installer ignores can drag findings in. Every check reads a committed file: nothing here
// consults the network, the installed tree, or a registry, because a gate that asks the
// registry what a version means today cannot answer what it meant when the lockfile was
// reviewed.
import { glob, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
    assertString,
    compareCanonicalText,
    portable,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";

// Corepack accepts a bare range, so exactness is asserted rather than assumed; the optional
// `+sha` suffix carries integrity and is admitted, never required.
const EXACT_PACKAGE_MANAGER = /^[a-z][a-z0-9-]*@\d+\.\d+\.\d+(?:-[0-9a-z.]+)?(?:\+[0-9a-z.-]+)?$/u;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.]+)?$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

// Settings that hand a dependency the right to execute. `onlyBuiltDependencies` is pnpm 10's
// name and `allowBuilds` pnpm 11's; both are read so a package-manager upgrade cannot carry
// an allowlist in under a name this gate does not know.
const ALLOWLIST_KEYS = ["onlyBuiltDependencies", "allowBuilds"];
const BLANKET_KEYS = ["dangerouslyAllowAllBuilds"];

// `.npmrc` can re-enable what the workspace policy forbids, and it wins where it sits.
const FORBIDDEN_NPMRC = [
    [/^\s*ignore-scripts\s*=\s*false\b/imu, "re-enables dependency lifecycle scripts"],
    [/^\s*enable-pre-post-scripts\s*=\s*true\b/imu, "re-enables pre- and post- script pairs"],
    [/^\s*dangerously-allow-all-builds\s*=\s*true\b/imu, "allows every dependency to build"],
    [/^\s*unsafe-perm\s*=\s*true\b/imu, "runs install scripts with elevated permissions"]
];

const options = parseArguments(process.argv.slice(2));
const issues = [];

const workspacePath = resolve(options.root, "pnpm-workspace.yaml");
const workspace = parseYaml(await read(workspacePath)) ?? {};
const manifests = await workspaceManifests();

checkBuildAllowlist();
await checkNpmrc();
await checkManifestAllowlists();
await checkPackageManagerPin();
await checkWorkflowPins();
await checkRuntimePins();

issues.sort((left, right) => compareCanonicalText(left.fingerprint, right.fingerprint));
const report = {
    stage: options.stage,
    manifests: manifests.map((path) => portablePath(path)),
    issues,
    complete: issues.length === 0
};
await writeCanonicalJson(resolve(reportRoot, "supply-chain.json"), report);
if (issues.length > 0) fail("Supply-chain policy violations", issues);
console.log(`supply-chain complete: ${issues.length} issue(s)`);

/**
 * The allowlist has to be empty *and* stated. An absent declaration is the finding this gate
 * exists for: the repository would then be resting on the current package manager's default,
 * which no review sees change and no diff records.
 */
function checkBuildAllowlist() {
    const file = portablePath(workspacePath);
    for (const key of ALLOWLIST_KEYS) {
        const declared = workspace[key];
        if (declared === undefined) continue;
        if (!Array.isArray(declared)) {
            issue("build-policy", file, key, `${key} must be an array`);
            continue;
        }
        for (const name of declared) {
            issue(
                "build-policy",
                file,
                key,
                `${String(name)} may run install scripts; every approval is a reviewed exception`
            );
        }
    }
    if (!ALLOWLIST_KEYS.some((key) => Array.isArray(workspace[key]))) {
        issue(
            "build-policy",
            file,
            "onlyBuiltDependencies",
            "no build allowlist is declared, so the policy is the package manager's default rather than this repository's"
        );
    }
    for (const key of BLANKET_KEYS) {
        if (workspace[key] === true) {
            issue("build-policy", file, key, `${key} permits every dependency to execute`);
        }
    }
}

/** A `.npmrc` beside any manifest overrides the workspace policy, so absence is the check. */
async function checkNpmrc() {
    for (const directory of [options.root, ...manifests.map((path) => dirname(path))]) {
        const path = resolve(directory, ".npmrc");
        const text = await readOrUndefined(path);
        if (text === undefined) continue;
        const file = portablePath(path);
        for (const [pattern, consequence] of FORBIDDEN_NPMRC) {
            if (pattern.test(text)) issue("npmrc", file, "setting", `npmrc ${consequence}`);
        }
        for (const key of [...ALLOWLIST_KEYS, ...BLANKET_KEYS]) {
            if (new RegExp(`^\\s*${key}\\s*=`, "imu").test(text)) {
                issue("npmrc", file, key, `npmrc declares ${key} outside the workspace policy`);
            }
        }
    }
}

/**
 * pnpm reads the allowlist from a manifest's `pnpm` block too. Two places that can permit a
 * build are two sources of truth, so a manifest naming one is a finding even when the
 * workspace file is clean.
 */
async function checkManifestAllowlists() {
    for (const path of manifests) {
        const settings = (await readCanonicalJson(path)).pnpm;
        if (settings === undefined) continue;
        const file = portablePath(path);
        for (const key of ALLOWLIST_KEYS) {
            const declared = settings[key];
            if (declared === undefined) continue;
            if (Array.isArray(declared) && declared.length === 0) continue;
            issue(
                "build-policy",
                file,
                `pnpm.${key}`,
                `${key} in a manifest is a second source of truth for the build allowlist`
            );
        }
        for (const key of BLANKET_KEYS) {
            if (settings[key] !== true) continue;
            issue(
                "build-policy",
                file,
                `pnpm.${key}`,
                `${key} permits every dependency to execute`
            );
        }
    }
}

/** One exact package manager, and a lockfile it is required to honour. */
async function checkPackageManagerPin() {
    const manifestPath = resolve(options.root, "package.json");
    const manifest = await readCanonicalJson(manifestPath);
    const file = portablePath(manifestPath);
    // Absent is a finding; present-but-not-a-string is malformed input, so it is parsed at
    // the boundary and rejected there rather than reported as an unpinned resolver.
    const pinned = manifest.packageManager;
    if (pinned === undefined) {
        issue(
            "toolchain",
            file,
            "packageManager",
            "no package manager is pinned, so the resolver that reads the lockfile is whatever the machine has"
        );
    } else if (!EXACT_PACKAGE_MANAGER.test(assertString(pinned, "packageManager"))) {
        issue(
            "toolchain",
            file,
            "packageManager",
            `${pinned} is not an exact version, so two installs can resolve two resolvers`
        );
    }
    const lockfile = resolve(options.root, "pnpm-lock.yaml");
    if ((await readOrUndefined(lockfile)) === undefined) {
        issue(
            "toolchain",
            portablePath(lockfile),
            "pnpm-lock.yaml",
            "no committed lockfile, so no install can be frozen to reviewed versions"
        );
    }
}

/**
 * A tag is a mutable pointer: an action reviewed at `@v4` is not the code that runs at `@v4`
 * next week. A downloaded release artifact is the same problem one layer out, which is why a
 * `curl` in a workflow has to check what it fetched against a digest.
 */
async function checkWorkflowPins() {
    for (const path of await workflows()) {
        const text = await read(path);
        const file = portablePath(path);
        for (const [, reference] of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gmu)) {
            if (reference.startsWith("./")) continue;
            const at = reference.lastIndexOf("@");
            const ref = at === -1 ? "" : reference.slice(at + 1);
            if (COMMIT_SHA.test(ref)) continue;
            issue(
                "workflow",
                file,
                reference,
                "action is named by a mutable reference rather than a commit sha"
            );
        }
        if (/\bpnpm install\b/u.test(text) && !/--frozen-lockfile\b/u.test(text)) {
            issue(
                "workflow",
                file,
                "pnpm install",
                "installs without --frozen-lockfile, so the lockfile can be rewritten mid-run"
            );
        }
        if (/\bcurl\b/u.test(text) && !/\bsha256sum\s+-c\b/u.test(text)) {
            issue(
                "workflow",
                file,
                "curl",
                "downloads a release artifact without checking it against a digest"
            );
        }
    }
}

/** CI resolves each runtime from these files, so a range here is a range in every lane. */
async function checkRuntimePins() {
    for (const name of [".node-version", ".bun-version"]) {
        const path = resolve(options.root, name);
        const text = await readOrUndefined(path);
        if (text === undefined) {
            issue(
                "toolchain",
                portablePath(path),
                name,
                `${name} is absent, so the runtime is unpinned`
            );
            continue;
        }
        const version = text.trim();
        if (EXACT_SEMVER.test(version)) continue;
        issue(
            "toolchain",
            portablePath(path),
            name,
            `${version} is not an exact version, so two lanes can run two runtimes`
        );
    }
}

/**
 * The manifests pnpm reads: the root plus every `packages` pattern. An unsupported pattern
 * throws rather than matching nothing, so a workspace this gate cannot enumerate is a failure
 * instead of a silently empty universe.
 */
async function workspaceManifests() {
    const patterns = workspace.packages ?? [];
    if (!Array.isArray(patterns)) throw new TypeError("Workspace packages must be an array");
    const found = [resolve(options.root, "package.json")];
    for (const declared of patterns) {
        const pattern = assertString(declared, "Workspace package pattern");
        if (pattern.includes("**")) {
            throw new TypeError(`Unsupported workspace pattern ${pattern}`);
        }
        for await (const match of glob(`${pattern}/package.json`, { cwd: options.root })) {
            found.push(resolve(options.root, match));
        }
    }
    return [...new Set(found)].sort();
}

async function workflows() {
    const found = [];
    for await (const match of glob(".github/workflows/*.{yml,yaml}", { cwd: options.root })) {
        found.push(resolve(options.root, match));
    }
    return found.sort();
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

function portablePath(path) {
    return portable(relative(options.root, path));
}

async function read(path) {
    return readFile(path, "utf8");
}

async function readOrUndefined(path) {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return undefined;
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
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--root") root = resolve(required(args, ++index, argument));
        else throw new TypeError(`Unknown supply-chain argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return { stage, root };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
