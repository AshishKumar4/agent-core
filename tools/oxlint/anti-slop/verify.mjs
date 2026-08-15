import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(toolRoot, "../../..");

export function validateAntiSlopPolicy(config, provenance, pluginRuleIds, testRuleIds) {
    const expectedProvenanceKeys = [
        "edition",
        "upstreamRepository",
        "upstreamCommit",
        "localImportCommit",
        "localImportRoot",
        "importedFilesSha256",
        "importedFiles",
        "maintenance",
        "config",
        "severity"
    ];
    if (JSON.stringify(Object.keys(provenance)) !== JSON.stringify(expectedProvenanceKeys)) {
        throw new TypeError("Anti-slop provenance has missing or unknown fields");
    }
    if (
        provenance.edition !== "1.0.0" ||
        provenance.upstreamRepository !== "https://github.com/dmmulroy/anti-slop" ||
        !fullCommit(provenance.upstreamCommit) ||
        !fullCommit(provenance.localImportCommit) ||
        provenance.localImportRoot !== "tools/oxlint/anti-slop" ||
        !/^sha256:[a-f0-9]{64}$/u.test(provenance.importedFilesSha256) ||
        provenance.maintenance !== "vendored-project-owned" ||
        provenance.config !== ".oxlintrc.json" ||
        provenance.severity !== "error"
    ) {
        throw new TypeError("Anti-slop provenance policy is invalid");
    }
    if (
        !Array.isArray(provenance.importedFiles) ||
        provenance.importedFiles.length === 0 ||
        !provenance.importedFiles.every(validRelativePath) ||
        new Set(provenance.importedFiles).size !== provenance.importedFiles.length
    ) {
        throw new TypeError("Anti-slop provenance has invalid imported files");
    }
    if (config.jsPlugins?.length !== 1) {
        throw new TypeError("Oxlint must load exactly the reviewed anti-slop plugin");
    }
    const plugin = config.jsPlugins[0];
    if (plugin?.name !== "anti-slop" || plugin.specifier !== "./tools/oxlint/anti-slop/index.ts") {
        throw new TypeError("Oxlint anti-slop plugin registration is invalid");
    }
    if (!sameSortedUnique(pluginRuleIds, testRuleIds)) {
        throw new TypeError("Every anti-slop rule must have one discovered RuleTester file");
    }
    const configuredRuleIds = Object.entries(config.rules ?? {})
        .filter(([id]) => id.startsWith("anti-slop/"))
        .map(([id, severity]) => {
            if (severity !== provenance.severity) {
                throw new TypeError(`Anti-slop rule ${id} is not enforced at error`);
            }
            return id.slice("anti-slop/".length);
        });
    if (!sameSortedUnique(pluginRuleIds, configuredRuleIds)) {
        throw new TypeError("Oxlint config does not enable the exact anti-slop rule set");
    }
}

function fullCommit(value) {
    return isString(value) && /^[a-f0-9]{40}$/u.test(value);
}

function validRelativePath(value) {
    return (
        isString(value) &&
        value.length > 0 &&
        !value.startsWith("/") &&
        !value.includes("..") &&
        !value.includes("\\")
    );
}

function isString(value) {
    return (
        value !== null && value !== undefined && Object.getPrototypeOf(value) === String.prototype
    );
}

function sameSortedUnique(left, right) {
    if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

async function main() {
    const provenance = JSON.parse(await readFile(resolve(toolRoot, "provenance.json"), "utf8"));
    const config = JSON.parse(
        await readFile(resolve(repositoryRoot, provenance.config ?? ".oxlintrc.json"), "utf8")
    );
    const plugin = (await import(pathToFileURL(resolve(toolRoot, "index.ts")).href)).default;
    const pluginRuleIds = Object.keys(plugin.rules ?? {});
    const testFiles = (await readdir(resolve(toolRoot, "rules"), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
        .map((entry) => entry.name)
        .sort();
    const testRuleIds = testFiles.map((name) => name.slice(0, -".test.ts".length));
    validateAntiSlopPolicy(config, provenance, pluginRuleIds, testRuleIds);
    validateImportedSource(provenance);
    for (const test of testFiles) {
        run(process.execPath, [resolve(toolRoot, "rules", test)]);
    }
    run(process.execPath, [
        resolve(repositoryRoot, "packages/agent-core/node_modules/typescript/bin/tsc"),
        "--noEmit",
        "-p",
        resolve(toolRoot, "tsconfig.json")
    ]);
    run(resolve(repositoryRoot, "node_modules/oxlint/bin/oxlint"), [
        "--deny-warnings",
        "tools/oxlint"
    ]);
    console.log(`Anti-slop integrity verified: ${pluginRuleIds.length} rules`);
}

function validateImportedSource(provenance) {
    run("git", ["merge-base", "--is-ancestor", provenance.localImportCommit, "HEAD"], false, false);
    const prefix = `${provenance.localImportRoot}/`;
    const files = gitText([
        "ls-tree",
        "-r",
        "--name-only",
        provenance.localImportCommit,
        "--",
        provenance.localImportRoot
    ])
        .split("\n")
        .filter(Boolean)
        .map((path) => {
            if (!path.startsWith(prefix)) {
                throw new TypeError("Anti-slop import contains a path outside its source root");
            }
            return path.slice(prefix.length);
        });
    if (!sameSortedUnique(files, provenance.importedFiles)) {
        throw new TypeError("Anti-slop imported file inventory differs from provenance");
    }
    const hash = createHash("sha256");
    for (const path of [...files].sort()) {
        hash.update(path);
        hash.update(Buffer.from([0]));
        hash.update(gitBytes(["show", `${provenance.localImportCommit}:${prefix}${path}`]));
        hash.update(Buffer.from([0]));
    }
    if (`sha256:${hash.digest("hex")}` !== provenance.importedFilesSha256) {
        throw new TypeError("Anti-slop imported source digest differs from provenance");
    }
}

function gitText(args) {
    return run("git", args, "utf8", false).stdout.trim();
}

function gitBytes(args) {
    return run("git", args, null, false).stdout;
}

function run(command, args, encoding = "utf8", emit = true) {
    const inherited = encoding === false;
    const result = spawnSync(command, args, {
        cwd: repositoryRoot,
        ...(inherited ? { stdio: "inherit" } : { encoding, stdio: ["ignore", "pipe", "pipe"] }),
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
        const stderr = inherited ? "" : result.stderr.toString();
        const stdout = inherited ? "" : result.stdout.toString();
        throw new TypeError(`${command} ${args.join(" ")} failed\n${stdout}${stderr}`);
    }
    if (emit && !inherited && result.stdout.length > 0) process.stdout.write(result.stdout);
    if (emit && !inherited && result.stderr.length > 0) process.stderr.write(result.stderr);
    return result;
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) await main();
