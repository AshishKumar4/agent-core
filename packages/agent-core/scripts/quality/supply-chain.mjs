// Supply-chain gate: an install must not be able to run code nobody reviewed.
//
// A dependency's lifecycle script runs arbitrary code at install time, with the developer's
// or the runner's credentials, before a single type, lint or test gate has read a byte. pnpm
// 10 blocks those scripts by default and `pnpm ignored-builds` reports none, which is why
// nothing here has ever run one — but a default is not a policy. It moves with the package
// manager, `pnpm approve-builds` writes an allowlist entry with no ceremony, and an empty
// allowlist on its own only downgrades an unruled script to a warning that leaves the
// install green. So the allowlist is declared empty *and* `strictDepBuilds` makes an unruled
// build a failed install, with `ignoredBuiltDependencies` as the reviewed record of the
// scripts that never run. This gate holds all three there, alongside the rest of what an
// install's integrity actually rests on: one exact package manager named by the bytes of its
// archive rather than by a version alone, a frozen lockfile whose every entry is a registry
// artifact named only by an integrity hash, no hook file or config dependency that pnpm
// loads before it has read a policy, and no ambient user configuration — the committed
// `.npmrc` states what an install may do, and every one of its settings is required here.
//
// The universe is the workspace pnpm itself reads — the root manifest plus the `packages`
// patterns — so a new package cannot arrive outside the gate's view, and no directory the
// installer ignores can drag findings in. Every check reads a committed file: nothing here
// consults the network, the installed tree, or a registry, because a gate that asks the
// registry what a version means today cannot answer what it meant when the lockfile was
// reviewed.
//
// Two things are deliberately outside that scope. This gate does not install: CI still runs
// `pnpm install --frozen-lockfile`, and the verified-installer boundary that would replace
// it — a pinned Corepack archive hash plus a digest over the whole cached pnpm tree, an
// isolated HOME with empty user and global configs, a terminal `--ignore-pnpmfile` — pins
// two digests that are coupled to the exact pnpm version, so every bump becomes a code
// change in this file. The `+sha512` pin below buys the same download verification from
// Corepack itself for one line. Nor does this gate interpret shell: workflow and package
// commands are matched as text, not parsed into a command grammar with an entrypoint
// allowlist. Both were prototyped on a parked branch and left out; the checks below stand on
// their own, and a static gate is better honest about what it reads than confident about a
// shell string it half-parsed.
import { glob, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
    assertString,
    compareCanonicalText,
    isJsonObject,
    isNonEmptyString,
    jsonKind,
    portable,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";

// Corepack accepts a bare range, so exactness is asserted rather than assumed. The `+sha512.`
// suffix is what makes the download verifiable: on the cold cache every CI runner has,
// Corepack hashes the archive it fetched and refuses a mismatch, and with no suffix it has
// nothing to compare against — the one executable the whole pipeline runs would arrive
// unchecked. It is therefore required rather than merely admitted.
const EXACT_PACKAGE_MANAGER = /^[a-z][a-z0-9-]*@\d+\.\d+\.\d+(?:-[0-9a-z.]+)?(?:\+[0-9a-z.-]+)?$/u;
const VERIFIED_PACKAGE_MANAGER = /\+sha512\.[0-9a-f]{128}$/u;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.]+)?$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

// A registry artifact is named by the hash of its bytes and by nothing else. Every other
// shape of resolution — a git commit, a URL, a directory — is code no integrity hash covers.
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u;
const FOREIGN_SOURCES = ["git+", "git:", "file:", "http:", "https:", "link:", "portal:"];
const TARBALL = /\.(?:tgz|tar\.gz)$/u;

// Settings that hand a dependency the right to execute. `onlyBuiltDependencies` is pnpm 10's
// name and `allowBuilds` pnpm 11's; both are read so a package-manager upgrade cannot carry
// an allowlist in under a name this gate does not know.
const ALLOWLIST_KEYS = ["onlyBuiltDependencies", "allowBuilds"];
const BLANKET_KEYS = ["dangerouslyAllowAllBuilds"];
// The two halves of a fail-closed install: an unruled script must be fatal, and the scripts
// this repository refused must be written down where a review reads them.
const STRICT_BUILDS_KEY = "strictDepBuilds";
const DENIAL_KEY = "ignoredBuiltDependencies";
// Ways to rule on a build somewhere this policy does not look: an allowlist loaded from a
// side file, and a blocklist that silently permits everything it does not name.
const UNRULED_KEYS = ["onlyBuiltDependenciesFile", "neverBuiltDependencies"];
// Code pnpm loads before it has read any dependency policy at all.
const HOOK_KEYS = ["pnpmfile", "globalPnpmfile", "configDependencies"];
// A patch rewrites package bytes after the integrity hash vouched for the original.
const PATCH_KEYS = ["patchedDependencies"];
// With `ignore-scripts` false — which `strictDepBuilds` needs — these run this repository's
// own code on every install, before any gate.
const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const POLICY_KEYS = [
    ...ALLOWLIST_KEYS,
    ...BLANKET_KEYS,
    STRICT_BUILDS_KEY,
    DENIAL_KEY,
    ...UNRULED_KEYS
];

