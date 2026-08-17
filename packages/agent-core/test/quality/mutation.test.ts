import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { JsonValue } from "../../scripts/quality/project.mjs";
import {
    auditEquivalenceAnchors,
    readEquivalenceRegister,
    reconcileEquivalence,
    type EquivalenceEntry,
    type MutationReport,
    type ReportMutant
} from "../../scripts/quality/mutation-equivalence.mjs";
import { generatedMutants } from "../../scripts/quality/mutation-instrumenter.mjs";
import {
    mutationFingerprint,
    mutationTestFiles,
    sourceAreas
} from "../../scripts/quality/mutation-inputs.mjs";
import { runQualitySubprocess } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/mutation.mjs");

function portable(path: string): string {
    return relative(packageRoot, path).replaceAll("\\", "/");
}

interface SourcePosition {
    readonly line: number;
    readonly column: number;
}

function gateFixture(
    stage: "building" | "final",
    areas: Readonly<Record<string, JsonValue>>,
    entries: readonly EquivalenceEntry[] = []
): string[] {
    const directory = mkdtempSync(join(tmpdir(), "mutation-gate-"));
    const baseline = join(directory, "baseline.json");
    const stageArtifact = join(directory, "stage.json");
    const register = join(directory, "equivalence.json");
    writeFileSync(baseline, JSON.stringify({ edition: "1.0.0", areas }));
    writeFileSync(stageArtifact, JSON.stringify({ edition: "1.0.0", stage }));
    writeFileSync(register, JSON.stringify({ edition: "1.0.0", entries }));
    return [
        "--gate",
        "--baseline",
        baseline,
        "--stage-artifact",
        stageArtifact,
        "--register",
        register
    ];
}

const staleArea = {
    measuredAt: "0".repeat(40),
    mutants: 10,
    killed: 10,
    score: 100,
    actionable: 0,
    tolerated: 0,
    fingerprint: "sha256:stale"
};

describe("mutation adequacy gate", () => {
    test("rejects stale fingerprints at every stage", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, ...gateFixture("building", { authority: staleArea })],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Mutation gate failed");
        expect(result.stderr).toContain("authority: missing or stale mutation fingerprint");
    });

    test("reports unmeasured areas and survivors as notes while building, failures at final", () => {
        const building = runQualitySubprocess(
            process.execPath,
            [checker, ...gateFixture("building", {})],
            packageRoot
        );
        expect(building.status).toBe(0);
        expect(building.stdout).toContain("note: unmeasured areas:");

        const final = runQualitySubprocess(
            process.execPath,
            [checker, ...gateFixture("final", {})],
            packageRoot
        );
        expect(final.status).toBe(1);
        expect(final.stderr).toContain("unmeasured areas:");
    });

    test("rejects a baseline area outside the source universe", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, ...gateFixture("building", { phantom: staleArea })],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("phantom: baseline records a nonexistent source area");
    });

    test("rejects an area outside the exact source universe before running Stryker", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, "--area", "../outside"],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Unknown source area");
        expect(result.stderr).not.toContain("Stryker");
    });

    test("offers no count-level way to move the floor", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, "--area", "identity", "--update", "--accept-regression", "we shipped late"],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Unknown mutation argument --accept-regression");
    });

    test("fails the gate when a register entry names a file that no longer exists", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [
                checker,
                ...gateFixture("building", {}, [
                    { ...guardEntry("encode", "removed"), file: "src/identity/removed.ts" }
                ])
            ],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("equivalence entry names a missing file");
        expect(result.stderr).toContain("src/identity/removed.ts");
    });

    // Whether a registered mutant still survives is the one thing only a run can report,
    // and a run costs half an hour. It used to cost that: the register verdict threw
    // before a byte of the measurement was written, and Stryker's own report.json is
    // scratch the next area overwrites, so one stale entry of 383 discarded the whole
    // area. The failure has to be by name, after the measurement lands.
    test("records the measurement and then fails naming the refuted entry", () => {
        const directory = mkdtempSync(join(tmpdir(), "mutation-measure-"));
        const reportPath = join(directory, "report.json");
        const registerPath = join(directory, "equivalence.json");
        const survivorsPath = join(directory, "survivors.json");
        const entry = guardEntry("encode", "a mutant a test turns out to kill");
        writeFileSync(
            reportPath,
            JSON.stringify(reportFor(guardModule, [{ ...guardMutant, status: "Killed" }]))
        );
        writeFileSync(registerPath, JSON.stringify({ edition: "1.0.0", entries: [entry] }));

        const result = runQualitySubprocess(
            process.execPath,
            [
                checker,
                "--area",
                "identity",
                "--report",
                reportPath,
                "--register",
                registerPath,
                "--survivors",
                survivorsPath,
                "--discrimination",
                join(directory, "discrimination.json")
            ],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("refuted —");
        expect(result.stderr).toContain("src/identity/ref.ts#encode ConditionalExpression");
        expect(result.stderr).toContain("is reported Killed");
        expect(result.stderr).toContain(survivorsPath);

        expect(JSON.parse(readFileSync(survivorsPath, "utf8"))).toMatchObject({
            area: "identity",
            mutants: 1,
            killed: 1,
            score: 100,
            registerFailures: [expect.stringContaining("refuted —")]
        });
    });

    test("refuses to re-pin a baseline from a report it did not measure", () => {
        const result = runQualitySubprocess(
            process.execPath,
            [checker, "--area", "identity", "--update", "--report", "reports/anything.json"],
            packageRoot
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("--update pins a baseline and so must measure");
    });
});

