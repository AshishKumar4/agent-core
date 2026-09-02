import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
    runQualitySubprocess,
    subprocessTestOptions,
    type QualitySubprocessResult
} from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/tslean-consumer.mjs");
const temporary: string[] = [];

/*
 * Every catalogued package is verified the same way, so every case here runs against all of
 * them rather than against whichever one was first. `find`/`replace` is a semantic edit to
 * that package's own bytes: the point is not that some byte changed but that a plausible
 * hand-patch of the decision the package ships is refused.
 */
const packages = [
    {
        id: "facets-enforcement",
        module: "src/facets/generated/enforcement/AgentCore/Facets/Enforcement.ts",
        manifest: "src/facets/generated/enforcement/tslean.manifest.json",
        modulePath: "AgentCore/Facets/Enforcement.ts",
        lean: "formal/AgentCore/Facets/Enforcement.lean",
        find: "return turnOwnedSession && sessionFilesystemTarget;",
        replace: "return turnOwnedSession || sessionFilesystemTarget;",
        leanFind: "| .observe => true",
        leanReplace: "| .observe => false"
    },
    {
        id: "facets-placement",
        module: "src/facets/generated/placement/AgentCore/Extract/Placement.ts",
        manifest: "src/facets/generated/placement/tslean.manifest.json",
        modulePath: "AgentCore/Extract/Placement.ts",
        lean: "formal/AgentCore/Extract/Placement.lean",
        find: "return modes.some((argument0: IsolationMode) => isDynamicMode(argument0));",
        replace: "return true;",
        leanFind: "if intersection.dynamic then some .dynamic",
        leanReplace: "if intersection.bundled then some .bundled"
    },
    {
        id: "runs-turn-status",
        module: "src/agents/runs/generated/turn-status/AgentCore/Extract/TurnStatus.ts",
        manifest: "src/agents/runs/generated/turn-status/tslean.manifest.json",
        modulePath: "AgentCore/Extract/TurnStatus.ts",
        lean: "formal/AgentCore/Extract/TurnStatus.lean",
        find: 'public readonly kind = "queued" as const;',
        replace: 'public readonly kind = "running" as const;',
        leanFind: "| .queued => some .running",
        leanReplace: "| .queued => none"
    },
    {
        id: "definition-tree-merge",
        module: "src/definition/generated/tree-merge/AgentCore/Extract/TreeMerge.ts",
        manifest: "src/definition/generated/tree-merge/tslean.manifest.json",
        modulePath: "AgentCore/Extract/TreeMerge.ts",
        lean: "formal/AgentCore/Extract/TreeMerge.lean",
        find: 'public readonly kind = "ours" as const;',
        replace: 'public readonly kind = "theirs" as const;',
        leanFind: "| .perPath => true",
        leanReplace: "| .perPath => false"
    }
] as const;

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

// The gate reads the repository it sits in — including the workspace's own .prettierignore —
// so every case is a scratch copy shaped like the workspace, with exactly one defect
// introduced. The copies share nothing with the worktree: a case that mutated a committed
// artifact in place would leave the gate's own input dirty for whichever test ran after it.
async function scratchTree(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "tslean-consumer-"));
    temporary.push(workspace);
    const root = join(workspace, "packages/agent-core");
    await cp(packageRoot, root, {
        recursive: true,
        filter: (source) =>
            !["node_modules", "reports", ".git", "dist", ".lake"].includes(
                source.split("/").pop() ?? ""
            )
    });
    await cp(resolve(packageRoot, "../../.prettierignore"), join(workspace, ".prettierignore"));
    // The gate reads the committed bytes through the one TypeScript the repository owns, so the
    // copy needs that resolution without paying to duplicate the store.
    await symlink(join(packageRoot, "node_modules"), join(root, "node_modules"), "dir");
    return root;
}

function runGate(root: string): QualitySubprocessResult {
    return runQualitySubprocess(
        process.execPath,
        [join(root, "scripts/quality/tslean-consumer.mjs"), "--stage", "building"],
        root
    );
}

async function edit(root: string, path: string, find: string, replace: string): Promise<void> {
    const source = await readFile(join(root, path), "utf8");
    const edited = source.split(find).join(replace);
    if (edited === source) throw new TypeError(`fixture located nothing in ${path}`);
    await writeFile(join(root, path), edited, "utf8");
}

describe("the TSLean consumer gate", subprocessTestOptions, () => {
    test("accepts every committed generated package offline", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, "--stage", "building"],
            packageRoot
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("tslean consumer verified");
        expect(result.stdout).toContain(`in ${packages.length} package(s)`);
    });

    for (const entry of packages) {
        test(`refuses a tampered generated byte in ${entry.id}`, async () => {
            const root = await scratchTree();
            await edit(root, entry.module, entry.find, entry.replace);

            const result = runGate(root);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("generated TSLean packages are not intact");
            expect(result.stderr).toContain(
                `${entry.id}: generated module body does not hash to its manifest digest: ${entry.modulePath}`
            );
        });

        test(`refuses a committed Lean source ${entry.id} no longer describes`, async () => {
            const root = await scratchTree();
            await edit(root, entry.lean, entry.leanFind, entry.leanReplace);

            const result = runGate(root);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain(`${entry.id}: manifest Lean source digest`);
            expect(result.stderr).toContain("does not match committed");
        });
    }

    test("refuses a manifest that blesses bytes the compiler never produced", async () => {
        const [entry] = packages;
        const root = await scratchTree();
        await edit(root, entry.module, entry.find, entry.replace);
        // Re-bless the tampered bytes into the manifest's own digest field, so the only thing
        // that can refuse them is the provenance header the semantic identity still demands at
        // the top of the file.
        const manifestPath = join(root, entry.manifest);
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const record = manifest.semantic.modules.find(
            (module: { path: string }) => module.path === entry.modulePath
        );
        const tampered = await readFile(join(root, entry.module), "utf8");
        record.bodySha256 = `sha256:${createHash("sha256")
            .update(tampered.slice(tampered.indexOf("*/\n") + "*/\n".length))
            .digest("hex")}`;
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

        const result = runGate(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("provenance header does not match its manifest");
    });

    test("refuses a hand-written module hiding inside a generated tree", async () => {
        const [entry] = packages;
        const root = await scratchTree();
        await writeFile(
            join(root, "src/facets/generated/enforcement/AgentCore/Facets/Extra.ts"),
            "export const smuggled = true;\n",
            "utf8"
        );

        const result = runGate(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            `${entry.id}: the generated tree holds a file its manifest does not name`
        );
    });

    test("refuses a generated package the catalog does not name", async () => {
        const root = await scratchTree();
        const catalogPath = join(root, "artifacts/quality/tslean-packages.json");
        const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
        catalog.packages = catalog.packages.filter(
            (row: { id: string }) => row.id !== "definition-tree-merge"
        );
        await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");

        const result = runGate(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("generated package is not catalogued");
    });

    test("refuses an export surface the catalog no longer describes", async () => {
        const root = await scratchTree();
        const catalogPath = join(root, "artifacts/quality/tslean-packages.json");
        const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
        const row = catalog.packages.find(
            (candidate: { id: string }) => candidate.id === "facets-placement"
        );
        row.surface["AgentCore/Extract/Placement.ts"] = row.surface[
            "AgentCore/Extract/Placement.ts"
        ].filter((name: string) => name !== "preferredPlacement");
        await writeFile(catalogPath, JSON.stringify(catalog, null, 2), "utf8");

        const result = runGate(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("not the catalogued surface");
    });
});
