// @ts-nocheck
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/architecture.mjs");
const temporary: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe("generic AGENTS architecture rules", subprocessTestOptions, () => {
    test("accepts a clean fixture", async () => {
        const fixture = await createFixture({
            "src/id.ts": "export class NoteId {}\n",
            "test/note.test.ts": "export const tested = true;\n"
        });
        expect(run(fixture).status).toBe(0);
    });

    test("rejects error, ID, codec, immutability, test, and coverage violations", async () => {
        const fixture = await createFixture({
            "src/wrong.ts": [
                "// c8 ignore next",
                "export class RogueId {}",
                "export type First = 'allow' | 'deny';",
                "export type Second = 'allow' | 'deny';",
                "const Boom = Error;",
                "export function execute() { throw new TypeError('operational'); }",
                "export function explode() { throw new Boom('aliased'); }",
                "export function callError() { throw Error('called'); }",
                "export class BadRecord {",
                "  public static readonly codec = {};",
                "  public constructor() { throw new Error('bad'); }",
                "}",
                "export class MethodRecord {",
                "  public static encode() {}",
                "  public static decode() {}",
                "}"
            ].join("\n"),
            "test/bad.test.ts": "test['skip']('hidden', () => {});\n"
        });
        const result = run(fixture);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ACQ-COVERAGE");
        expect(result.stderr).toContain("ACQ-ERR");
        expect(result.stderr).toContain("ACQ-ID");
        expect(result.stderr).toContain("ACQ-CODEC");
        expect(result.stderr).toContain("ACQ-IMMUTABLE");
        expect(result.stderr).toContain("ACQ-VOCAB");
        expect(result.stderr).toContain("ACQ-TEST");
    });
});

async function createFixture(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-architecture-"));
    temporary.push(root);
    for (const [path, source] of Object.entries(files)) {
        const target = resolve(root, path);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, source, "utf8");
    }
    await writeFile(
        resolve(root, "baseline.json"),
        '{\n  "edition": "1.0.0",\n  "issues": []\n}\n',
        "utf8"
    );
    return root;
}

function run(root: string): ReturnType<typeof runQualitySubprocess> {
    return runQualitySubprocess(
        process.execPath,
        [checker, "--stage", "final", "--root", root, "--baseline", resolve(root, "baseline.json")],
        packageRoot
    );
}
