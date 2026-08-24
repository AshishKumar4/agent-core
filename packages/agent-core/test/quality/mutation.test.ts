import { spawn } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
    assertObject,
    assertString,
    parseCanonicalJson,
    sha256,
    type JsonValue
} from "../../scripts/quality/project.mjs";
import {
    auditEquivalenceAnchors,
    mutationOutcome,
    readEquivalenceRegister,
    reconcileEquivalence,
    requireCompleteMutationReport,
    unusableMutants,
    type EquivalenceEntry,
    type MutationReport,
    type ReportMutant
} from "../../scripts/quality/mutation-equivalence.mjs";
import { generatedMutants } from "../../scripts/quality/mutation-instrumenter.mjs";
import {
    mutationFingerprint,
    mutationRunIdentity,
    mutationRunKey,
    mutationTestFiles,
    sourceAreas
} from "../../scripts/quality/mutation-inputs.mjs";
import {
    measureArea,
    publishRunCache,
    readRunCache,
    requireAreaReport,
    runCachePath,
    runLedgerPath
} from "../../scripts/quality/mutation-run.mjs";
import { runQualitySubprocess } from "./subprocess";

const packageRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(packageRoot, "scripts/quality/mutation.mjs");
// Children that publish concurrently import these; a URL, because `import()` of a bare
// absolute path is not a specifier on every platform.
const runModule = pathToFileURL(resolve(packageRoot, "scripts/quality/mutation-run.mjs")).href;
const inputsModule = pathToFileURL(
    resolve(packageRoot, "scripts/quality/mutation-inputs.mjs")
).href;
const projectModule = pathToFileURL(resolve(packageRoot, "scripts/quality/project.mjs")).href;
// One case edits stryker.conf.mjs on disk, so the check has to run in a process that
// imports the config fresh rather than the one already holding it.
const refuseUnmirrorable = [
    `const { mutationRunKey } = await import(${JSON.stringify(inputsModule)});`,
    "try {",
    '    mutationRunKey("errors");',
    '    console.log("mirrored something it should not have");',
    "} catch (error) {",
    "    console.log(error.message);",
    "}"
].join("\n");

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
            JSON.stringify(
                reportFor(guardModule, [
                    {
                        ...guardMutant,
                        status: "Killed",
                        coveredBy: ["t1"],
                        killedBy: ["t1"],
                        testsCompleted: 1
                    }
                ])
            )
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

    // The defect that produced this campaign's first sweep: every status that was not
    // `Survived` was counted as a kill, so a mutant that timed out on a machine at load
    // 43.9 raised `killed`, lowered `actionable`, and moved a ratchet floor on evidence
    // about the workstation. Four statuses reach that branch and none of them says a test
    // told the mutant apart. The measurement is refused whole rather than read.
    test("refuses to count a timeout, an error, or an unfinished mutant as killed", () => {
        const directory = mkdtempSync(join(tmpdir(), "mutation-contaminated-"));
        const survivorsPath = join(directory, "survivors.json");

        for (const status of ["Timeout", "RuntimeError", "CompileError", "Pending"]) {
            const reportPath = join(directory, `${status}.json`);
            writeFileSync(
                reportPath,
                JSON.stringify(reportFor(guardModule, [{ ...guardMutant, status }]))
            );

            const result = runQualitySubprocess(
                process.execPath,
                [
                    checker,
                    "--area",
                    "identity",
                    "--report",
                    reportPath,
                    "--survivors",
                    survivorsPath,
                    "--discrimination",
                    join(directory, "discrimination.json")
                ],
                packageRoot
            );

            expect(result.status).toBe(1);
            expect(result.stderr).toContain("Mutation run contains");
            expect(result.stderr).toContain(`${registeredFile}#1 ${status}`);
            // Nothing downstream ran, so nothing counted the mutant at all.
            expect(existsSync(survivorsPath)).toBe(false);
        }
    });

    // `--report` used to reach the status check without ever being asked whether it was a
    // report of this area at all. A hand-written file of no mutants scored 100%, and the
    // discrimination path defaults to the committed artifact, so it overwrote an area's
    // real kill attribution with nothing. Every source goes through one gate now.
    test("refuses a recorded report that is not a measurement of the area", () => {
        const directory = mkdtempSync(join(tmpdir(), "mutation-invalid-"));
        const survivorsPath = join(directory, "survivors.json");
        const discriminationPath = join(directory, "discrimination.json");
        const cases = {
            "covers no file": { schemaVersion: "2", files: {} },
            "holds no mutant": reportFor(guardModule, []),
            "names no test that killed it": reportFor(guardModule, [
                { ...guardMutant, status: "Killed" }
            ]),
            "no test covers it": reportFor(guardModule, [{ ...guardMutant, status: "Survived" }]),
            // The area check: a perfectly formed report of somewhere else.
            "names src/identity/ref.ts": reportFor(guardModule, [
                {
                    ...guardMutant,
                    status: "Killed",
                    coveredBy: ["t1"],
                    killedBy: ["t1"],
                    testsCompleted: 1
                }
            ])
        };

        for (const [refusal, report] of Object.entries(cases)) {
            const reportPath = join(directory, "report.json");
            writeFileSync(reportPath, JSON.stringify(report));

            const result = runQualitySubprocess(
                process.execPath,
                [
                    checker,
                    "--area",
                    // Every fixture above is keyed at src/identity/ref.ts, so measuring
                    // `actors` is the wrong-area case and `identity` is the rest.
                    refusal === "names src/identity/ref.ts" ? "actors" : "identity",
                    "--report",
                    reportPath,
                    "--survivors",
                    survivorsPath,
                    "--discrimination",
                    discriminationPath
                ],
                packageRoot
            );

            expect(result.status, refusal).toBe(1);
            expect(result.stderr, refusal).toContain(refusal);
            // No survivor record, and above all no discrimination write: that artifact is
            // committed evidence and this report had nothing to put in it.
            expect(existsSync(survivorsPath), refusal).toBe(false);
            expect(existsSync(discriminationPath), refusal).toBe(false);
        }
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

// Reports built here answer to `requireAreaReport`, so a fixture that names a test must
// carry it: the `testFiles` section is assembled from every id the mutants reference, and
// a `Killed` mutant that names no killer is exactly what the validator refuses.
function reportFor(
    source: string,
    mutants: readonly {
        text: string;
        mutator: string;
        replacement: string;
        status: string;
        occurrence?: number;
        coveredBy?: string[];
        killedBy?: string[];
        testsCompleted?: number;
    }[],
    file: string = registeredFile
): MutationReport {
    const named = new Set<string>();
    const report: MutationReport = {
        schemaVersion: "2",
        files: {
            [file]: {
                source,
                mutants: mutants.map((mutant, index): ReportMutant => {
                    let offset = -1;
                    for (let seen = 0; seen <= (mutant.occurrence ?? 0); seen += 1) {
                        offset = source.indexOf(mutant.text, offset + 1);
                    }
                    if (offset === -1) throw new TypeError(`fixture text absent: ${mutant.text}`);
                    const built: ReportMutant = {
                        id: String(index + 1),
                        mutatorName: mutant.mutator,
                        replacement: mutant.replacement,
                        status: mutant.status,
                        location: {
                            start: position(source, offset),
                            end: position(source, offset + mutant.text.length)
                        }
                    };
                    if (mutant.coveredBy !== undefined) built.coveredBy = mutant.coveredBy;
                    if (mutant.killedBy !== undefined) built.killedBy = mutant.killedBy;
                    if (mutant.testsCompleted !== undefined) {
                        built.testsCompleted = mutant.testsCompleted;
                    }
                    for (const id of [...(built.coveredBy ?? []), ...(built.killedBy ?? [])]) {
                        named.add(id);
                    }
                    return built;
                })
            }
        }
    };
    if (named.size === 0) return report;
    return {
        ...report,
        testFiles: {
            "test/fixture.test.ts": {
                tests: [...named].sort().map((id) => ({ id, name: `fixture test ${id}` }))
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

    test("distinguishes detected, undetected, contaminated, invalid, and ignored results", () => {
        expect(mutationOutcome("Killed")).toBe("detected");
        expect(mutationOutcome("Survived")).toBe("undetected");
        expect(mutationOutcome("NoCoverage")).toBe("undetected");
        // The status that used to read as a kill. Stryker times a mutant against the dry
        // run's net time, so a mutant no test can tell apart times out on a loaded machine
        // and arrives labelled like one that looped forever.
        expect(mutationOutcome("Timeout")).toBe("contaminated");
        expect(mutationOutcome("RuntimeError")).toBe("invalid");
        expect(mutationOutcome("CompileError")).toBe("invalid");
        expect(mutationOutcome("Ignored")).toBe("ignored");
        expect(mutationOutcome("Pending")).toBe("incomplete");
        expect(() => mutationOutcome("WorkerExited")).toThrow(/Unknown mutant status/u);
    });

    test("refuses a run that timed out, errored, or never finished", () => {
        for (const status of ["Timeout", "RuntimeError", "CompileError", "Pending"]) {
            const report = reportFor(guardModule, [{ ...guardMutant, status }]);

            expect(unusableMutants(report)).toEqual([`${registeredFile}#1 ${status}`]);
            expect(() => requireCompleteMutationReport(report)).toThrow(
                new RegExp(`Mutation run contains[\\s\\S]*${status}`, "u")
            );
        }

        // The control. Every status that settles something is usable, so the refusal above
        // discriminates contamination rather than rejecting reports at large.
        for (const status of ["Killed", "Survived", "NoCoverage", "Ignored"]) {
            const report = reportFor(guardModule, [{ ...guardMutant, status }]);

            expect(unusableMutants(report)).toEqual([]);
            expect(requireCompleteMutationReport(report)).toBe(report);
        }
    });

    // The survivor that no test ever contradicted because no test ever ran.
    // `toMutantRunResult` calls a completed run with an empty test list Survived, and the
    // vitest runner intermittently executes nothing for a non-empty filter
    // (stryker-js#6073). That verdict is the one the equivalence register can excuse, so a
    // mutant Stryker says is covered whose run completed nothing is refused.
    test("refuses a covered mutant whose run executed no test at all", () => {
        const empty = reportFor(guardModule, [
            { ...guardMutant, status: "Survived", coveredBy: ["7", "8", "9"], testsCompleted: 0 }
        ]);

        expect(unusableMutants(empty)).toEqual([
            `${registeredFile}#1 Survived ran 0 of 3 covering tests`
        ]);
        expect(() => requireCompleteMutationReport(empty)).toThrow(
            /ran 0 of 3 covering tests[\s\S]*empty run is not a survivor/u
        );

        // Two controls the check must not swallow. A survivor whose covering tests all ran
        // is a real survivor, and a NoCoverage mutant has nothing to run by definition.
        expect(
            unusableMutants(
                reportFor(guardModule, [
                    {
                        ...guardMutant,
                        status: "Survived",
                        coveredBy: ["7", "8", "9"],
                        testsCompleted: 3
                    }
                ])
            )
        ).toEqual([]);
        expect(
            unusableMutants(
                reportFor(guardModule, [
                    { ...guardMutant, status: "NoCoverage", coveredBy: [], testsCompleted: 0 }
                ])
            )
        ).toEqual([]);
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

    // The only case here whose cost scales with the source tree: it runs Stryker's real
    // mutant generator over every file the register names — 78 today, 2.4s when this landed
    // and 6.7s once peers had grown those files, which silently crossed vitest's 5s default
    // and reported as a timeout rather than as a register finding. An explicit budget, so
    // the failure that matters is the audit's verdict and never the clock.
    test(
        "resolves every committed entry to exactly one generated mutant",
        { timeout: 90_000 },
        async () => {
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
        }
    );

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

// Reuse is what makes the campaign affordable: measuring `errors`, the smallest area
// there is, costs over three minutes of wall time and four of CPU, and a campaign
// measures the same inputs over and over. Every second of that saving rests on claims a
// hostile reader should be able to break, so the cases below try: an input the key
// forgot, a tree edited while the run was in flight, a record that does not vouch for
// its report, a symlink where the record belongs, two areas at once, and two writers
// under one key.
describe("mutation run reuse", () => {
    const probe = "reuse-probe";
    const probeFile = `src/${probe}/module.ts`;
    const probePattern = `src/${probe}/**/*.ts`;
    // A verdict has to be accounted for now: Killed names a killer and counts an executed
    // test, Survived names a covering test and counts one. Cases below prove each refusal.
    const probeReport = (status: string): MutationReport =>
        reportFor(
            guardModule,
            [{ ...guardMutant, status, coveredBy: ["t1"], killedBy: ["t1"], testsCompleted: 1 }],
            probeFile
        );

    const clearProbe = (area: string): void => {
        rmSync(runCachePath(area), { force: true });
        rmSync(runLedgerPath(area), { force: true });
    };

    const perturbed = (path: string): string => {
        const absolute = resolve(packageRoot, path);
        const original = readFileSync(absolute);
        try {
            writeFileSync(absolute, Buffer.concat([original, Buffer.from("\n")]));
            return mutationRunKey("errors");
        } finally {
            writeFileSync(absolute, original);
        }
    };

    const readLedger = (area: string) =>
        assertObject(
            parseCanonicalJson(readFileSync(runLedgerPath(area), "utf8"), `${area} ledger`),
            `${area} ledger`
        );

    const recordFor = (area: string, runKey: string, report: MutationReport) => ({
        edition: "1.0.0",
        area,
        runKey,
        identity: mutationRunIdentity(),
        measuredAt: "0".repeat(40),
        reportSha256: `sha256:${sha256(JSON.stringify(report))}`,
        report
    });

    test("changes the key when any input a run reads changes", () => {
        const key = mutationRunKey("errors");
        const inputs = [
            "src/errors.ts",
            // Not in the area, and still an input: the tests that kill an `errors` mutant
            // run this module, so its behavior decides their verdict.
            "src/actors/actor.ts",
            "test/actors/actor.test.ts",
            // Not TypeScript, and read by the executed suite all the same: the conformance
            // and integration lanes open the spec, the request archive, and the committed
            // record index, and Stryker copies the tsconfig into its sandbox.
            "SPEC.md",
            "tsconfig.json",
            "artifacts/quality/mutation-equivalence.json",
            "artifacts/integration/request-archive/W5/ownership.json",
            "artifacts/records/index.json",
            // The runner's own revision. A change to how a verdict is classified changes
            // the verdict, and nothing else here would notice.
            "scripts/quality/mutation.mjs",
            "scripts/quality/mutation-run.mjs",
            "package.json",
            "stryker.conf.mjs",
            "vitest.config.mjs",
            "vitest.mutation.config.mjs",
            "scripts/vitest-bun-test.mjs",
            "scripts/vitest-bun-sqlite.mjs",
            "../../pnpm-lock.yaml"
        ];

        for (const path of inputs) {
            expect(perturbed(path), `${path} must not be reusable across a change`).not.toBe(key);
        }

        // The register decides which survivors count, so its slice for this area is an
        // input like any file.
        expect(mutationRunKey("errors", [])).not.toBe(
            mutationRunKey("errors", [
                {
                    file: "src/errors.ts",
                    symbol: "invariant",
                    mutator: "ConditionalExpression",
                    replacement: "false",
                    mutated: "!condition",
                    proof: proofFor("invariant")
                }
            ])
        );

        // Every perturbation above was restored, so the key is where it started.
        expect(mutationRunKey("errors")).toBe(key);
    });

    // A run is not only the tree. The same bytes under a different interpreter, a
    // different Stryker, or AGENT_CORE_ENFORCEMENT set — which resolves every import of
    // src/facets/enforcement to the TSLean-lowered twin — is a different measurement.
    test("changes the key when the runtime it executes under changes", () => {
        const key = mutationRunKey("errors");
        const identity = mutationRunIdentity();

        expect(identity.node).toBe(process.version);
        expect(identity.abi).toBe(process.versions.modules);
        expect(identity.platform).toBe(`${process.platform}-${process.arch}`);
        // Every tool whose code decides a verdict is named, and named at its installed
        // version rather than at the range the manifest asked for.
        for (const name of [
            "@stryker-mutator/core",
            "@stryker-mutator/instrumenter",
            "@stryker-mutator/vitest-runner",
            "@vitest/coverage-v8",
            "typescript",
            "vite",
            "vitest"
        ]) {
            const manifest = assertObject(
                parseCanonicalJson(
                    readFileSync(
                        resolve(packageRoot, "node_modules", name, "package.json"),
                        "utf8"
                    ),
                    name
                ),
                name
            );
            expect(identity.packages[name], name).toBe(assertString(manifest["version"], name));
        }

        const enforcement = "AGENT_CORE_ENFORCEMENT";
        const restore = process.env[enforcement];
        try {
            process.env[enforcement] = "generated";
            // The name is recorded; the value is not. Bound names are matched by prefix,
            // and STRYKER_DASHBOARD_API_KEY is a real Stryker variable.
            expect(mutationRunIdentity().environment[enforcement]).toBe(
                `sha256:${sha256("generated")}`
            );
            expect(mutationRunKey("errors")).not.toBe(key);
        } finally {
            if (restore === undefined) delete process.env[enforcement];
            else process.env[enforcement] = restore;
        }

        expect(mutationRunKey("errors")).toBe(key);
    });

    // A credentialed shell must not be able to leave a token on disk for the rest of the
    // campaign. The identity binds the variable so the key moves, and records a digest so
    // nothing that lands in reports/ carries the value.
    test("never writes an environment value it binds", async () => {
        const secret = "sentinel-a1b2c3-never-on-disk";
        const name = "STRYKER_DASHBOARD_API_KEY";
        const restore = process.env[name];
        const before = mutationRunKey("errors");
        clearProbe(probe);
        try {
            process.env[name] = secret;
            expect(mutationRunKey("errors")).not.toBe(before);
            await measureArea(probe, probePattern, () => ({
                report: probeReport("Survived"),
                measuredAt: "sentinel-head",
                strykerMs: 1
            }));

            for (const path of [runLedgerPath(probe), runCachePath(probe)]) {
                const written = readFileSync(path, "utf8");
                expect(written, path).not.toContain(secret);
                expect(written, path).toContain(name);
                expect(written, path).toContain(sha256(secret));
            }
        } finally {
            if (restore === undefined) delete process.env[name];
            else process.env[name] = restore;
            clearProbe(probe);
        }
    });
    // The Bun fixture forwards the complete environment to its external runtime. That
    // includes Bun's own config/cache/runtime namespace, so BUN_* needs the same closure
    // and redaction as STRYKER_* — otherwise a cache survives a changed Bun subprocess.
    test("binds a BUN variable without persisting its raw value", async () => {
        const secret = "bun-config-secret-never-on-disk";
        const name = "BUN_SENTINEL_RUNTIME";
        const restore = process.env[name];
        const before = mutationRunKey("errors");
        clearProbe(probe);
        try {
            process.env[name] = secret;
            expect(mutationRunIdentity().environment[name]).toBe(`sha256:${sha256(secret)}`);
            expect(mutationRunKey("errors")).not.toBe(before);
            await measureArea(probe, probePattern, () => ({
                report: probeReport("Survived"),
                measuredAt: "bun-env-head",
                strykerMs: 1
            }));

            for (const path of [runLedgerPath(probe), runCachePath(probe)]) {
                const written = readFileSync(path, "utf8");
                expect(written, path).not.toContain(secret);
                expect(written, path).toContain(name);
                expect(written, path).toContain(sha256(secret));
            }
        } finally {
            if (restore === undefined) delete process.env[name];
            else process.env[name] = restore;
            clearProbe(probe);
        }
    });

    // The mutation lane contains materialization-bun.test.ts, which launches bare `bun`.
    // The external runtime is not Node, and a package lock cannot identify it. Resolution
    // changes with PATH, a different binary at the same version changes with its identity,
    // and its absence changes the test's result; all three must stale reuse. Raw PATH must
    // not land in a ledger or a cache record, because it commonly names private mounts.
    test("binds Bun resolution without persisting raw PATH", async () => {
        const root = mkdtempSync(join(packageRoot, "reports/mutation/bun-runtime-"));
        const first = join(root, "first");
        const second = join(root, "second");
        const missing = join(root, "missing");
        const sentinel = join(root, "bun-path-secret-never-on-disk");
        const prior = process.env["PATH"];
        const install = (directory: string, version: string): void => {
            mkdirSync(directory, { recursive: true });
            const executable = join(directory, "bun");
            writeFileSync(executable, `#!/bin/sh\nprintf '%s\n' '${version}'\n`);
            chmodSync(executable, 0o700);
        };
        const withBun = (directory: string): void => {
            process.env["PATH"] = `${directory}${delimiter}${prior ?? ""}`;
        };

        try {
            install(first, "9.0.0");
            withBun(first);
            const firstIdentity = mutationRunIdentity();
            const firstKey = mutationRunKey("errors");
            expect(firstIdentity.bun.state).toBe("present");
            expect(firstIdentity.bun.version).toBe("9.0.0");

            // Same version, different resolved executable. PATH resolution itself is an
            // input, not merely a way to find a version string.
            install(second, "9.0.0");
            withBun(second);
            const secondIdentity = mutationRunIdentity();
            const secondKey = mutationRunKey("errors");
            expect(secondIdentity.bun.version).toBe("9.0.0");
            expect(secondIdentity.bun.resolution).not.toBe(firstIdentity.bun.resolution);
            expect(secondKey).not.toBe(firstKey);

            // Same path, changed Bun release.
            install(second, "9.0.1");
            const upgradedKey = mutationRunKey("errors");
            expect(mutationRunIdentity().bun.version).toBe("9.0.1");
            expect(upgradedKey).not.toBe(secondKey);

            // No Bun in resolution is a distinct state; the included test would fail
            // rather than execute its native SQLite fixture.
            process.env["PATH"] = missing;
            const absentKey = mutationRunKey("errors");
            expect(mutationRunIdentity().bun.state).toBe("absent");
            expect(absentKey).not.toBe(upgradedKey);

            // A sentinel raw PATH is deliberately never persisted. The name appears only
            // inside its digest and must be absent from both durable records.
            install(sentinel, "9.0.2");
            withBun(sentinel);
            clearProbe(probe);
            await measureArea(probe, probePattern, () => ({
                report: probeReport("Survived"),
                measuredAt: "bun-head",
                strykerMs: 1
            }));
            for (const path of [runLedgerPath(probe), runCachePath(probe)]) {
                const written = readFileSync(path, "utf8");
                expect(written, path).not.toContain("bun-path-secret-never-on-disk");
                expect(written, path).toContain(sha256(process.env["PATH"] ?? ""));
            }
        } finally {
            if (prior === undefined) delete process.env["PATH"];
            else process.env["PATH"] = prior;
            clearProbe(probe);
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("holds the key across a change no mutation run can read", () => {
        const key = mutationRunKey("errors");
        const sibling = resolve(packageRoot, "../agent-core-cloudflare/package.json");

        // Stryker crawls this package and prunes what stryker.conf.mjs names, so its
        // sandbox holds none of these; the crawl is rooted here, so a sibling package is
        // outside it entirely. A key that moved for any of them would stale every area for
        // a result that cannot have changed — and for reports/ it would stale the area on
        // the runner's own output, which is the cache invalidating itself.
        for (const offset of [
            "reports/mutation/reuse-probe.scratch",
            "dist/reuse-probe.js",
            "formal/.lake/reuse-probe.olean"
        ]) {
            const path = resolve(packageRoot, offset);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, "scratch\n");
            try {
                expect(mutationRunKey("errors"), offset).toBe(key);
            } finally {
                rmSync(path, { force: true });
            }
        }

        const original = readFileSync(sibling);
        try {
            writeFileSync(sibling, Buffer.concat([original, Buffer.from("\n")]));
            expect(mutationRunKey("errors")).toBe(key);
        } finally {
            writeFileSync(sibling, original);
        }
    });

    // The two places an approximate mirror of Stryker's crawl goes wrong, both of them in
    // the unsafe direction: it would omit from the key a file Stryker copies.
    test("mirrors the crawl where a loose reading of it would not", () => {
        const key = mutationRunKey("errors");

        // `/reports` and `/dist` are anchored at the crawl root. Read as bare names they
        // would prune a nested directory that Stryker copies.
        for (const offset of ["src/reports/nested.ts", "src/dist/nested.ts"]) {
            const path = resolve(packageRoot, offset);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, "export const nested = 1;\n");
            try {
                expect(mutationRunKey("errors"), offset).not.toBe(key);
            } finally {
                rmSync(dirname(path), { recursive: true, force: true });
            }
        }

        // `readdir` does not follow links, so Stryker's `dirent.isDirectory()` is false for
        // a symlink and it copies it as a file. Skipping it here would leave a file in the
        // sandbox that the key never saw.
        const link = resolve(packageRoot, "src/reuse-probe-link.ts");
        symlinkSync(resolve(packageRoot, "src/errors.ts"), link);
        try {
            expect(mutationRunKey("errors")).not.toBe(key);
        } finally {
            rmSync(link, { force: true });
        }

        expect(mutationRunKey("errors")).toBe(key);
    });

    // The mirror is read from one Stryker version's crawl, and neither the crawl nor its
    // ignore semantics are API. An unreadable ignore pattern would silently drop files
    // from the key, which is the one thing the key exists not to do.
    test("refuses an ignore pattern it cannot mirror exactly", () => {
        const config = resolve(packageRoot, "stryker.conf.mjs");
        const original = readFileSync(config);
        try {
            writeFileSync(
                config,
                original
                    .toString("utf8")
                    .replace('ignorePatterns: ["/reports"', 'ignorePatterns: ["src/**/*.spec.ts"')
            );
            const result = runQualitySubprocess(
                process.execPath,
                ["--input-type=module", "-e", refuseUnmirrorable],
                packageRoot
            );

            expect(result.stdout).toContain("cannot mirror the Stryker ignore pattern");
        } finally {
            writeFileSync(config, original);
        }
    });

    test("serves a recorded report only under the key it was recorded with", () => {
        const report = probeReport("Survived");
        clearProbe(probe);
        try {
            publishRunCache(probe, recordFor(probe, "sha256:recorded", report));

            expect(readRunCache(probe, "sha256:recorded")).toEqual({
                reused: { report, measuredAt: "0".repeat(40), strykerMs: 0 }
            });
            expect(readRunCache(probe, "sha256:something-else")).toEqual({
                rejected: "cache record was written under a different run key"
            });
        } finally {
            clearProbe(probe);
        }

        expect(readRunCache(probe, "sha256:recorded")).toEqual({});
    });

    // Every one of these is a record that exists and must not be believed. Absence is the
    // right answer to all of them, because re-measuring is always safe.
    test("treats a torn, mis-digested, or foreign record as absent", () => {
        const path = runCachePath(probe);
        const report = probeReport("Survived");
        const cases = {
            "cache record does not parse": JSON.stringify(recordFor(probe, "k", report)).slice(
                0,
                200
            ),
            "cache record edition": JSON.stringify({
                ...recordFor(probe, "k", report),
                edition: "2.0.0"
            }),
            "cache record names area": JSON.stringify(recordFor("elsewhere", "k", report)),
            "cache record and its report disagree": JSON.stringify({
                ...recordFor(probe, "k", report),
                reportSha256: `sha256:${"0".repeat(64)}`
            }),
            "cache record names a different runtime identity": JSON.stringify({
                ...recordFor(probe, "k", report),
                identity: {
                    ...mutationRunIdentity(),
                    bun: { ...mutationRunIdentity().bun, version: "other-bun" }
                }
            }),
            // The one the shared report path used to allow: a real, self-consistent
            // record whose report describes a different area entirely.
            "cached report is unusable": JSON.stringify(
                recordFor(
                    probe,
                    "k",
                    reportFor(guardModule, [{ ...guardMutant, status: "Killed" }])
                )
            )
        };

        mkdirSync(dirname(path), { recursive: true });
        try {
            for (const [reason, contents] of Object.entries(cases)) {
                writeFileSync(path, contents);
                const read = readRunCache(probe, "k");

                expect(read.reused, reason).toBeUndefined();
                expect(read.rejected, reason).toContain(reason);
            }
        } finally {
            clearProbe(probe);
        }
    });

    // The trap a second definition of "usable record" set: an edition this reader refuses
    // was still a rival to the publisher, which found a matching key and digest, called it
    // converged, and left the unreadable record in place for every run that followed. One
    // predicate now answers both, so meeting it repairs it.
    test("replaces a record its reader would refuse instead of converging on it", () => {
        const path = runCachePath(probe);
        const record = recordFor(probe, "sha256:envelope", probeReport("Survived"));
        clearProbe(probe);
        mkdirSync(dirname(path), { recursive: true });
        // Self-consistent in every way the publisher used to look at, and unreadable.
        writeFileSync(path, JSON.stringify({ ...record, edition: "2.0.0" }));
        try {
            expect(readRunCache(probe, "sha256:envelope").rejected).toContain(
                "cache record edition"
            );
            expect(publishRunCache(probe, record)).toBe("published");
            expect(readRunCache(probe, "sha256:envelope").reused).toBeDefined();
        } finally {
            clearProbe(probe);
        }

        // The same for an envelope missing its runtime identity.
        clearProbe(probe);
        mkdirSync(dirname(path), { recursive: true });
        const { identity: _dropped, ...faceless } = record;
        writeFileSync(path, JSON.stringify(faceless));
        try {
            expect(readRunCache(probe, "sha256:envelope").rejected).toContain(
                "names no runtime identity"
            );
            expect(publishRunCache(probe, record)).toBe("published");
            expect(readRunCache(probe, "sha256:envelope").reused).toBeDefined();
        } finally {
            clearProbe(probe);
        }
    });

    // `reconcileEquivalence` keys its resolution by `mutant.id` alone and mutation.mjs
    // reads it back the same way, so two files sharing an id would let one proof excuse the
    // other file's mutant. Per-file uniqueness would have missed it.
    test("refuses one mutant identity used in two files", () => {
        const here = probeReport("Survived");
        // Two files, each numbering its own mutants from one, as Stryker's report does.
        const there = reportFor(
            guardModule,
            [{ ...guardMutant, status: "Survived", coveredBy: ["t1"], testsCompleted: 1 }],
            `src/${probe}/other.ts`
        );
        const collided = { ...here, files: { ...here.files, ...there.files } };

        expect(() => requireAreaReport(collided, probe)).toThrow(/names two mutants 1/u);
    });

    test("refuses a symbolic link where its record belongs", () => {
        const path = runCachePath(probe);
        const target = resolve(packageRoot, "reports/mutation/reuse-probe.target");
        clearProbe(probe);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(target, JSON.stringify(recordFor(probe, "k", probeReport("Survived"))));
        symlinkSync(target, path);
        try {
            expect(() => readRunCache(probe, "k")).toThrow(/is a symbolic link/u);
            expect(() =>
                publishRunCache(probe, recordFor(probe, "k", probeReport("Survived")))
            ).toThrow(/is a symbolic link/u);
        } finally {
            rmSync(path, { force: true });
            rmSync(target, { force: true });
            clearProbe(probe);
        }
    });

    // Checking the leaf alone leaves the interesting substitution unguarded: a link one
    // directory up redirects every record this runner writes, and the leaf looks like an
    // ordinary file the whole time.
    test("refuses a symbolic link anywhere above its record", () => {
        const cache = dirname(runCachePath(probe));
        const elsewhere = resolve(packageRoot, "reports/mutation/reuse-probe-elsewhere");
        clearProbe(probe);
        rmSync(cache, { recursive: true, force: true });
        mkdirSync(elsewhere, { recursive: true });
        symlinkSync(elsewhere, cache);
        try {
            expect(() => readRunCache(probe, "k")).toThrow(/is a symbolic link/u);
            expect(() =>
                publishRunCache(probe, recordFor(probe, "k", probeReport("Survived")))
            ).toThrow(/is a symbolic link/u);
        } finally {
            rmSync(cache, { force: true });
            rmSync(elsewhere, { recursive: true, force: true });
        }
    });

    // Two processes that genuinely overlap. `spawnSync` in a loop proves nothing — the
    // first child spins, publishes and exits before the second is created — so both are
    // started with async `spawn` and only then awaited, and each waits on a barrier file
    // this process creates once both are alive. The record is created with `link`, which
    // never replaces, so exactly one wins; the loser reads the winner's record and, since
    // the reports disagree under one key, says so instead of dropping the disagreement.
    test("lets one of two simultaneous writers publish and makes the other say so", async () => {
        const barrier = resolve(packageRoot, "reports/mutation/reuse-probe.barrier");
        clearProbe(probe);
        mkdirSync(dirname(barrier), { recursive: true });
        rmSync(barrier, { force: true });
        const publisher = (status: string): string =>
            [
                `const { publishRunCache } = await import(${JSON.stringify(runModule)});`,
                `const { mutationRunIdentity } = await import(${JSON.stringify(inputsModule)});`,
                `const { sha256 } = await import(${JSON.stringify(projectModule)});`,
                'const { existsSync } = await import("node:fs");',
                `const report = ${JSON.stringify(probeReport(status))};`,
                "const record = {",
                '    edition: "1.0.0",',
                `    area: ${JSON.stringify(probe)},`,
                '    runKey: "sha256:contested",',
                "    identity: mutationRunIdentity(),",
                `    measuredAt: ${JSON.stringify("0".repeat(40))},`,
                "    reportSha256: `sha256:${sha256(JSON.stringify(report))}`,",
                "    report",
                "};",
                "console.log('ready');",
                // Everything expensive is behind us; from here to the create is a few
                // instructions, and both children arrive at it together.
                `while (!existsSync(${JSON.stringify(barrier)})) {}`,
                "try {",
                `    console.log(publishRunCache(${JSON.stringify(probe)}, record));`,
                "} catch (error) {",
                "    console.log(`refused: ${error.message}`);",
                "}"
            ].join("\n");

        try {
            const children = ["Survived", "Killed"].map((status) =>
                spawn(process.execPath, ["--input-type=module", "-e", publisher(status)], {
                    cwd: packageRoot,
                    stdio: ["ignore", "pipe", "pipe"]
                })
            );
            const said = children.map(
                (child) =>
                    new Promise<string>((settle, fail) => {
                        let out = "";
                        child.stdout.setEncoding("utf8");
                        child.stdout.on("data", (chunk: string) => {
                            out += chunk;
                        });
                        child.on("error", fail);
                        child.on("close", () => settle(out));
                    })
            );
            // Both are alive and past their imports before the barrier drops, so the
            // contended window is the create itself and nothing before it.
            await Promise.all(
                children.map(
                    (child) =>
                        new Promise<void>((settle) => {
                            const wait = (chunk: Buffer | string): void => {
                                if (String(chunk).includes("ready")) settle();
                            };
                            child.stdout.on("data", wait);
                        })
                )
            );
            writeFileSync(barrier, "");
            const outcomes = (await Promise.all(said))
                .map((out) => out.replace("ready\n", "").trim())
                .sort();

            expect(outcomes.filter((line) => line === "published")).toHaveLength(1);
            expect(outcomes.filter((line) => line.startsWith("refused:"))).toHaveLength(1);
            expect(outcomes.join("\n")).toContain("under run key sha256:contested disagree");
            // Exactly one authoritative record, and it reads back whole.
            expect(readRunCache(probe, "sha256:contested").reused).toBeDefined();
        } finally {
            rmSync(barrier, { force: true });
            clearProbe(probe);
        }
    });

    // A lock left by a crash was the reason to have no lock. This kills a real writer
    // after it has written its temp file and before it can create the record, then proves
    // the next writer publishes anyway: the only residue a crash can leave is a temp
    // nothing reads, and there is nothing to steal or time out.
    test("publishes after a writer is killed mid-publication", async () => {
        const path = runCachePath(probe);
        clearProbe(probe);
        mkdirSync(dirname(path), { recursive: true });
        const doomed = spawn(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                [
                    'const { openSync, writeFileSync, closeSync } = await import("node:fs");',
                    // The same temp shape publishRunCache uses, written by a process that
                    // then dies before it can link.
                    `const temp = ${JSON.stringify(join(dirname(path), `.${basename(path)}.`))}` +
                        " + process.pid + '.abandoned';",
                    'const handle = openSync(temp, "wx", 0o600);',
                    'writeFileSync(handle, "{}");',
                    "closeSync(handle);",
                    "console.log(temp);",
                    // Held open on stdin rather than a timer: no clock in the test, and the
                    // process dies the instant it is signalled.
                    "process.stdin.resume();"
                ].join("\n")
            ],
            { cwd: packageRoot, stdio: ["pipe", "pipe", "pipe"] }
        );
        const orphan = await new Promise<string>((settle, fail) => {
            doomed.stdout.setEncoding("utf8");
            doomed.stdout.on("data", (chunk: string) => settle(chunk.trim()));
            doomed.on("error", fail);
        });
        doomed.kill("SIGKILL");

        try {
            expect(existsSync(orphan)).toBe(true);
            expect(
                publishRunCache(
                    probe,
                    recordFor(probe, "sha256:after-crash", probeReport("Survived"))
                )
            ).toBe("published");
            expect(readRunCache(probe, "sha256:after-crash").reused).toBeDefined();
        } finally {
            rmSync(orphan, { force: true });
            clearProbe(probe);
        }
    });

    // Verdicts and identities the classifier would credit with nothing behind them.
    // `killed / mutants` is the score and `killedBy` is what the discrimination artifact is
    // built from, so each of these buys credit for free.
    test("refuses a report, a verdict, or a test identity with no evidence behind it", () => {
        const refusals = [
            ["no file", { schemaVersion: "2", files: {} }, /covers no file/u],
            // Per file an empty mutant list is ordinary; across the report it is a
            // measurement of nothing wearing a perfect score.
            ["no mutant", reportFor(guardModule, [], probeFile), /holds no mutant/u],
            [
                "kill nobody claims",
                reportFor(guardModule, [{ ...guardMutant, status: "Killed" }], probeFile),
                /Killed and names no test that killed it/u
            ],
            [
                "kill that ran nothing",
                reportFor(
                    guardModule,
                    [
                        {
                            ...guardMutant,
                            status: "Killed",
                            coveredBy: ["t1"],
                            killedBy: ["t1"],
                            testsCompleted: 0
                        }
                    ],
                    probeFile
                ),
                /Killed having executed 0 of the 1 tests that cover it/u
            ],
            // A filtered run that executed some of its tests is no more conclusive than
            // one that executed none: the survivor might have been killed by the test
            // that never ran, and the kill's killedBy is taken as complete.
            [
                "kill that ran part of its filter",
                reportFor(
                    guardModule,
                    [
                        {
                            ...guardMutant,
                            status: "Killed",
                            coveredBy: ["t1", "t2"],
                            killedBy: ["t1"],
                            testsCompleted: 1
                        }
                    ],
                    probeFile
                ),
                /Killed having executed 1 of the 2 tests that cover it/u
            ],
            [
                "survivor that ran part of its filter",
                reportFor(
                    guardModule,
                    [
                        {
                            ...guardMutant,
                            status: "Survived",
                            coveredBy: ["t1", "t2"],
                            testsCompleted: 1
                        }
                    ],
                    probeFile
                ),
                /Survived having executed 1 of the 2 tests that cover it/u
            ],
            [
                "survivor nothing covers",
                reportFor(guardModule, [{ ...guardMutant, status: "Survived" }], probeFile),
                /Survived and no test covers it/u
            ],
            [
                "survivor that ran nothing",
                reportFor(
                    guardModule,
                    [{ ...guardMutant, status: "Survived", coveredBy: ["t1"], testsCompleted: 0 }],
                    probeFile
                ),
                /Survived having executed 0 of the 1 tests that cover it/u
            ],
            [
                "unknown status",
                reportFor(guardModule, [{ ...guardMutant, status: "WorkerExited" }], probeFile),
                /Unknown mutant status/u
            ]
        ] as const;

        for (const [named, report, refusal] of refusals) {
            expect(() => requireAreaReport(report, probe), named).toThrow(refusal);
        }

        // Test identities `String()` would have coerced into a key a killedBy can match.
        // These arrive the only way a malformed report ever does — as bytes on disk — so
        // they are driven through the reader rather than constructed in typed code.
        const path = runCachePath(probe);
        mkdirSync(dirname(path), { recursive: true });
        const identities = {
            "unidentified test": [{ id: 1, name: "n" }],
            "has no name": [{ id: "t1" }],
            "two tests t1": [
                { id: "t1", name: "a" },
                { id: "t1", name: "b" }
            ]
        };
        try {
            for (const [refusal, tests] of Object.entries(identities)) {
                const report = {
                    ...probeReport("Killed"),
                    testFiles: { "test/fixture.test.ts": { tests } }
                };
                writeFileSync(
                    path,
                    JSON.stringify({
                        edition: "1.0.0",
                        area: probe,
                        runKey: "k",
                        identity: mutationRunIdentity(),
                        measuredAt: "0".repeat(40),
                        reportSha256: `sha256:${sha256(JSON.stringify(report))}`,
                        report
                    })
                );

                expect(readRunCache(probe, "k").rejected, refusal).toContain(refusal);
            }
        } finally {
            clearProbe(probe);
        }

        // The control: a fixture with a claimant, an executed test and a named identity.
        expect(requireAreaReport(probeReport("Killed"), probe)).toBeDefined();
    });

    test("accepts a complete filter that also executed a noncovering test", () => {
        const report = reportFor(
            guardModule,
            [
                {
                    ...guardMutant,
                    status: "Killed",
                    coveredBy: ["t1"],
                    killedBy: ["t1"],
                    testsCompleted: 2
                }
            ],
            probeFile
        );
        expect(requireAreaReport(report, probe)).toBeDefined();
    });

    // The race the key alone cannot settle: two runs of identical inputs finish at once.
    // Agreeing is fine and must be idempotent; disagreeing is a finding, and resolving it
    // by whoever renamed last would bury it.
    test("converges on agreeing writers and refuses disagreeing ones", () => {
        const record = recordFor(probe, "sha256:contended", probeReport("Survived"));
        clearProbe(probe);
        try {
            expect(publishRunCache(probe, record)).toBe("published");
            expect(publishRunCache(probe, record)).toBe("converged");
            expect(() =>
                publishRunCache(probe, recordFor(probe, "sha256:contended", probeReport("Killed")))
            ).toThrow(/under run key sha256:contended disagree/u);

            // A record that cannot vouch for its own report holds no evidence to lose, so
            // it is replaced rather than treated as a rival measurement.
            writeFileSync(runCachePath(probe), "{ not json");
            expect(publishRunCache(probe, record)).toBe("published");
        } finally {
            clearProbe(probe);
        }
    });

    test("refuses a measurement whose inputs moved while it ran", async () => {
        const intruder = resolve(packageRoot, "reuse-probe-input.ts");
        clearProbe(probe);
        try {
            await expect(
                measureArea(probe, probePattern, (area) => {
                    // An untracked file git does not ignore is an input the moment it
                    // exists, so this is the tree changing under a run in flight.
                    writeFileSync(intruder, "export const probe = 1;\n");
                    return {
                        report: probeReport("Survived"),
                        measuredAt: `${area}-head`,
                        strykerMs: 1
                    };
                })
            ).rejects.toThrow(/changed while it was measured/u);

            // Refused, and not silently: the ledger names both keys, and nothing was
            // recorded for reuse.
            const ledger = readLedger(probe);
            expect(assertString(ledger["runKey"], "runKey")).not.toBe(
                assertString(ledger["settledKey"], "settledKey")
            );
            expect(existsSync(runCachePath(probe))).toBe(false);
        } finally {
            rmSync(intruder, { force: true });
            clearProbe(probe);
        }
    });

    // The committed config names one report file and deletes its whole temp directory on
    // success, so two areas at once used to be able to read and delete each other's work.
    test("keeps two areas measured at once out of each other's records", async () => {
        const second = "reuse-probe-two";
        const reports = {
            [probe]: probeReport("Survived"),
            [second]: reportFor(
                guardModule,
                [
                    {
                        ...guardMutant,
                        status: "Killed",
                        coveredBy: ["t2"],
                        killedBy: ["t2"],
                        testsCompleted: 1
                    }
                ],
                `src/${second}/module.ts`
            )
        };
        clearProbe(probe);
        clearProbe(second);
        try {
            await Promise.all(
                Object.entries(reports).map(([area, report]) =>
                    measureArea(area, `src/${area}/**/*.ts`, () => ({
                        report,
                        measuredAt: `${area}-head`,
                        strykerMs: 1
                    }))
                )
            );

            for (const [area, report] of Object.entries(reports)) {
                const key = mutationRunKey(area);
                expect(readRunCache(area, key).reused?.report, area).toEqual(report);
                const ledger = readLedger(area);
                expect(assertString(ledger["area"], "area")).toBe(area);
                expect(assertString(ledger["measuredAt"], "measuredAt")).toBe(`${area}-head`);
            }
        } finally {
            clearProbe(probe);
            clearProbe(second);
        }
    });
});
