import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
    type QualitySubprocessResult,
    runQualitySubprocess,
    subprocessTestOptions
} from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/supply-chain.mjs");
const temporary: string[] = [];

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const PIN = `pnpm@10.13.1+sha512.${"0123456789abcdef".repeat(8)}`;
const INTEGRITY =
    "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==";
const CLEAN_WORKFLOW = [
    "name: verify",
    "jobs:",
    "  verify:",
    "    steps:",
    `      - uses: actions/checkout@${SHA}`,
    "      - run: pnpm install --frozen-lockfile"
].join("\n");
// An empty allowlist is half a policy: without the other two keys a gate run reports the
// missing halves instead of the case under test, so every workspace override carries them.
const POLICY = [
    "onlyBuiltDependencies: []",
    "strictDepBuilds: true",
    "ignoredBuiltDependencies: []",
    ""
].join("\n");
const WORKSPACE = [
    "packages:",
    '  - "packages/*"',
    "onlyBuiltDependencies: []",
    "strictDepBuilds: true",
    "ignoredBuiltDependencies:",
    "  - left-pad",
    ""
].join("\n");
const NPMRC = [
    "ignore-scripts=false",
    "ignore-pnpmfile=true",
    "verify-store-integrity=true",
    "lockfile=true",
    "ignore-workspace=false",
    "package-manager-strict=true",
    "package-manager-strict-version=true",
    ""
].join("\n");
const LOCKFILE = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    devDependencies:",
    "      left-pad:",
    "        specifier: 1.3.0",
    "        version: 1.3.0",
    "packages:",
    "  left-pad@1.3.0:",
    `    resolution: {integrity: ${INTEGRITY}}`,
    ""
].join("\n");

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe("supply-chain gate", subprocessTestOptions, () => {
    test("accepts a workspace whose install can run no unreviewed code", async () => {
        const result = run(await createFixture({}));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("supply-chain complete: 0 issue(s)");
    });

    // The finding this gate was built for: inheriting the package manager's default leaves
    // the policy undeclared, so nothing records the day it changes.
    test("rejects an undeclared build allowlist", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml":
                    'packages:\n  - "packages/*"\nstrictDepBuilds: true\nignoredBuiltDependencies: []\n'
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("no build allowlist is declared");
    });

    test("names each dependency permitted to run install scripts", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml":
                    "packages: []\nstrictDepBuilds: true\nignoredBuiltDependencies: []\nonlyBuiltDependencies:\n  - evil\n"
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("evil may run install scripts");
    });

    // pnpm 11 renamed the setting; an upgrade must not carry an allowlist past the gate.
    test("reads the allowlist under its later name too", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml":
                    "packages: []\nstrictDepBuilds: true\nignoredBuiltDependencies: []\nallowBuilds:\n  - evil\n"
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("evil may run install scripts");
    });

    test("rejects a blanket permission to build", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml": `packages: []\n${POLICY}dangerouslyAllowAllBuilds: true\n`
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("permits every dependency to execute");
    });

    // An empty allowlist alone leaves the install green: pnpm names the scripts it skipped
    // and exits 0, so the day a dependency starts shipping one, nothing goes red.
    test("rejects a build policy that leaves an unruled install script warning-only", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml": "packages: []\nonlyBuiltDependencies: []\n"
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("strictDepBuilds: true is required");
    });

    test("rejects a strict policy with no record of the scripts it refused", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml":
                    "packages: []\nonlyBuiltDependencies: []\nstrictDepBuilds: true\n"
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "ignoredBuiltDependencies must declare the dependencies whose install scripts are refused"
        );
    });

    test.each([
        [
            "ignoredBuiltDependencies:\n  - left-pad\n  - left-pad\n",
            "unique and canonically ordered"
        ],
        [
            "ignoredBuiltDependencies:\n  - right-pad\n  - left-pad\n",
            "unique and canonically ordered"
        ],
        ["ignoredBuiltDependencies:\n  - 7\n", "must name packages"],
        ["ignoredBuiltDependencies: left-pad\n", "must declare the dependencies"]
    ])("rejects a denial record no review can read: %s", async (denials, expected) => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml": `packages: []\nonlyBuiltDependencies: []\nstrictDepBuilds: true\n${denials}`
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expected);
    });

    // A denial for a package the lockfile does not carry answers strictDepBuilds in advance,
    // so the day a package of that name arrives its script is refused with no review.
    test("rejects a denial that names no locked dependency", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml": WORKSPACE.replace("left-pad", "ghost-pad")
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ghost-pad is not a locked dependency");
    });

    // Both settings rule on builds somewhere this policy does not read: one loads the
    // allowlist from a side file, the other permits every dependency it does not name.
    test.each([
        "onlyBuiltDependenciesFile: builds.txt\n",
        "neverBuiltDependencies:\n  - left-pad\n"
    ])("rejects a rule that leaves a dependency's install script unruled: %s", async (setting) => {
        const result = run(
            await createFixture({ "pnpm-workspace.yaml": `packages: []\n${POLICY}${setting}` })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("rules on builds outside this policy");
    });

    // `ignore-scripts=false` is required so pnpm inspects dependency scripts at all, which
    // leaves this repository's own install-time scripts as the one thing that would run.
    test.each(["preinstall", "install", "postinstall", "prepare"])(
        "rejects a workspace lifecycle script: %s",
        async (name) => {
            const result = run(
                await createFixture({
                    "package.json": `${JSON.stringify(
                        {
                            name: "fixture",
                            private: true,
                            packageManager: PIN,
                            scripts: { [name]: "echo unreviewed" }
                        },
                        null,
                        2
                    )}\n`
                })
            );
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("runs this repository's own code at install time");
        }
    );

    test.each([
        "pnpmfile: ./hook.cjs\n",
        "globalPnpmfile: ./hook.cjs\n",
        "configDependencies:\n  evil: 1.0.0\n"
    ])("rejects workspace hook code pnpm loads before any policy: %s", async (setting) => {
        const result = run(
            await createFixture({ "pnpm-workspace.yaml": `packages: []\n${POLICY}${setting}` })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("before it reads a dependency policy");
    });

    // pnpm loads this file with no setting naming it, so its presence is the whole finding.
    test("rejects a committed pnpmfile", async () => {
        const result = run(
            await createFixture({ ".pnpmfile.cjs": "module.exports = { hooks: {} };\n" })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("a pnpmfile runs arbitrary code");
    });

    test("rejects a pnpmfile beside a workspace package", async () => {
        const fixture = await createFixture({});
        await mkdir(resolve(fixture, "packages/one"), { recursive: true });
        await writeFile(
            resolve(fixture, "packages/one/package.json"),
            `${JSON.stringify({ name: "one" }, null, 2)}\n`,
            "utf8"
        );
        await writeFile(
            resolve(fixture, "packages/one/.pnpmfile.cjs"),
            "module.exports = { hooks: {} };\n",
            "utf8"
        );
        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("a pnpmfile runs arbitrary code");
    });

    // A patch rewrites bytes the lockfile's integrity hash already vouched for, so the
    // reviewed identity of the package and the code that installs stop being the same thing.
    test.each([
        [
            "pnpm-workspace.yaml",
            `packages: []\n${POLICY}patchedDependencies:\n  left-pad@1.3.0: patches/left-pad.patch\n`
        ],
        [
            "pnpm-lock.yaml",
            `${LOCKFILE}patchedDependencies:\n  left-pad@1.3.0: patches/left-pad.patch\n`
        ]
    ])("rejects a patched dependency declared in %s", async (path, source) => {
        const result = run(await createFixture({ [path]: source }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "patches package code outside the registry integrity identity"
        );
    });

    // A manifest block and the workspace file are two places that can permit a build; the
    // gate refuses the second source of truth rather than reconciling them.
    test.each([
        [{ onlyBuiltDependencies: ["evil"] }, "second source of truth"],
        [{ strictDepBuilds: false }, "second source of truth"],
        [{ ignoredBuiltDependencies: ["left-pad"] }, "second source of truth"],
        [{ dangerouslyAllowAllBuilds: true }, "permits every dependency to execute"],
        [{ configDependencies: { evil: "1.0.0" } }, "before it reads a dependency policy"],
        [
            { patchedDependencies: { "left-pad@1.3.0": "patches/left-pad.patch" } },
            "patches package code outside the registry integrity identity"
        ]
    ])("rejects a manifest pnpm block that carries install policy", async (pnpm, expected) => {
        const fixture = await createFixture({});
        await mkdir(resolve(fixture, "packages/one"), { recursive: true });
        await writeFile(
            resolve(fixture, "packages/one/package.json"),
            `${JSON.stringify({ name: "one", pnpm }, null, 2)}\n`,
            "utf8"
        );
        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expected);
    });

    // The lockfile is the reviewed identity of every third-party byte: a registry artifact is
    // named by an integrity hash and by nothing else.
    test.each([
        [
            "  evil@1.0.0:\n    resolution: {tarball: https://example.test/evil.tgz}\n",
            "evil@1.0.0 does not resolve to a registry artifact"
        ],
        [
            "  evil@git+ssh://git.example/evil#deadbeef:\n    resolution: {commit: deadbeef, repo: ssh://git.example/evil, type: git}\n",
            "does not resolve to a registry artifact"
        ],
        [
            `  evil@1.0.0:\n    resolution: {integrity: ${INTEGRITY}, tarball: https://example.test/evil.tgz}\n`,
            "evil@1.0.0 does not resolve to a registry artifact"
        ],
        [
            "  evil@1.0.0:\n    resolution: {integrity: not-a-hash}\n",
            "evil@1.0.0 does not resolve to a registry artifact"
        ]
    ])("rejects a lockfile resolution that is not integrity-named", async (entry, expected) => {
        const result = run(await createFixture({ "pnpm-lock.yaml": `${LOCKFILE}${entry}` }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expected);
    });

    // The importer half: a git, file or URL source keeps a valid lockfile entry while
    // pointing at bytes no integrity hash covers.
    test.each([
        ["specifier: git+ssh://git.example/evil#deadbeef", "git+ssh://git.example/evil#deadbeef"],
        ["specifier: https://example.test/evil.tgz", "https://example.test/evil.tgz"],
        ["specifier: file:../evil", "file:../evil"],
        ["specifier: ../evil.tgz", "../evil.tgz"]
    ])("rejects an importer dependency from outside the registry: %s", async (line, expected) => {
        const result = run(
            await createFixture({
                "pnpm-lock.yaml": `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      evil:\n        ${line}\n        version: 1.0.0\npackages: {}\n`
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expected);
        expect(result.stderr).toContain("outside the reviewed registry lock identity");
    });

    test("rejects a workspace link that leaves the enumerated packages", async () => {
        const result = run(
            await createFixture({
                "pnpm-lock.yaml":
                    "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      evil:\n        specifier: workspace:*\n        version: link:../evil\npackages: {}\n"
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("points outside the packages pnpm enumerates");
    });

    // The links this repository does have: one enumerated package depending on another.
    test("accepts a workspace link between two enumerated packages", async () => {
        const fixture = await createFixture({
            "pnpm-workspace.yaml": `packages:\n  - "packages/*"\n${POLICY}`,
            "pnpm-lock.yaml":
                "lockfileVersion: '9.0'\nimporters:\n  packages/two:\n    dependencies:\n      one:\n        specifier: workspace:*\n        version: link:../one\npackages: {}\n"
        });
        for (const name of ["one", "two"]) {
            await mkdir(resolve(fixture, `packages/${name}`), { recursive: true });
            await writeFile(
                resolve(fixture, `packages/${name}/package.json`),
                `${JSON.stringify({ name }, null, 2)}\n`,
                "utf8"
            );
        }
        const result = run(fixture);
        expect(result.status, result.stderr).toBe(0);
    });

    test("rejects a package manager that is not an exact version", async () => {
        const result = run(await createFixture({ "package.json": manifest("pnpm@^10.13.1") }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("is not an exact version");
    });

    // Corepack only verifies what it downloaded when the pin names the archive's bytes.
    test.each(["pnpm@10.13.1", "pnpm@10.13.1+sha512.abc", "pnpm@10.13.1+sha1.deadbeef"])(
        "rejects a package manager pinned without an integrity hash: %s",
        async (pinned) => {
            const result = run(await createFixture({ "package.json": manifest(pinned) }));
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("carries no +sha512 integrity");
        }
    );

    test("rejects a workspace with no committed lockfile", async () => {
        const fixture = await createFixture({});
        await rm(resolve(fixture, "pnpm-lock.yaml"));
        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("no committed lockfile");
    });

    // Without a committed npmrc the install obeys whatever the machine says, so the file is
    // required and every value in it is stated rather than merely permitted.
    test("rejects a workspace with no committed npmrc", async () => {
        const fixture = await createFixture({});
        await rm(resolve(fixture, ".npmrc"));
        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("no committed root npmrc");
    });

    test.each([
        [
            NPMRC.replace("ignore-scripts=false", "ignore-scripts=true"),
            "must declare ignore-scripts=false"
        ],
        [NPMRC.replace("ignore-pnpmfile=true\n", ""), "must declare ignore-pnpmfile=true"],
        [
            NPMRC.replace("verify-store-integrity=true", "verify-store-integrity=false"),
            "must declare verify-store-integrity=true"
        ],
        [NPMRC.replace("lockfile=true", "lockfile=false"), "must declare lockfile=true"],
        [`${NPMRC}lockfile=true\n`, "must declare lockfile=true"],
        [
            NPMRC.replace("package-manager-strict-version=true\n", ""),
            "must declare package-manager-strict-version=true"
        ]
    ])("rejects a root npmrc that alters the reviewed install posture", async (npmrc, expected) => {
        const result = run(await createFixture({ ".npmrc": npmrc }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(expected);
    });

    test.each([
        ["enable-pre-post-scripts=true\n", "re-enables pre- and post- script pairs"],
        ["unsafe-perm=true\n", "runs install scripts with elevated permissions"],
        ["pnpmfile=./hook.cjs\n", "loads pnpm hook code"],
        ["config-dependencies[]=evil@1.0.0\n", "loads pnpm hook code"],
        ["only-built-dependencies-file=builds.txt\n", "outside the workspace policy"],
        ["patched-dependencies[]=left-pad@1.3.0\n", "outside the workspace policy"],
        ["strict-dep-builds=false\n", "outside the workspace policy"]
    ])(
        "rejects an npmrc setting that reopens what the policy closed: %s",
        async (line, expected) => {
            const result = run(await createFixture({ ".npmrc": `${NPMRC}${line}` }));
            expect(result.status).toBe(1);
            expect(result.stderr).toContain(expected);
        }
    );

    test("rejects an npmrc carrying its own allowlist", async () => {
        const result = run(
            await createFixture({ ".npmrc": `${NPMRC}onlyBuiltDependencies=evil\n` })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("outside the workspace policy");
    });

    // A package `.npmrc` wins wherever pnpm runs from that directory, so it is read too.
    test("rejects a package npmrc that re-enables pnpm hooks", async () => {
        const fixture = await createFixture({});
        await mkdir(resolve(fixture, "packages/one"), { recursive: true });
        await writeFile(
            resolve(fixture, "packages/one/package.json"),
            `${JSON.stringify({ name: "one" }, null, 2)}\n`,
            "utf8"
        );
        await writeFile(resolve(fixture, "packages/one/.npmrc"), "ignore-pnpmfile=false\n", "utf8");
        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("re-enables arbitrary pnpm hook code");
    });

    // A tag is a mutable pointer: the action reviewed at `@v4` is not what runs at `@v4` later.
    test("rejects an action pinned to a tag rather than a commit", async () => {
        const result = run(
            await createFixture({
                ".github/workflows/verify.yml": CLEAN_WORKFLOW.replace(`@${SHA}`, "@v4")
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("mutable reference rather than a commit sha");
    });

    test("rejects an install that is not frozen to the lockfile", async () => {
        const result = run(
            await createFixture({
                ".github/workflows/verify.yml": CLEAN_WORKFLOW.replace(" --frozen-lockfile", "")
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("without --frozen-lockfile");
    });

    test("rejects a downloaded release artifact with no digest check", async () => {
        const result = run(
            await createFixture({
                ".github/workflows/verify.yml": `${CLEAN_WORKFLOW}\n      - run: curl -fL https://example.test/tool.tar.gz -o tool.tar.gz\n`
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("without checking it against a digest");
    });

    test("accepts a download the workflow verifies against a digest", async () => {
        const result = run(
            await createFixture({
                ".github/workflows/verify.yml": `${CLEAN_WORKFLOW}\n      - run: |\n          curl -fL https://example.test/tool.tar.gz -o tool.tar.gz\n          echo 'abc  tool.tar.gz' | sha256sum -c -\n`
            })
        );
        expect(result.status, result.stderr).toBe(0);
    });

    test("rejects a runtime pinned to a range", async () => {
        const result = run(await createFixture({ ".node-version": "22\n" }));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("is not an exact version");
    });

    test("rejects a missing runtime pin", async () => {
        const fixture = await createFixture({});
        await rm(resolve(fixture, ".bun-version"));
        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(".bun-version is absent");
    });

    // A pattern the gate cannot enumerate would silently leave every package unchecked, so
    // it fails instead of reporting a clean empty universe.
    test("refuses a workspace pattern it cannot enumerate", async () => {
        const result = run(
            await createFixture({
                "pnpm-workspace.yaml": `packages:\n  - "packages/**/nested"\n${POLICY}`
            })
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Unsupported workspace pattern");
    });
});

function manifest(packageManager: string): string {
    return `${JSON.stringify({ name: "fixture", private: true, packageManager }, null, 2)}\n`;
}

async function createFixture(overrides: Record<string, string>): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-supply-chain-"));
    temporary.push(root);
    const files = {
        "pnpm-workspace.yaml": WORKSPACE,
        "package.json": manifest(PIN),
        ".npmrc": NPMRC,
        "pnpm-lock.yaml": LOCKFILE,
        ".node-version": "22.22.3\n",
        ".bun-version": "1.3.12\n",
        ".github/workflows/verify.yml": CLEAN_WORKFLOW,
        ...overrides
    };
    for (const [path, source] of Object.entries(files)) {
        const target = resolve(root, path);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, source, "utf8");
    }
    return root;
}

function run(root: string): QualitySubprocessResult {
    return runQualitySubprocess(
        process.execPath,
        [checker, "--stage", "final", "--root", root],
        packageRoot
    );
}