// The committed root `.npmrc` is the entire local install posture, so each value is required
// rather than merely permitted. `ignore-scripts` stays false on purpose: with scripts ignored
// pnpm never inspects a dependency's lifecycle scripts, so `strictDepBuilds` has nothing left
// to fail on. Dependency scripts stay blocked by the empty allowlist, and the workspace's own
// install-time scripts are forbidden below instead.
const REQUIRED_ROOT_NPMRC = [
    ["ignore-scripts", "false"],
    ["ignore-pnpmfile", "true"],
    ["verify-store-integrity", "true"],
    ["lockfile", "true"],
    ["ignore-workspace", "false"],
    ["package-manager-strict", "true"],
    ["package-manager-strict-version", "true"]
];

// `.npmrc` can re-enable what the workspace policy forbids, and it wins where it sits.
const FORBIDDEN_NPMRC = [
    ["enable-pre-post-scripts", "true", "re-enables pre- and post- script pairs"],
    ["unsafe-perm", "true", "runs install scripts with elevated permissions"],
    ["ignore-pnpmfile", "false", "re-enables arbitrary pnpm hook code"],
    ["verify-store-integrity", "false", "accepts store content it never verified"],
    ["lockfile", "false", "installs without reading the reviewed lockfile"],
    ["ignore-workspace", "true", "ignores the reviewed workspace policy"],
    [
        "package-manager-strict-version",
        "false",
        "accepts a package manager other than the pinned one"
    ]
];

const options = parseArguments(process.argv.slice(2));
const issues = [];

const workspacePath = resolve(options.root, "pnpm-workspace.yaml");
const workspace = parseYaml(await read(workspacePath)) ?? {};
const manifests = await workspaceManifests();
const policyDirectories = [...new Set(manifests.map((path) => dirname(path)))];

checkBuildPolicy();
await checkNpmrc();
await checkPnpmfiles();
await checkManifestPolicies();
await checkPackageManagerPin();
await checkLockfile();
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
 * The allowlist has to be empty *and* stated, and an unruled script has to be fatal. An
 * absent declaration is the finding this gate exists for: the repository would then be
 * resting on the current package manager's default, which no review sees change and no diff
 * records. `strictDepBuilds` is the other half of the same finding — without it pnpm names
 * the scripts it skipped and exits 0, so the day a dependency starts shipping one nothing
 * goes red and nobody rules on it.
 */
