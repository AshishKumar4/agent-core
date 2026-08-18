import { compareCanonicalText } from "../../src/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
    type QualitySubprocessResult,
    runQualitySubprocess,
    subprocessTestOptions
} from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/architecture.mjs");
const temporary: string[] = [];
// Split so this file's own fixtures are not counted as the pragmas they describe.
const SUPPRESSION = `@ts-${"ignore"}`;
const EXPECTED_ERROR = `@ts-${"expect-error"}`;
const spec = await readFile(resolve(packageRoot, "SPEC.md"), "utf8");

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
        const result = run(fixture);
        expect(result.status, result.stderr).toBe(0);
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

    test("does not admit public vocabulary found only in fenced SPEC examples", async () => {
        const fixture = await createFixture({});
        await writeExports(fixture, ["CompatRange", "InterceptContext", "InterceptResult"]);

        const result = run(fixture);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            'introduces vocabulary the SPEC does not contain: "compat"'
        );
        expect(result.stderr).toContain(
            'introduces vocabulary the SPEC does not contain: "intercept"'
        );
    });

    test("rejects case and plural forms of foreign SPEC aliases without stemming prefixes", async () => {
        const fixture = await createFixture({});
        await writeProjectExports(fixture, [
            "TOOLS",
            "Extensions",
            "Hooks",
            "Conversations",
            "Plugins",
            "Toolsets",
            "Webhooks",
            "Toolbox",
            "Hooked"
        ]);

        const result = run(fixture);

        expect(result.status).toBe(1);
        for (const [symbol, word] of [
            ["TOOLS", "tool"],
            ["Extensions", "extension"],
            ["Hooks", "hook"],
            ["Conversations", "conversation"],
            ["Plugins", "plugin"],
            ["Toolsets", "toolset"],
            ["Webhooks", "webhook"]
        ]) {
            expect(result.stderr).toContain(`${symbol} uses the foreign term "${word}"`);
        }
        expect(result.stderr).not.toContain('Toolbox uses the foreign term "tool"');
        expect(result.stderr).not.toContain('Hooked uses the foreign term "hook"');
    });

    test("checks vocabulary for public type declarations regardless of identifier prefix", async () => {
        const fixture = await createFixture({
            "src/public-types.ts": [
                "export class plugin {}",
                "export interface _Plugin {}",
                "export type $Plugin = string;"
            ].join("\n")
        });
        await writeDeclarationExports(fixture, [
            { name: "plugin", kind: "class" },
            { name: "_Plugin", kind: "interface" },
            { name: "$Plugin", kind: "type" }
        ]);
        await writeForeignVocabulary(fixture, "plugin");

        const result = run(fixture);

        expect(result.status).toBe(1);
        for (const symbol of ["plugin", "_Plugin", "$Plugin"]) {
            expect(result.stderr).toContain(`${symbol} uses the foreign term "plugin"`);
        }
    });

    test("uses declaration kind rather than capitalization to exclude functions", async () => {
        const fixture = await createFixture({
            "src/public-functions.ts": [
                "export function Plugin() {}",
                "export function plugin() {}"
            ].join("\n"),
            "test/public-functions.test.ts": "export const tested = true;\n"
        });
        await writeDeclarationExports(fixture, [
            { name: "Plugin", kind: "function" },
            { name: "plugin", kind: "function" }
        ]);
        await writeForeignVocabulary(fixture, "plugin");

        const result = run(fixture);
        expect(result.status, result.stderr).toBe(0);
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

    test("derives each codec's complete project class tuple from its behavior", async () => {
        const fixture = await createFixture({
            "src/codec.ts": codecFixture("BoundRecord")
        });

        const missing = run(fixture);
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain("Codec tuple omits reached project class Dependency");

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            codecFixture("Dependency, BoundRecord"),
            "utf8"
        );
        const wrongPrimary = run(fixture);
        expect(wrongPrimary.status).toBe(1);
        expect(wrongPrimary.stderr).toContain(
            "RecordCodec tuple must name its exact concrete record class first"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            codecFixture("BoundRecord, Dependency"),
            "utf8"
        );
        expect(run(fixture).status).toBe(0);

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            codecFixture("BoundRecord, Dependency, Object"),
            "utf8"
        );
        const builtin = run(fixture);
        expect(builtin.status).toBe(1);
        expect(builtin.stderr).toContain(
            "Codec tuples may contain only explicit project-owned classes"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            genericCodecFixture("BoundRecord"),
            "utf8"
        );
        const genericMissing = run(fixture);
        expect(genericMissing.status).toBe(1);
        expect(genericMissing.stderr).toContain(
            "Codec tuple omits reached project class Dependency"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            genericCodecFixture("BoundRecord, Dependency"),
            "utf8"
        );
        const completeGeneric = run(fixture);
        expect(completeGeneric.status, completeGeneric.stderr).toBe(0);

        await writeFile(resolve(fixture, "src/codec.ts"), staticCodecFixture(), "utf8");
        const staticInitialization = run(fixture);
        expect(staticInitialization.status).toBe(1);
        expect(staticInitialization.stderr).toContain(
            "Codec construction is forbidden inside static field initialization"
        );

        await writeFile(resolve(fixture, "src/codec.ts"), earlyCodecFixture(), "utf8");
        const earlyConstruction = run(fixture);
        expect(earlyConstruction.status).toBe(1);
        expect(earlyConstruction.stderr).toContain(
            "Codec construction must follow complete initialization of Dependency"
        );
    });

    test("derives constructed subclasses and their instance and static initializers", async () => {
        const fixture = await createFixture({
            "src/codec.ts": subclassInitializerCodecFixture("BoundRecord")
        });

        const missingBoth = run(fixture);
        expect(missingBoth.status).toBe(1);
        expect(missingBoth.stderr).toContain("Codec tuple omits reached project class ExactRecord");
        expect(missingBoth.stderr).toContain("Codec tuple omits reached project class Dependency");

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            subclassInitializerCodecFixture("BoundRecord, ExactRecord"),
            "utf8"
        );
        const missingInitializer = run(fixture);
        expect(missingInitializer.status).toBe(1);
        expect(missingInitializer.stderr).toContain(
            "Codec tuple omits reached project class Dependency"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            subclassInitializerCodecFixture("BoundRecord, Dependency"),
            "utf8"
        );
        const missingSubclass = run(fixture);
        expect(missingSubclass.status).toBe(1);
        expect(missingSubclass.stderr).toContain(
            "Codec tuple omits reached project class ExactRecord"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            subclassInitializerCodecFixture("BoundRecord, ExactRecord, Dependency"),
            "utf8"
        );
        const completeSubclass = run(fixture);
        expect(completeSubclass.status, completeSubclass.stderr).toBe(0);
    });

    test("derives constructed subclasses and initializers for generic codecs", async () => {
        const fixture = await createFixture({
            "src/codec.ts": genericSubclassInitializerCodecFixture("BoundRecord")
        });

        const missing = run(fixture);
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain("Codec tuple omits reached project class ExactRecord");
        expect(missing.stderr).toContain("Codec tuple omits reached project class Dependency");

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            genericSubclassInitializerCodecFixture("BoundRecord, ExactRecord"),
            "utf8"
        );
        const missingInitializer = run(fixture);
        expect(missingInitializer.status).toBe(1);
        expect(missingInitializer.stderr).toContain(
            "Codec tuple omits reached project class Dependency"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            genericSubclassInitializerCodecFixture("BoundRecord, Dependency"),
            "utf8"
        );
        const missingSubclass = run(fixture);
        expect(missingSubclass.status).toBe(1);
        expect(missingSubclass.stderr).toContain(
            "Codec tuple omits reached project class ExactRecord"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            genericSubclassInitializerCodecFixture("BoundRecord, ExactRecord, Dependency"),
            "utf8"
        );
        const completeGenericSubclass = run(fixture);
        expect(completeGenericSubclass.status, completeGenericSubclass.stderr).toBe(0);
    });

    test("derives every concrete descendant and its virtual behavior", async () => {
        const fixture = await createFixture({
            "src/codec.ts": concreteDescendantCodecFixture("BoundRecord, RestoredRecord")
        });

        const missingDescendant = run(fixture);
        expect(missingDescendant.status).toBe(1);
        expect(missingDescendant.stderr).toContain(
            "Codec tuple omits reached project class AlternateRecord"
        );
        expect(missingDescendant.stderr).toContain(
            "Codec tuple omits reached project class Dependency"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            concreteDescendantCodecFixture("BoundRecord, RestoredRecord, AlternateRecord"),
            "utf8"
        );
        const missingVirtualDependency = run(fixture);
        expect(missingVirtualDependency.status).toBe(1);
        expect(missingVirtualDependency.stderr).toContain(
            "Codec tuple omits reached project class Dependency"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            concreteDescendantCodecFixture("BoundRecord, RestoredRecord, Dependency"),
            "utf8"
        );
        const missingAlternate = run(fixture);
        expect(missingAlternate.status).toBe(1);
        expect(missingAlternate.stderr).toContain(
            "Codec tuple omits reached project class AlternateRecord"
        );

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            concreteDescendantCodecFixture(
                "BoundRecord, RestoredRecord, AlternateRecord, Dependency"
            ),
            "utf8"
        );
        const completeDescendants = run(fixture);
        expect(completeDescendants.status, completeDescendants.stderr).toBe(0);
    });

    test("fails closed when a semantic call or construction target is dynamic", async () => {
        const fixture = await createFixture({
            "src/codec.ts": dynamicCodecFixture()
        });

        const result = run(fixture);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            "Codec dependency analysis cannot resolve dynamic construction Factory"
        );
        expect(result.stderr).toContain(
            "Codec dependency analysis cannot resolve dynamic call Dependency[method]"
        );
    });

    test("derives private trust-boundary capture for every injected codec behavior", async () => {
        const fixture = await createFixture({
            "src/codec.ts": genericCodecFixture("BoundRecord, Dependency", "parameter-property")
        });

        for (const disposition of [
            "parameter-property",
            "direct-private",
            "frozen-alias",
            "unsealed"
        ] as const) {
            await writeFile(
                resolve(fixture, "src/codec.ts"),
                genericCodecFixture("BoundRecord, Dependency", disposition),
                "utf8"
            );
            const rejected = run(fixture);
            expect(rejected.status).toBe(1);
            expect(rejected.stderr).toContain(
                "RecordCodec injected behavior must cross its trust boundary into private state before a final Object.freeze(this)"
            );
        }

        await writeFile(
            resolve(fixture, "src/codec.ts"),
            genericCodecFixture("BoundRecord, Dependency"),
            "utf8"
        );
        const complete = run(fixture);
        expect(complete.status, complete.stderr).toBe(0);
    });

    test("finds behavior-dependent codecs in nested declarations and class expressions", async () => {
        const fixture = await createFixture({
            "src/codec.ts": hiddenBehaviorCodecFixture("declaration")
        });

        for (const shape of ["declaration", "expression", "namespace"] as const) {
            await writeFile(
                resolve(fixture, "src/codec.ts"),
                hiddenBehaviorCodecFixture(shape),
                "utf8"
            );
            const rejected = run(fixture);
            expect(rejected.status).toBe(1);
            expect(rejected.stderr).toContain(
                "RecordCodec injected behavior must cross its trust boundary into private state before a final Object.freeze(this)"
            );
        }
    });

    test("resolves indirect codecs and aliased or namespace-qualified constructors", async () => {
        const fixture = await createFixture({
            "src/codec.ts": constructedCodecFixture("indirect")
        });

        for (const shape of ["indirect", "alias", "namespace"] as const) {
            await writeFile(
                resolve(fixture, "src/codec.ts"),
                constructedCodecFixture(shape),
                "utf8"
            );
            const rejected = run(fixture);
            expect(rejected.status).toBe(1);
            expect(rejected.stderr).toContain("Codec tuple omits reached project class Dependency");
        }
    });

    test("recognizes only the exact structural copier and native Function bind", async () => {
        const fixture = await createFixture({
            "src/invocations/codec.ts": structuralCopierFixture(),
            "src/codec.ts": structuralCaptureFixture("shadowed")
        });

        for (const capture of ["shadowed", "custom-bind"] as const) {
            await writeFile(
                resolve(fixture, "src/codec.ts"),
                structuralCaptureFixture(capture),
                "utf8"
            );
            const rejected = run(fixture);
            expect(rejected.status).toBe(1);
            expect(rejected.stderr).toContain(
                "RecordCodec injected behavior must cross its trust boundary into private state before a final Object.freeze(this)"
            );
        }

        for (const capture of ["alias", "namespace"] as const) {
            await writeFile(
                resolve(fixture, "src/codec.ts"),
                structuralCaptureFixture(capture),
                "utf8"
            );
            const accepted = run(fixture);
            expect(accepted.status, accepted.stderr).toBe(0);
        }
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

async function writeExports(root: string, symbols: readonly string[]): Promise<void> {
    await writeFile(
        resolve(root, "exports.json"),
        `${JSON.stringify(
            {
                edition: "2.0.0",
                runtime: { "@fixture/core": symbols },
                declarations: {
                    "@fixture/core": Object.fromEntries(
                        [...symbols]
                            .sort((left, right) => compareCanonicalText(left, right))
                            .map((name) => [name, "class"])
                    )
                }
            },
            null,
            2
        )}\n`,
        "utf8"
    );
}

async function writeDeclarationExports(
    root: string,
    declarations: readonly { name: string; kind: string }[]
): Promise<void> {
    await writeFile(
        resolve(root, "exports.json"),
        `${JSON.stringify(
            {
                edition: "2.0.0",
                runtime: { "@fixture/core": declarations.map(({ name }) => name) },
                declarations: {
                    "@fixture/core": Object.fromEntries(
                        [...declarations]
                            .sort((left, right) => compareCanonicalText(left.name, right.name))
                            .map(({ name, kind }) => [name, kind])
                    )
                }
            },
            null,
            2
        )}\n`,
        "utf8"
    );
}

async function writeProjectExports(root: string, symbols: readonly string[]): Promise<void> {
    const registry: {
        declarations: Record<string, Record<string, string>>;
    } = JSON.parse(await readFile(resolve(packageRoot, "artifacts/quality/exports.json"), "utf8"));
    const core = registry.declarations["@agent-core/core"];
    if (core === undefined) throw new TypeError("Project export registry has no core package");
    for (const name of symbols) core[name] = "class";
    registry.declarations["@agent-core/core"] = Object.fromEntries(
        Object.entries(core).sort(([left], [right]) => compareCanonicalText(left, right))
    );
    await writeFile(
        resolve(root, "exports.json"),
        `${JSON.stringify(registry, null, 2)}\n`,
        "utf8"
    );
    await writeFile(
        resolve(root, "vocabulary.json"),
        await readFile(resolve(packageRoot, "artifacts/quality/spec-vocabulary.json"), "utf8"),
        "utf8"
    );
}

async function writeVocabulary(root: string): Promise<void> {
    await writeFile(
        resolve(root, "vocabulary.json"),
        '{\n  "edition": "1.0.0",\n  "foreign": [],\n  "reviewed": []\n}\n',
        "utf8"
    );
}

async function writeForeignVocabulary(root: string, word: string): Promise<void> {
    await writeFile(
        resolve(root, "vocabulary.json"),
        `${JSON.stringify(
            {
                edition: "1.0.0",
                foreign: [{ word, specTerm: "Operation" }],
                reviewed: []
            },
            null,
            2
        )}\n`,
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
    await writeFile(resolve(root, "SPEC.md"), spec, "utf8");
    await writePermits(root, []);
    await writeExports(root, []);
    await writeVocabulary(root);
    return root;
}

function run(root: string): QualitySubprocessResult {
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
            resolve(root, "permits.json"),
            "--spec",
            resolve(root, "SPEC.md"),
            "--exports",
            resolve(root, "exports.json"),
            "--vocabulary",
            resolve(root, "vocabulary.json")
        ],
        packageRoot
    );
}

function codecFixture(classes: string): string {
    return [
        "abstract class RecordCodec<Record> {",
        "  protected constructor(_classes: readonly object[], _kind: string, _version: object) {}",
        "  protected abstract encodePayload(record: Record): string;",
        "  protected abstract decodePayload(payload: string): Record;",
        "}",
        "class Dependency {",
        "  public static project(value: string): string { return value; }",
        "}",
        "class BoundRecord {",
        "  public constructor(public readonly value: string) {}",
        "  public toData(): string { return Dependency.project(this.value); }",
        "  public static fromData(value: string): BoundRecord {",
        "    return new BoundRecord(Dependency.project(value));",
        "  }",
        "}",
        "class BoundCodec extends RecordCodec<BoundRecord> {",
        `  public constructor() { super([${classes}], 'fixture.record', { major: 1, minor: 0 }); }`,
        "  protected encodePayload(record: BoundRecord): string { return record.toData(); }",
        "  protected decodePayload(payload: string): BoundRecord { return BoundRecord.fromData(payload); }",
        "}",
        "export const codec = new BoundCodec();"
    ].join("\n");
}

function genericCodecFixture(
    classes: string,
    disposition:
        | "parameter-property"
        | "direct-private"
        | "frozen-alias"
        | "unsealed"
        | "complete" = "complete"
): string {
    const field =
        disposition === "parameter-property"
            ? ""
            : "  readonly #restore: (value: string) => Value;";
    const parameter =
        disposition === "parameter-property"
            ? "    private readonly restore: (value: string) => Value"
            : "    restore: (value: string) => Value";
    const assignment =
        disposition === "parameter-property"
            ? ""
            : disposition === "direct-private"
              ? "    this.#restore = restore;"
              : disposition === "frozen-alias"
                ? "    this.#restore = Object.freeze(restore);"
                : "    this.#restore = restore.bind(undefined);";
    const freeze = disposition === "unsealed" ? "" : "    Object.freeze(this);";
    const restore = disposition === "parameter-property" ? "this.restore" : "this.#restore";
    return [
        "abstract class RecordCodec<Record> {",
        "  protected constructor(_classes: readonly object[], _kind: string, _version: object) {}",
        "  protected abstract encodePayload(record: Record): string;",
        "  protected abstract decodePayload(payload: string): Record;",
        "}",
        "class Dependency {",
        "  public static project(value: string): string { return value; }",
        "}",
        "class BoundRecord {",
        "  public constructor(public readonly value: string) {}",
        "  public toData(): string { return Dependency.project(this.value); }",
        "  public static fromData(value: string): BoundRecord {",
        "    return new BoundRecord(Dependency.project(value));",
        "  }",
        "}",
        "class ArbitrarilyNamedCodec<Value extends { toData(): string }> extends RecordCodec<Value> {",
        field,
        "  public constructor(",
        "    classes: readonly object[],",
        parameter,
        "  ) {",
        "    super(classes, 'fixture.generic', { major: 1, minor: 0 });",
        assignment,
        freeze,
        "  }",
        "  protected encodePayload(record: Value): string { return record.toData(); }",
        `  protected decodePayload(payload: string): Value { return ${restore}(payload); }`,
        "}",
        `export const codec = new ArbitrarilyNamedCodec([${classes}], BoundRecord.fromData);`
    ].join("\n");
}

function codecPrelude(): readonly string[] {
    return [
        "abstract class RecordCodec<Record> {",
        "  protected constructor(_classes: readonly object[], _kind: string, _version: object) {}",
        "  protected abstract encodePayload(record: Record): string;",
        "  protected abstract decodePayload(payload: string): Record;",
        "}",
        "class Dependency { public static project(value: string): string { return value; } }",
        "class BoundRecord {",
        "  public constructor(public readonly value: string) {}",
        "  public toData(): string { return Dependency.project(this.value); }",
        "  public static fromData(value: string): BoundRecord { return new BoundRecord(value); }",
        "}"
    ];
}

function hiddenBehaviorCodecFixture(shape: "declaration" | "expression" | "namespace"): string {
    const codec = [
        "class HiddenCodec<Value extends { toData(): string }> extends RecordCodec<Value> {",
        "  readonly #restore: (value: string) => Value;",
        "  public constructor(classes: readonly object[], restore: (value: string) => Value) {",
        "    super(classes, 'fixture.hidden', { major: 1, minor: 0 });",
        "    this.#restore = restore;",
        "    Object.freeze(this);",
        "  }",
        "  protected encodePayload(record: Value): string { return record.toData(); }",
        "  protected decodePayload(payload: string): Value { return this.#restore(payload); }",
        "}"
    ];
    const body =
        shape === "declaration"
            ? [
                  "function createCodec() {",
                  ...codec.map((line) => `  ${line}`),
                  "  return new HiddenCodec([BoundRecord, Dependency], BoundRecord.fromData);",
                  "}",
                  "export const codec = createCodec();"
              ]
            : shape === "expression"
              ? [
                    "function createCodec() {",
                    ...codec.map((line, index) =>
                        index === 0
                            ? `  ${line.replace("class HiddenCodec", "const HiddenCodec = class")}`
                            : `  ${line}`
                    ),
                    "  return new HiddenCodec([BoundRecord, Dependency], BoundRecord.fromData);",
                    "}",
                    "export const codec = createCodec();"
                ]
              : [
                    "namespace Codecs {",
                    ...codec.map((line) =>
                        line.startsWith("class HiddenCodec") ? `  export ${line}` : `  ${line}`
                    ),
                    "}",
                    "export const codec = new Codecs.HiddenCodec([BoundRecord, Dependency], BoundRecord.fromData);"
                ];
    return [...codecPrelude(), ...body].join("\n");
}

function constructedCodecFixture(shape: "indirect" | "alias" | "namespace"): string {
    const generic = [
        "class GenericCodec<Value extends { toData(): string }> extends RecordCodec<Value> {",
        "  readonly #restore: (value: string) => Value;",
        "  public constructor(classes: readonly object[], restore: (value: string) => Value) {",
        "    super(classes, 'fixture.constructed', { major: 1, minor: 0 });",
        "    this.#restore = restore.bind(undefined);",
        "    Object.freeze(this);",
        "  }",
        "  protected encodePayload(record: Value): string { return record.toData(); }",
        "  protected decodePayload(payload: string): Value { return this.#restore(payload); }",
        "}"
    ];
    const construction =
        shape === "indirect"
            ? [
                  "class IndirectCodec extends GenericCodec<BoundRecord> {",
                  "  public constructor() { super([BoundRecord], BoundRecord.fromData); }",
                  "}",
                  "export const codec = new IndirectCodec();"
              ]
            : shape === "alias"
              ? [
                    "const RenamedCodec = GenericCodec;",
                    "export const codec = new RenamedCodec([BoundRecord], BoundRecord.fromData);"
                ]
              : [
                    "namespace Codecs { export const RenamedCodec = GenericCodec; }",
                    "export const codec = new Codecs.RenamedCodec([BoundRecord], BoundRecord.fromData);"
                ];
    return [...codecPrelude(), ...generic, ...construction].join("\n");
}

function structuralCopierFixture(): string {
    return [
        "export interface StructuralCodec<Value> {",
        "  readonly encode: (value: Value) => string;",
        "  readonly decode: (value: string) => Value;",
        "}",
        "export function copyStructuralCodec<Value>(codec: StructuralCodec<Value>): StructuralCodec<Value> {",
        "  return Object.freeze({ encode: codec.encode.bind(undefined), decode: codec.decode.bind(undefined) });",
        "}"
    ].join("\n");
}

function structuralCaptureFixture(
    capture: "shadowed" | "custom-bind" | "alias" | "namespace"
): string {
    const imports =
        capture === "namespace"
            ? 'import * as trusted from "./invocations/codec";\nimport type { StructuralCodec } from "./invocations/codec";'
            : 'import { copyStructuralCodec as captureCodec, type StructuralCodec } from "./invocations/codec";';
    const dependency =
        capture === "custom-bind"
            ? "restore: { bind(value: undefined): StructuralCodec<Value> }"
            : "restore: StructuralCodec<Value>";
    const assignment =
        capture === "shadowed"
            ? "this.#restore = copyStructuralCodec(restore);"
            : capture === "custom-bind"
              ? "this.#restore = restore.bind(undefined);"
              : capture === "namespace"
                ? "this.#restore = trusted.copyStructuralCodec(restore);"
                : "this.#restore = captureCodec(restore);";
    const shadow =
        capture === "shadowed"
            ? "function copyStructuralCodec<Value>(value: StructuralCodec<Value>): StructuralCodec<Value> { return value; }"
            : "";
    const value = capture === "custom-bind" ? "{ bind: () => referenceCodec }" : "referenceCodec";
    return [
        imports,
        ...codecPrelude(),
        shadow,
        "const referenceCodec = { encode: (value: BoundRecord) => value.toData(), decode: BoundRecord.fromData };",
        "class StructuralRecordCodec<Value extends { toData(): string }> extends RecordCodec<Value> {",
        "  readonly #restore: StructuralCodec<Value>;",
        `  public constructor(classes: readonly object[], ${dependency}) {`,
        "    super(classes, 'fixture.structural', { major: 1, minor: 0 });",
        `    ${assignment}`,
        "    Object.freeze(this);",
        "  }",
        "  protected encodePayload(record: Value): string { return this.#restore.encode(record); }",
        "  protected decodePayload(payload: string): Value { return this.#restore.decode(payload); }",
        "}",
        `export const codec = new StructuralRecordCodec([BoundRecord, Dependency], ${value});`
    ].join("\n");
}

function staticCodecFixture(): string {
    return [
        "abstract class RecordCodec<Record> {",
        "  protected constructor(_classes: readonly object[], _kind: string, _version: object) {}",
        "  protected abstract encodePayload(record: Record): string;",
        "  protected abstract decodePayload(payload: string): Record;",
        "}",
        "class StaticRecord {",
        "  public static readonly codec = new StaticCodec();",
        "  public toData(): string { return 'static'; }",
        "  public static fromData(_value: string): StaticRecord { return new StaticRecord(); }",
        "}",
        "class StaticCodec extends RecordCodec<StaticRecord> {",
        "  public constructor() { super([StaticRecord], 'fixture.static', { major: 1, minor: 0 }); }",
        "  protected encodePayload(record: StaticRecord): string { return record.toData(); }",
        "  protected decodePayload(payload: string): StaticRecord { return StaticRecord.fromData(payload); }",
        "}"
    ].join("\n");
}

function earlyCodecFixture(): string {
    return [
        "abstract class RecordCodec<Record> {",
        "  protected constructor(_classes: readonly object[], _kind: string, _version: object) {}",
        "  protected abstract encodePayload(record: Record): string;",
        "  protected abstract decodePayload(payload: string): Record;",
        "}",
        "class BoundRecord {",
        "  public toData(): string { return Dependency.project('early'); }",
        "  public static fromData(_value: string): BoundRecord { return new BoundRecord(); }",
        "}",
        "class BoundCodec extends RecordCodec<BoundRecord> {",
        "  public constructor() { super([BoundRecord, Dependency], 'fixture.early', { major: 1, minor: 0 }); }",
        "  protected encodePayload(record: BoundRecord): string { return record.toData(); }",
        "  protected decodePayload(payload: string): BoundRecord { return BoundRecord.fromData(payload); }",
        "}",
        "export const codec = new BoundCodec();",
        "class Dependency {",
        "  public static project(value: string): string { return value; }",
        "}"
    ].join("\n");
}

function subclassInitializerCodecFixture(classes: string): string {
    return [
        "abstract class RecordCodec<Record> {",
        "  protected constructor(_classes: readonly object[], _kind: string, _version: object) {}",
        "  protected abstract encodePayload(record: Record): string;",
        "  protected abstract decodePayload(payload: string): Record;",
        "}",
        "class Dependency {",
        "  public static project(value: string): string { return value; }",
        "}",
        "abstract class BoundRecord {",
        "  public static fromData(_value: string): BoundRecord { return new ExactRecord(); }",
        "  public abstract toData(): string;",
        "}",
        "class ExactRecord extends BoundRecord {",
        "  public static readonly projected = Dependency.project('static');",
        "  public readonly value = Dependency.project(ExactRecord.projected);",
        "  public toData(): string { return this.value; }",
        "}",
        "class BoundCodec extends RecordCodec<BoundRecord> {",
        `  public constructor() { super([${classes}], 'fixture.subclass', { major: 1, minor: 0 }); }`,
        "  protected encodePayload(record: BoundRecord): string { return record.toData(); }",
        "  protected decodePayload(payload: string): BoundRecord { return BoundRecord.fromData(payload); }",
        "}",
        "export const codec = new BoundCodec();"
    ].join("\n");
}

function genericSubclassInitializerCodecFixture(classes: string): string {
    return [
        "abstract class RecordCodec<Record> {",
        "  protected constructor(_classes: readonly object[], _kind: string, _version: object) {}",
        "  protected abstract encodePayload(record: Record): string;",
        "  protected abstract decodePayload(payload: string): Record;",
        "}",
        "class Dependency {",
        "  public static project(value: string): string { return value; }",
        "}",
        "abstract class BoundRecord {",
        "  public static fromData(_value: string): BoundRecord { return new ExactRecord(); }",
        "  public abstract toData(): string;",
        "}",
        "class ExactRecord extends BoundRecord {",
        "  public static readonly projected = Dependency.project('static');",
        "  public readonly value = Dependency.project(ExactRecord.projected);",
        "  public toData(): string { return this.value; }",
        "}",
        "class ArbitrarilyNamedCodec<Value extends { toData(): string }> extends RecordCodec<Value> {",
        "  readonly #restore: (value: string) => Value;",
        "  public constructor(",
        "    classes: readonly object[],",
        "    restore: (value: string) => Value",
        "  ) {",
        "    super(classes, 'fixture.generic-subclass', { major: 1, minor: 0 });",
        "    this.#restore = restore.bind(undefined);",
        "    Object.freeze(this);",
        "  }",
        "  protected encodePayload(record: Value): string { return record.toData(); }",
        "  protected decodePayload(payload: string): Value { return this.#restore(payload); }",
        "}",
        `export const codec = new ArbitrarilyNamedCodec([${classes}], BoundRecord.fromData);`
    ].join("\n");
}

function concreteDescendantCodecFixture(classes: string): string {
    return [
        "abstract class RecordCodec<Record> {",
        "  protected constructor(_classes: readonly object[], _kind: string, _version: object) {}",
        "  protected abstract encodePayload(record: Record): string;",
        "  protected abstract decodePayload(payload: string): Record;",
        "}",
        "class Dependency {",
        "  public static project(value: string): string { return value; }",
        "}",
        "abstract class BoundRecord {",
        "  public static fromData(_value: string): BoundRecord { return new RestoredRecord(); }",
        "  public abstract toData(): string;",
        "}",
        "class RestoredRecord extends BoundRecord {",
        "  public toData(): string { return 'restored'; }",
        "}",
        "export class AlternateRecord extends BoundRecord {",
        "  public toData(): string { return Dependency.project('alternate'); }",
        "}",
        "class BoundCodec extends RecordCodec<BoundRecord> {",
        `  public constructor() { super([${classes}], 'fixture.descendants', { major: 1, minor: 0 }); }`,
        "  protected encodePayload(record: BoundRecord): string { return record.toData(); }",
        "  protected decodePayload(payload: string): BoundRecord { return BoundRecord.fromData(payload); }",
        "}",
        "export const codec = new BoundCodec();"
    ].join("\n");
}

function dynamicCodecFixture(): string {
    return [
        "abstract class RecordCodec<Record> {",
        "  protected constructor(_classes: readonly object[], _kind: string, _version: object) {}",
        "  protected abstract encodePayload(record: Record): string;",
        "  protected abstract decodePayload(payload: string): Record;",
        "}",
        "class Dependency {",
        "  public static project(value: string): string { return value; }",
        "}",
        "const method: keyof typeof Dependency = 'project';",
        "class BoundRecord {",
        "  public toData(): string { return Dependency[method]('dynamic'); }",
        "  public static fromData(_value: string): BoundRecord {",
        "    let Factory: typeof BoundRecord = BoundRecord;",
        "    return new Factory();",
        "  }",
        "}",
        "class BoundCodec extends RecordCodec<BoundRecord> {",
        "  public constructor() { super([BoundRecord, Dependency], 'fixture.dynamic', { major: 1, minor: 0 }); }",
        "  protected encodePayload(record: BoundRecord): string { return record.toData(); }",
        "  protected decodePayload(payload: string): BoundRecord { return BoundRecord.fromData(payload); }",
        "}",
        "export const codec = new BoundCodec();"
    ].join("\n");
}