// One mutant, one proof, and a claim that any future run can contradict. The two
// directions are what a count-level override could never have: a registered mutant that
// turns out killable refutes its own proof, and a proof whose mutant is gone is no longer
// about anything. Every case below is built by locating real text in a real parsed module
// and handing Stryker's own report shape to the reconciler.
const guardModule = `import { Id } from "./id";

export class Ref {
    private constructor(
        public readonly kind: "a" | "b",
        public readonly id: Id | undefined
    ) {}

    public static a(): Ref {
        return new Ref("a", undefined);
    }

    public equals(other: Ref): boolean {
        return this.kind === other.kind && idEquals(this.id, other.id);
    }
}

export function encode(ref: Ref): string {
    if (ref.kind === "a") {
        return ref.kind;
    }
    if (ref.id === undefined) {
        throw new TypeError("Ref b requires an Id");
    }
    return ref.id.value;
}

function idEquals(left: Id | undefined, right: Id | undefined): boolean {
    if (left === undefined) {
        throw new TypeError("Ref b requires an Id");
    }
    return right !== undefined && left.equals(right);
}
`;

const registeredFile = "src/identity/ref.ts";

function proofFor(subject: string): string {
    return (
        `The mutated site in ${subject} sits behind a guard the module cannot satisfy: the only ` +
        "factory that produces this kind assigns the id in the same expression, so the guard's " +
        "condition is constantly false and the branch it protects is never selected. A mutation " +
        "confined to a branch no input can reach changes no value, no exception, and no effect " +
        "that a caller could observe, which is exactly why no test can ever distinguish it."
    );
}

function guardEntry(symbol: string, subject: string): EquivalenceEntry {
    return {
        file: registeredFile,
        symbol,
        mutator: "ConditionalExpression",
        replacement: "false",
        mutated: "ref.id === undefined",
        proof: proofFor(subject)
    };
}

function position(source: string, offset: number): SourcePosition {
    const consumed = source.slice(0, offset).split("\n");
    return { line: consumed.length, column: (consumed.at(-1) ?? "").length + 1 };
}

function reportFor(
    source: string,
    mutants: readonly {
        text: string;
        mutator: string;
        replacement: string;
        status: string;
        occurrence?: number;
    }[]
): MutationReport {
    return {
        files: {
            [registeredFile]: {
                source,
                mutants: mutants.map((mutant, index): ReportMutant => {
                    let offset = -1;
                    for (let seen = 0; seen <= (mutant.occurrence ?? 0); seen += 1) {
                        offset = source.indexOf(mutant.text, offset + 1);
                    }
                    if (offset === -1) throw new TypeError(`fixture text absent: ${mutant.text}`);
                    return {
                        id: String(index + 1),
                        mutatorName: mutant.mutator,
                        replacement: mutant.replacement,
                        status: mutant.status,
                        location: {
                            start: position(source, offset),
                            end: position(source, offset + mutant.text.length)
                        }
                    };
                })
            }
        }
    };
}

const guardMutant = {
    text: "ref.id === undefined",
    mutator: "ConditionalExpression",
    replacement: "false"
} as const;