function checkBuildPolicy() {
    const file = portablePath(workspacePath);
    for (const key of ALLOWLIST_KEYS) {
        for (const declared of settings(workspace, key)) {
            if (jsonKind(declared) !== "array") {
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
    }
    if (!ALLOWLIST_KEYS.some((key) => settings(workspace, key).some(isArray))) {
        issue(
            "build-policy",
            file,
            "onlyBuiltDependencies",
            "no build allowlist is declared, so the policy is the package manager's default rather than this repository's"
        );
    }
    for (const key of BLANKET_KEYS) {
        if (settings(workspace, key).some((declared) => declared === true)) {
            issue("build-policy", file, key, `${key} permits every dependency to execute`);
        }
    }
    const strict = settings(workspace, STRICT_BUILDS_KEY);
    if (strict.length !== 1 || strict[0] !== true) {
        issue(
            "build-policy",
            file,
            STRICT_BUILDS_KEY,
            `${STRICT_BUILDS_KEY}: true is required, or pnpm reports an unruled install script and still exits 0`
        );
    }
    checkDenials(file);
    for (const key of UNRULED_KEYS) {
        if (settings(workspace, key).length === 0) continue;
        issue(
            "build-policy",
            file,
            key,
            `${key} rules on builds outside this policy, so a dependency nobody named can run its install script`
        );
    }
    checkHooks(workspace, file, "the workspace policy");
    checkPatches(workspace, file, "the workspace policy");
}

/**
 * The denial list is the reviewed record that a dependency's install script never runs, and
 * `strictDepBuilds` makes it the only thing standing between a new script and a red install.
 * It is therefore held to the shape a review can read at a glance: one array, package names,
 * each named once, in canonical order.
 */
function checkDenials(file) {
    const declared = settings(workspace, DENIAL_KEY);
    if (declared.length !== 1 || jsonKind(declared[0]) !== "array") {
        issue(
            "build-policy",
            file,
            DENIAL_KEY,
            `${DENIAL_KEY} must declare the dependencies whose install scripts are refused, so an unruled one is the only thing left to fail`
        );
        return;
    }
    const names = declared[0];
    if (!names.every((name) => isNonEmptyString(name))) {
        issue("build-policy", file, DENIAL_KEY, `${DENIAL_KEY} must name packages`);
        return;
    }
    const canonical = [...names].sort(compareCanonicalText);
    if (new Set(names).size !== names.length || names.join("\n") !== canonical.join("\n")) {
        issue(
            "build-policy",
            file,
            DENIAL_KEY,
            `${DENIAL_KEY} must be unique and canonically ordered so one review reads one list`
        );
    }
}

/** A hook file or config dependency is code pnpm loads before any dependency policy applies. */
function checkHooks(value, file, owner) {
    for (const key of HOOK_KEYS) {
        if (settings(value, key).length === 0) continue;
        issue(
            "pnpmfile",
            file,
            key,
            `${owner} declares ${key}, which pnpm loads before it reads a dependency policy`
        );
    }
}

/** A patch rewrites package bytes the lockfile's integrity hash already vouched for. */
function checkPatches(value, file, owner) {
    for (const key of PATCH_KEYS) {
        if (settings(value, key).length === 0) continue;
        issue(
            "lockfile",
            file,
            key,
            `${owner} declares ${key}, which patches package code outside the registry integrity identity`
        );
    }
}

/**
 * The root `.npmrc` is required, not merely inspected. Without one an install inherits
 * whatever `~/.npmrc`, the XDG user config or an `NPM_CONFIG_*` variable says, so the posture
 * the workspace policy states is not the posture the machine runs. A `.npmrc` beside any
 * other manifest wins where it sits, so those are read for the same forbidden settings.
 */
async function checkNpmrc() {
    for (const directory of policyDirectories) {
        const path = resolve(directory, ".npmrc");
        const file = portablePath(path);
        const text = await readOrUndefined(path);
        const root = directory === options.root;
        if (text === undefined) {
            if (root) {
                issue(
                    "npmrc",
                    file,
                    ".npmrc",
                    "no committed root npmrc, so an install inherits whatever the machine's user configuration says"
                );
            }
            continue;
        }
        const entries = npmrcEntries(text);
        if (root) checkRequiredNpmrc(file, entries);
        const stated = root
            ? new Set(REQUIRED_ROOT_NPMRC.map(([key]) => normalizeSetting(key)))
            : new Set();
        for (const entry of entries) checkNpmrcEntry(file, entry, stated);
    }
}

function checkRequiredNpmrc(file, entries) {
    for (const [key, expected] of REQUIRED_ROOT_NPMRC) {
        const declared = entries.filter((entry) => entry.key === normalizeSetting(key));
        if (declared.length === 1 && declared[0].value.toLowerCase() === expected) continue;
        issue("npmrc", file, key, `root npmrc must declare ${key}=${expected}`);
    }
}

function checkNpmrcEntry(file, entry, stated) {
    if (HOOK_KEYS.some((key) => normalizeSetting(key) === entry.key)) {
        issue(
            "pnpmfile",
            file,
            entry.name,
            `npmrc ${entry.name} loads pnpm hook code before any dependency policy applies`
        );
        return;
    }
    if ([...POLICY_KEYS, ...PATCH_KEYS].some((key) => normalizeSetting(key) === entry.key)) {
        issue(
            "npmrc",
            file,
            entry.name,
            `npmrc declares ${entry.name} outside the workspace policy`
        );
        return;
    }
    // A required setting's value is already stated by the root requirement above; repeating it
    // as a forbidden value would report one wrong line twice.
    if (stated.has(entry.key)) return;
    const forbidden = FORBIDDEN_NPMRC.find(([key]) => normalizeSetting(key) === entry.key);
    if (forbidden === undefined || entry.value.toLowerCase() !== forbidden[1]) return;
    issue("npmrc", file, entry.name, `npmrc ${forbidden[2]}`);
}

/** pnpm loads `.pnpmfile.cjs` from a workspace directory with no setting naming it. */
async function checkPnpmfiles() {
    for (const directory of policyDirectories) {
        const path = resolve(directory, ".pnpmfile.cjs");
        if (!(await isFile(path))) continue;
        issue(
            "pnpmfile",
            portablePath(path),
            ".pnpmfile.cjs",
            "a pnpmfile runs arbitrary code before any dependency policy applies"
        );
    }
}

/**
 * pnpm reads the allowlist from a manifest's `pnpm` block too. Two places that can permit a
 * build are two sources of truth, so a manifest naming one is a finding even when the
 * workspace file is clean. A manifest is also where this repository's own install-time
 * scripts would sit, and those do run: `ignore-scripts` is false so that pnpm inspects
 * dependency scripts at all.
 */
async function checkManifestPolicies() {
    for (const path of manifests) {
        const manifest = await readCanonicalJson(path);
        const file = portablePath(path);
        checkHooks(manifest, file, "a manifest");
        checkPatches(manifest, file, "a manifest");
        checkLifecycleScripts(manifest, file);
        const block = setting(manifest, "pnpm");
        if (block === undefined) continue;
        if (!isJsonObject(block)) {
            issue("build-policy", file, "pnpm", "the manifest pnpm block must be a mapping");
            continue;
        }
        for (const key of BLANKET_KEYS) {
            if (!settings(block, key).some((declared) => declared === true)) continue;
            issue(
                "build-policy",
                file,
                `pnpm.${key}`,
                `${key} permits every dependency to execute`
            );
        }
        for (const key of [...ALLOWLIST_KEYS, STRICT_BUILDS_KEY, DENIAL_KEY, ...UNRULED_KEYS]) {
            const declared = settings(block, key);
            if (declared.length === 0) continue;
            // An empty manifest allowlist permits nothing, so it is left alone rather than
            // reported as a policy this repository has to reconcile.
            if (ALLOWLIST_KEYS.includes(key) && declared.every(isEmptyArray)) continue;
            issue(
                "build-policy",
                file,
                `pnpm.${key}`,
                `${key} in a manifest is a second source of truth for the build policy`
            );
        }
        checkHooks(block, file, "a manifest pnpm block");
        checkPatches(block, file, "a manifest pnpm block");
    }
}

/**
 * `ignore-scripts` is false so pnpm inspects dependency scripts and `strictDepBuilds` has
 * something to fail on; the cost is that a lifecycle script in this repository's own
 * manifests would then run on every install, before any gate. There are none, and this keeps
 * it that way.
 */
function checkLifecycleScripts(manifest, file) {
    const scripts = setting(manifest, "scripts");
    if (!isJsonObject(scripts)) return;
    for (const name of LIFECYCLE_SCRIPTS) {
        if (!Object.hasOwn(scripts, name)) continue;
        issue(
            "build-policy",
            file,
            `scripts.${name}`,
            `${name} runs this repository's own code at install time, before any gate has read a byte`
        );
    }
}

/** One exact package manager, named by the bytes of its archive rather than by a version. */
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
        return;
    }
    const declared = assertString(pinned, "packageManager");
    if (!EXACT_PACKAGE_MANAGER.test(declared)) {
        issue(
            "toolchain",
            file,
            "packageManager",
            `${declared} is not an exact version, so two installs can resolve two resolvers`
        );
        return;
    }
    if (VERIFIED_PACKAGE_MANAGER.test(declared)) return;
    issue(
        "toolchain",
        file,
        "packageManager",
        `${declared} carries no +sha512 integrity, so Corepack runs a package manager it never checked against a digest`
    );
}

