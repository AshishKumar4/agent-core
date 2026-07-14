import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repositoryRoot, "packages/agent-core");
const cloudflareRoot = resolve(repositoryRoot, "packages/agent-core-cloudflare");

describe("clean package fixture", () => {
    test("builds every core declaration before Cloudflare typechecking without repository dist", async () => {
        const fixtureRoot = await mkdtemp(resolve(tmpdir(), "agent-core-clean-fixture-"));
        const fixtureCore = resolve(fixtureRoot, "packages/agent-core");
        const fixtureCloudflare = resolve(fixtureRoot, "packages/agent-core-cloudflare");
        try {
            await copyPackageFiles(coreRoot, fixtureCore, [
                "package.json",
                "tsconfig.json",
                "tsconfig.build.json",
                "scripts/build.mjs",
                "src"
            ]);
            await copyPackageFiles(cloudflareRoot, fixtureCloudflare, ["tsconfig.json", "src"]);
            await symlink(resolve(coreRoot, "node_modules"), resolve(fixtureCore, "node_modules"));
            await mkdir(resolve(fixtureCloudflare, "node_modules/@agent-core"), {
                recursive: true
            });
            await symlink(fixtureCore, resolve(fixtureCloudflare, "node_modules/@agent-core/core"));

            await expect(access(resolve(fixtureCore, "dist"))).rejects.toMatchObject({
                code: "ENOENT"
            });
            run(process.execPath, [resolve(fixtureCore, "scripts/build.mjs")], fixtureCore);

            const packageJson: {
                readonly exports: Readonly<
                    Record<string, { readonly types: string; readonly import: string }>
                >;
            } = JSON.parse(await readFile(resolve(fixtureCore, "package.json"), "utf8"));
            const buildConfig: { readonly files: readonly string[] } = JSON.parse(
                await readFile(resolve(fixtureCore, "tsconfig.build.json"), "utf8")
            );
            expect([...buildConfig.files].sort()).toEqual(
                Object.values(packageJson.exports)
                    .map((target) =>
                        target.import.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")
                    )
                    .sort()
            );
            for (const target of Object.values(packageJson.exports)) {
                await access(resolve(fixtureCore, target.types));
                await access(resolve(fixtureCore, target.import));
            }

            run(
                process.execPath,
                [resolve(cloudflareRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
                fixtureCloudflare
            );
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    }, 30_000);
});

async function copyPackageFiles(sourceRoot: string, targetRoot: string, paths: readonly string[]) {
    for (const path of paths) {
        const destination = resolve(targetRoot, path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(resolve(sourceRoot, path), destination, { recursive: true });
    }
}

function run(command: string, args: readonly string[], cwd: string): void {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new TypeError(`${result.stdout}${result.stderr}`);
    }
}