describe("mutation equivalence register", () => {
    test("refuses an entry that states no proof", () => {
        const entries = [{ ...guardEntry("encode", "encode"), proof: "This is equivalent." }];

        expect(() => readEquivalenceRegister({ edition: "1.0.0", entries })).toThrow(
            /states no proof of equivalence/u
        );
        expect(() =>
            readEquivalenceRegister({
                edition: "1.0.0",
                entries: [{ ...guardEntry("encode", "encode"), proof: "   " }]
            })
        ).toThrow(/must be a nonempty string/u);
    });

    test("refuses one proof stretched over two mutants", () => {
        const shared = proofFor("both sites at once");
        const entries = [
            { ...guardEntry("encode", "encode"), proof: shared },
            { ...guardEntry("idEquals", "idEquals"), proof: shared }
        ];

        expect(() => readEquivalenceRegister({ edition: "1.0.0", entries })).toThrow(
            /reuses another entry's proof/u
        );
    });

    test("refuses duplicate, malformed, and unanchorable entries", () => {
        const entry = guardEntry("encode", "encode");

        expect(() =>
            readEquivalenceRegister({ edition: "1.0.0", entries: [entry, entry] })
        ).toThrow(/duplicate id/u);
        expect(() =>
            readEquivalenceRegister({ edition: "1.0.0", entries: [{ ...entry, extra: 1 }] })
        ).toThrow(/missing or unknown fields/u);
        expect(() =>
            readEquivalenceRegister({
                edition: "1.0.0",
                entries: [{ ...entry, mutated: "ref.id  ===\n undefined" }]
            })
        ).toThrow(/is not normalized/u);
        expect(() =>
            readEquivalenceRegister({
                edition: "1.0.0",
                entries: [{ ...entry, file: "test/identity/ref.test.ts" }]
            })
        ).toThrow(/outside src\//u);
        expect(readEquivalenceRegister({ edition: "1.0.0", entries: [entry] })).toEqual([entry]);
    });

    test("excuses a registered mutant that no test can kill", () => {
        const entries = readEquivalenceRegister({
            edition: "1.0.0",
            entries: [guardEntry("encode", "encode")]
        });

        for (const status of ["Survived", "NoCoverage"]) {
            const resolved = reconcileEquivalence(
                reportFor(guardModule, [{ ...guardMutant, status }]),
                entries
            );

            expect([...resolved.equivalent.keys()]).toEqual(["1"]);
            expect(resolved.refuted).toEqual([]);
            expect(resolved.stale).toEqual([]);
            expect(resolved.ambiguous).toEqual([]);
        }
    });

    test("refutes the proof when the registered mutant turns out killable", () => {
        const entries = readEquivalenceRegister({
            edition: "1.0.0",
            entries: [guardEntry("encode", "encode")]
        });

        for (const status of ["Killed", "Timeout", "CompileError"]) {
            const resolved = reconcileEquivalence(
                reportFor(guardModule, [{ ...guardMutant, status }]),
                entries
            );

            expect(resolved.equivalent.size).toBe(0);
            expect(resolved.refuted.map((item) => item.entry)).toEqual(entries);
            expect(resolved.stale).toEqual([]);
        }
    });

    test("reports an entry whose mutant is gone, ignored, or elsewhere as stale", () => {
        const entries = readEquivalenceRegister({
            edition: "1.0.0",
            entries: [guardEntry("encode", "encode")]
        });
        const edited = guardModule.replace("ref.id === undefined", "ref.id?.value === undefined");

        expect(reconcileEquivalence(reportFor(edited, []), entries).stale).toEqual(entries);
        expect(
            reconcileEquivalence(
                reportFor(guardModule, [{ ...guardMutant, status: "Ignored" }]),
                entries
            ).stale
        ).toEqual(entries);
        expect(
            reconcileEquivalence(
                reportFor(guardModule, [
                    { ...guardMutant, status: "Survived", replacement: "true" }
                ]),
                entries
            ).stale
        ).toEqual(entries);
        expect(reconcileEquivalence({ files: {} } satisfies MutationReport, entries).stale).toEqual(
            []
        );
    });

    test("holds the anchor across code movement and reindentation", () => {
        const entries = readEquivalenceRegister({
            edition: "1.0.0",
            entries: [guardEntry("encode", "encode")]
        });
        const moved = `import { Digest } from "./digest";\nimport { Revision } from "./revision";\n\n${guardModule
            .replace(
                "export function encode",
                "export function unrelated(): void {}\n\nexport function encode"
            )
            .replace("    if (ref.id === undefined) {", "\tif (ref.id  ===  undefined) {")}`;

        const resolved = reconcileEquivalence(
            reportFor(moved, [
                { ...guardMutant, text: "ref.id  ===  undefined", status: "Survived" }
            ]),
            entries
        );

        expect(resolved.stale).toEqual([]);
        expect([...resolved.equivalent.values()]).toEqual(entries);
    });

    test("separates two identical sites by symbol and refuses a shared anchor", () => {
        const entries = readEquivalenceRegister({
            edition: "1.0.0",
            entries: [
                {
                    ...guardEntry("encode", "encode"),
                    mutator: "StringLiteral",
                    replacement: '""',
                    mutated: '"Ref b requires an Id"'
                },
                {
                    ...guardEntry("idEquals", "idEquals"),
                    mutator: "StringLiteral",
                    replacement: '""',
                    mutated: '"Ref b requires an Id"'
                }
            ]
        });
        const literal = {
            text: '"Ref b requires an Id"',
            mutator: "StringLiteral",
            replacement: '""'
        } as const;
        const resolved = reconcileEquivalence(
            reportFor(guardModule, [
                { ...literal, status: "Survived" },
                { ...literal, status: "Killed", occurrence: 1 }
            ]),
            entries
        );

        expect([...resolved.equivalent.values()]).toEqual([entries[0]]);
        expect(resolved.refuted.map((item) => item.entry)).toEqual([entries[1]]);

        const duplicated = guardModule.replace(
            "    return ref.id.value;",
            '    if (ref.id === undefined) {\n        throw new TypeError("Ref b requires an Id");\n    }\n    return ref.id.value;'
        );
        const collision = reconcileEquivalence(
            reportFor(duplicated, [
                { ...guardMutant, status: "Survived" },
                { ...guardMutant, status: "Survived", occurrence: 1 }
            ]),
            readEquivalenceRegister({
                edition: "1.0.0",
                entries: [guardEntry("encode", "encode")]
            })
        );

        expect(collision.equivalent.size).toBe(0);
        expect(collision.ambiguous.map((item) => item.matches.length)).toEqual([2]);
    });

    test("anchors a mutant nested inside a local declaration to the symbol naming it", async () => {
        // The auditor searches inside the named declaration while reconciliation used to
        // demand the mutant's innermost declaration path equal it. A mutant inside a
        // `const` therefore passed the audit and reconciled as stale forever, because the
        // path carries the variable: `encode` never matched `encode.unpaired`. Naming the
        // enclosing function is what an author writes, and scoping is all the symbol is for.
        const nested = guardModule.replace(
            "    if (ref.id === undefined) {",
            "    const unpaired = [ref].some((item) => item.id === undefined);\n    if (!unpaired && ref.id === undefined) {"
        );
        const entry = {
            ...guardEntry("encode", "the nested guard"),
            mutated: "item.id === undefined"
        };
        const entries = readEquivalenceRegister({ edition: "1.0.0", entries: [entry] });

        await expect(
            auditEquivalenceAnchors(
                entries,
                ["identity"],
                (file) => (file === registeredFile ? nested : undefined),
                generatedMutants
            )
        ).resolves.toEqual([]);
        const resolved = reconcileEquivalence(
            reportFor(nested, [
                {
                    text: "item.id === undefined",
                    mutator: "ConditionalExpression",
                    replacement: "false",
                    status: "Survived"
                }
            ]),
            entries
        );
        expect(resolved.stale).toEqual([]);
        expect([...resolved.equivalent.values()]).toEqual(entries);
    });

    test("selects one of two identical sites by its position, and only at that count", () => {
        // Two copies of the same guard inside one symbol. Their anchors are byte-identical
        // — same file, symbol, mutator, replacement and text — so position is the only
        // thing that can tell one proof from the other.
        const duplicated = guardModule.replace(
            "    return ref.id.value;",
            '    if (ref.id === undefined) {\n        throw new TypeError("Ref b requires an Id");\n    }\n    return ref.id.value;'
        );
        const entries = readEquivalenceRegister({
            edition: "1.0.0",
            entries: [
                { ...guardEntry("encode", "the first guard"), occurrence: 1, sites: 2 },
                { ...guardEntry("encode", "the second guard"), occurrence: 2, sites: 2 }
            ]
        });
        const report = reportFor(duplicated, [
            { ...guardMutant, status: "Survived" },
            { ...guardMutant, status: "Survived", occurrence: 1 }
        ]);
        const resolved = reconcileEquivalence(report, entries);

        expect(resolved.ambiguous).toEqual([]);
        expect(resolved.stale).toEqual([]);
        // Each entry claims exactly one mutant, and they are different mutants.
        expect(resolved.equivalent.get("1")).toBe(entries[0]);
        expect(resolved.equivalent.get("2")).toBe(entries[1]);

        // The same entries against the single-guard module: the count they were written
        // for is gone, so they report stale instead of re-pointing at whatever now sits
        // in first position.
        const moved = reconcileEquivalence(
            reportFor(guardModule, [{ ...guardMutant, status: "Survived" }]),
            entries
        );
        expect(moved.equivalent.size).toBe(0);
        expect(moved.stale).toEqual(entries);
    });

    test("refuses a position that names one site, an absent site, or a bare ordinal", () => {
        const positioned = (over: Readonly<Record<string, JsonValue>>) => () =>
            readEquivalenceRegister({
                edition: "1.0.0",
                entries: [{ ...guardEntry("encode", "encode"), occurrence: 1, sites: 2, ...over }]
            });

        // One site needs no ordinal; admitting one would give a single anchor two spellings.
        expect(positioned({ sites: 1 })).toThrow(/must omit occurrence/u);
        expect(positioned({ occurrence: 3 })).toThrow(/selects occurrence 3 of 2/u);
        expect(positioned({ occurrence: 0 })).toThrow(/must be a positive integer/u);
        expect(positioned({ sites: 2.5 })).toThrow(/must be a positive integer/u);
        // Both fields or neither: an ordinal carrying no recorded count could never go
        // stale, which is the whole reason the count is stored beside it.
        expect(() =>
            readEquivalenceRegister({
                edition: "1.0.0",
                entries: [{ ...guardEntry("encode", "encode"), occurrence: 1 }]
            })
        ).toThrow(/missing or unknown fields/u);
    });
});

// What runs on every quality gate, so a proof cannot quietly outlive either the code or
// the mutation it was written about. The reconciler only speaks when an area is measured,
// and an area costs half an hour; everything short of a mutant's status is settled here.
describe("mutation equivalence anchors", () => {
    const areas = sourceAreas();
    const readSource = (file: string): string | undefined => {
        const path = resolve(packageRoot, file);
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    };
    const audit = (entries: readonly EquivalenceEntry[]): Promise<string[]> =>
        auditEquivalenceAnchors(entries, areas, readSource, generatedMutants);

    const scopeGuard: EquivalenceEntry = {
        file: "src/identity/scope.ts",
        symbol: "encodeScopeRef",
        mutator: "ConditionalExpression",
        replacement: "false",
        mutated: "scope.projectId === undefined",
        proof: proofFor("encodeScopeRef")
    };

    test("resolves every committed entry to exactly one generated mutant", async () => {
        const register = readEquivalenceRegister(
            JSON.parse(
                readFileSync(
                    resolve(packageRoot, "artifacts/quality/mutation-equivalence.json"),
                    "utf8"
                )
            )
        );

        expect(register.length).toBeGreaterThan(0);
        await expect(audit(register)).resolves.toEqual([]);
    });

    test("names the entry when its file, area, symbol, or anchor has moved on", async () => {
        await expect(audit([{ ...scopeGuard, file: "src/nowhere/gone.ts" }])).resolves.toEqual([
            expect.stringContaining("names a file outside the measured areas")
        ]);
        await expect(audit([{ ...scopeGuard, file: "src/identity/gone.ts" }])).resolves.toEqual([
            expect.stringContaining("names a missing file")
        ]);
        await expect(audit([{ ...scopeGuard, symbol: "encodeScope" }])).resolves.toEqual([
            expect.stringContaining("names a symbol that no longer exists")
        ]);
        await expect(
            audit([{ ...scopeGuard, mutated: "scope.projectId === null" }])
        ).resolves.toEqual([expect.stringContaining("anchors 0 sites in its symbol, not one")]);
        await expect(audit([{ ...scopeGuard, mutated: "kind: scope.kind" }])).resolves.toEqual([
            expect.stringContaining("anchors 3 sites in its symbol, not one")
        ]);
    });

    // The axis the text comparison above cannot see. Whether a mutator applies to a node is
    // a property of Stryker's mutators, not of our source, so an entry naming a mutation
    // that does not exist at its anchor kept its anchored text intact and passed — while
    // every run reported it stale, unfixably, because there was nothing there to be about.
    // The first case is the entry that proved it: `isObjectRecord(value)` is a call
    // expression, and `ConditionalExpression` mutates boolean expressions and the tests of
    // conditions. It was written the same night a refactor replaced the boolean operand the
    // proof was about, and it survived four days of gates.
    test("names the entry when no mutator generates the mutation it claims", async () => {
        await expect(
            audit([
                {
                    file: "src/actors/id.ts",
                    symbol: "isExactActorId",
                    mutator: "ConditionalExpression",
                    replacement: "true",
                    mutated: "isObjectRecord(value)",
                    proof: proofFor("isExactActorId")
                }
            ])
        ).resolves.toEqual([
            expect.stringContaining("names 0 mutants Stryker generates at its anchor, not one")
        ]);
        await expect(audit([{ ...scopeGuard, mutator: "BooleanLiteral" }])).resolves.toEqual([
            expect.stringContaining("names 0 mutants Stryker generates at its anchor, not one")
        ]);
        await expect(audit([{ ...scopeGuard, replacement: "null" }])).resolves.toEqual([
            expect.stringContaining("names 0 mutants Stryker generates at its anchor, not one")
        ]);
        // The control: one field back, and the same anchor resolves. A check that rejected
        // this too would discriminate nothing.
        await expect(audit([scopeGuard])).resolves.toEqual([]);
    });
});

// A fingerprint that covers more than a run can read stales every area for a result that
// cannot have moved, which is how a ratchet stops being run. Both directions are pinned:
// the lanes the mutation vitest config excludes never execute, so they must not be
// hashed; the lanes it runs decide the result, so they must be.
describe("mutation staleness inputs", () => {
    const hashed = new Set(mutationTestFiles().map(portable));

    test("omits every lane the mutation run excludes", () => {
        const excludedLanes = [
            "test/quality/mutation.test.ts",
            "test/quality/subprocess.ts",
            "test/differential/policy.differential.test.ts",
            "test/differential/oracle.ts",
            "test/integration/stress/lease-fencing.test.ts",
            "test/core/error-taxonomy.test.ts",
            "test/definition/coverage-gate.test.ts"
        ];

        for (const path of excludedLanes) {
            expect(existsSync(resolve(packageRoot, path)), `${path} no longer exists`).toBe(true);
            expect(hashed.has(path), `${path} must not stale a mutation area`).toBe(false);
        }
    });

    test("covers the behavior lanes a mutation run executes", () => {
        const executedLanes = [
            "test/actors/actor.test.ts",
            "test/authority/hard-gates.test.ts",
            "test/agents/runs/acceptance.test.ts"
        ];

        for (const path of executedLanes) {
            expect(existsSync(resolve(packageRoot, path)), `${path} no longer exists`).toBe(true);
            expect(hashed.has(path), `${path} must stale a mutation area`).toBe(true);
        }
    });

    test("fingerprints an area from its own sources and is stable across calls", () => {
        const areas = sourceAreas();
        expect(areas).toContain("actors");
        expect(areas).toContain("authority");

        expect(mutationFingerprint("actors")).toBe(mutationFingerprint("actors"));
        expect(mutationFingerprint("actors")).not.toBe(mutationFingerprint("authority"));
    });

    // Dropping a register entry raises the actionable count the area's pinned baseline is
    // holding down. Unless that stales the area, the floor silently goes loose, so the
    // register slice an area depends on is hashed with its sources — and only that slice.
    test("stales the area an equivalence entry applies to, and no other", () => {
        const entry = {
            file: "src/identity/scope.ts",
            symbol: "encodeScopeRef",
            mutator: "ConditionalExpression",
            replacement: "false",
            mutated: "scope.projectId === undefined",
            proof: proofFor("encodeScopeRef")
        };

        expect(mutationFingerprint("identity", [])).not.toBe(
            mutationFingerprint("identity", [entry])
        );
        expect(mutationFingerprint("identity", [entry])).toBe(
            mutationFingerprint("identity", [{ ...entry, proof: proofFor("a reworded proof") }])
        );
        expect(mutationFingerprint("actors", [])).toBe(mutationFingerprint("actors", [entry]));
    });
});