/**
 * The lockfile is the reviewed identity of every third-party byte, and existing is not the
 * same as saying so. A registry artifact is named by an integrity hash and nothing else, so a
 * resolution that names a git commit, a URL or a directory is code no review pinned. Importer
 * entries are the other half: a dependency added from a repository or a source tree keeps a
 * perfectly valid lockfile entry while pointing outside the registry, and the only
 * source-shaped entries here are the `link:`s between this repository's own packages.
 */
async function checkLockfile() {
    const path = resolve(options.root, "pnpm-lock.yaml");
    const file = portablePath(path);
    const source = await readOrUndefined(path);
    if (source === undefined) {
        issue(
            "toolchain",
            file,
            "pnpm-lock.yaml",
            "no committed lockfile, so no install can be frozen to reviewed versions"
        );
        return;
    }
    const lock = parseYaml(source) ?? {};
    if (!isJsonObject(lock)) {
        issue("lockfile", file, "pnpm-lock.yaml", "the lockfile must be a mapping");
        return;
    }
    const packages = isJsonObject(lock.packages) ? lock.packages : {};
    for (const [id, entry] of Object.entries(packages)) {
        const resolution = isJsonObject(entry) ? entry.resolution : undefined;
        const named = isJsonObject(resolution) ? Object.keys(resolution) : [];
        if (
            named.length === 1 &&
            isNonEmptyString(resolution.integrity) &&
            INTEGRITY.test(resolution.integrity)
        ) {
            continue;
        }
        issue(
            "lockfile",
            file,
            id,
            `${id} does not resolve to a registry artifact named only by an integrity hash`
        );
    }
    checkImporters(file, lock.importers);
    checkPatches(lock, file, "the lockfile");
    checkDenialDrift(packages);
}

