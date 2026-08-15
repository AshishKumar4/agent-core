import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/architecture.mjs");
const temporary: string[] = [];
// Split so this file's own fixtures are not counted as the pragmas they describe.
const SUPPRESSION = `@ts-${"ignore"}`;
const EXPECTED_ERROR = `@ts-${"expect-error"}`;

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

    test("rejects unpermitted weak types and stale permits", async () => {
        const fixture = await createFixture({
            "src/id.ts": "export class NoteId {}\n",
            "src/weak.ts": [
                "export function widen(value: any): string {",
                "  return (value as { name: string }).name!;",
                "}",
                "export function counted(value: unknown): string {",
                "  return String(value);",
                "}"
            ].join("\n"),
            "src/permitted.ts": [
                "export function decode(value: unknown): string {",
                "  return String(value);",
                "}"
            ].join("\n"),
            "test/weak.test.ts": [
                `// ${SUPPRESSION} an unchecked suppression proves nothing`,
                "export const suppressed: string = 1;"
            ].join("\n")
        });
        await writePermits(fixture, [
            {
                file: "src/permitted.ts",
                kind: "unknown",
                anchors: [{ symbol: "decode.value", source: "value: unknown", count: 4 }],
                reason: "A stale permit must fail as loudly as a new escape does."
            }
        ]);

        const result = run(fixture);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ACQ-TYPE");
        expect(result.stderr).toContain("src/weak.ts uses an unpermitted any escape");
        expect(result.stderr).toContain("src/weak.ts uses an unpermitted assertion escape");
        expect(result.stderr).toContain("src/weak.ts uses an unpermitted non-null escape");
        expect(result.stderr).toContain("src/weak.ts uses an unpermitted unknown escape");
        expect(result.stderr).toContain("test/weak.test.ts uses an unpermitted suppression");
        expect(result.stderr).toContain("permit for decode.value is stale");
    });

    test("admits a validator that narrows and a permitted escape", async () => {
        const fixture = await createFixture({
            "src/id.ts": "export class NoteId {}\n",
            "src/narrowing.ts": [
                "export function isText(value: unknown): value is string {",
                "  return typeof value === 'string';",
                "}",
                "export const shape = { kind: 'note' } as const;"
            ].join("\n"),
            "src/permitted.ts": [
                "export function widen(value: unknown): string {",
                "  return String(value);",
                "}"
            ].join("\n"),
            "test/narrowing.test.ts": [
                `// ${EXPECTED_ERROR} a negative type assertion is not a suppression`,
                "export const rejected: string = 1;"
            ].join("\n")
        });
        await writePermits(fixture, [
            {
                file: "src/permitted.ts",
                kind: "unknown",
                anchors: [{ symbol: "widen.value", source: "value: unknown", count: 1 }],
                reason: "The subject of a widening helper stays open until a caller narrows it."
            }
        ]);

        expect(run(fixture).status).toBe(0);
    });

    test("binds a weak-type permit to the exact escape it reviews", async () => {
        const fixture = await createFixture({
            "src/id.ts": "export class NoteId {}\n",
            "src/permitted.ts": [
                "export function decode(value: unknown): string {",
                "  return String(value);",
                "}"
            ].join("\n")
        });
        const permits = [
            {
                file: "src/permitted.ts",
                kind: "unknown",
                anchors: [{ symbol: "decode.value", source: "value: unknown", count: 1 }],
                reason: "The decoder narrows one exact external value at its trust boundary."
            }
        ];
        await writePermits(fixture, permits);
        expect(run(fixture).status).toBe(0);

        await writeFile(
            resolve(fixture, "permits.json"),
            `${JSON.stringify({
                edition: "1.0.0",
                permits: [
                    {
                        file: "src/permitted.ts",
                        kind: "unknown",
                        count: 1,
                        reason: "A count alone cannot identify the escape that was reviewed."
                    }
                ]
            })}\n`,
            "utf8"
        );
        expect(run(fixture).stderr).toContain("must use edition 2.0.0");
        await writePermits(fixture, permits);

        await writeFile(
            resolve(fixture, "src/permitted.ts"),
            [
                "export function decode(value: unknown | never): string {",
                "  return String(value);",
                "}"
            ].join("\n"),
            "utf8"
        );
        expect(run(fixture).status).toBe(1);

        await writeFile(
            resolve(fixture, "src/permitted.ts"),
            [
                "export function unrelated(value: unknown): string {",
                "  return String(value);",
                "}"
            ].join("\n"),
            "utf8"
        );
        expect(run(fixture).status).toBe(1);
    });
});

async function writePermits(
    root: string,
    permits: readonly {
        file: string;
        kind: string;
        anchors: readonly { symbol: string; source: string; count: number }[];
        reason: string;
    }[]
): Promise<void> {
    await writeFile(
        resolve(root, "permits.json"),
        `${JSON.stringify({ edition: "2.0.0", permits }, null, 2)}\n`,
        "utf8"
    );
}

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
    await writePermits(root, []);
    return root;
}

function run(root: string): ReturnType<typeof runQualitySubprocess> {
    return runQualitySubprocess(
        process.execPath,
        [
            checker,
            "--stage",
            "final",
            "--root",
            root,
            "--baseline",
            resolve(root, "baseline.json"),
            "--permits",
            resolve(root, "permits.json")
        ],
        packageRoot
    );
}