function checkImporters(file, importers) {
    if (importers === undefined) return;
    if (!isJsonObject(importers)) {
        issue("lockfile", file, "importers", "the lockfile importers must be a mapping");
        return;
    }
    for (const [importer, value] of Object.entries(importers)) {
        if (!isJsonObject(value)) {
            issue("lockfile", file, importer, "a lockfile importer must be a mapping");
            continue;
        }
        const directory = resolve(options.root, importer);
        for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
            const dependencies = value[field];
            if (dependencies === undefined) continue;
            if (!isJsonObject(dependencies)) {
                issue(
                    "lockfile",
                    file,
                    `${importer}.${field}`,
                    "lockfile importer dependencies must be a mapping"
                );
                continue;
            }
            for (const [name, entry] of Object.entries(dependencies)) {
                checkImporterSource(file, `${importer}.${name}`, directory, entry);
            }
        }
    }
}

function checkImporterSource(file, symbol, directory, entry) {
    if (!isJsonObject(entry)) {
        issue("lockfile", file, symbol, "a lockfile importer dependency must be a mapping");
        return;
    }
    const specifier = isNonEmptyString(entry.specifier) ? entry.specifier : "";
    const version = isNonEmptyString(entry.version) ? entry.version : "";
    if (version.startsWith("link:")) {
        const target = resolve(directory, version.slice("link:".length));
        if (policyDirectories.includes(target)) return;
        issue(
            "lockfile",
            file,
            symbol,
            "a workspace link points outside the packages pnpm enumerates"
        );
        return;
    }
    for (const value of [specifier, version]) {
        if (!FOREIGN_SOURCES.some((prefix) => value.startsWith(prefix)) && !TARBALL.test(value)) {
            continue;
        }
        issue(
            "lockfile",
            file,
            symbol,
            `${value} names a dependency source outside the reviewed registry lock identity`
        );
        return;
    }
}

/**
 * A denial names a dependency whose install script this repository refused. A name the
 * lockfile does not carry rules on nothing today and pre-approves the silence tomorrow: the
 * day a package of that name arrives, `strictDepBuilds` has already been answered for it.
 */
function checkDenialDrift(packages) {
    const locked = Object.keys(packages);
    for (const name of deniedBuilds()) {
        if (locked.some((id) => id.startsWith(`${name}@`))) continue;
        issue(
            "build-policy",
            portablePath(workspacePath),
            DENIAL_KEY,
            `${name} is not a locked dependency, so its denial rules on nothing and answers for a package that has not arrived`
        );
    }
}

function deniedBuilds() {
    const declared = settings(workspace, DENIAL_KEY);
    if (declared.length !== 1 || jsonKind(declared[0]) !== "array") return [];
    return declared[0].filter((name) => isNonEmptyString(name));
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

/**
 * pnpm reads a setting under any spelling that normalizes to the same name, so
 * `only-built-dependencies` and `onlyBuiltDependencies` are one setting. A gate that matched
 * the literal key would read the spelling in the diff and miss the one pnpm obeys.
 */
function settings(value, key) {
    if (!isJsonObject(value)) return [];
    const normalized = normalizeSetting(key);
    return Object.entries(value)
        .filter(([name]) => normalizeSetting(name) === normalized)
        .map(([, declared]) => declared);
}

function setting(value, key) {
    const declared = settings(value, key);
    return declared.length === 1 ? declared[0] : undefined;
}

function npmrcEntries(source) {
    const entries = [];
    for (const line of source.split("\n")) {
        const parsed = /^\s*([A-Za-z0-9_./@-]+)(?:\[\])?\s*=\s*(.*?)\s*$/u.exec(line);
        if (parsed === null) continue;
        entries.push({ name: parsed[1], key: normalizeSetting(parsed[1]), value: parsed[2] });
    }
    return entries;
}

function normalizeSetting(name) {
    return name.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function isArray(value) {
    return jsonKind(value) === "array";
}

function isEmptyArray(value) {
    return isArray(value) && value.length === 0;
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

async function isFile(path) {
    try {
        return (await stat(path)).isFile();
    } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
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
