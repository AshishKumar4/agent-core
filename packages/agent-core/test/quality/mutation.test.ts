import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
    auditEquivalenceAnchors,
    readEquivalenceRegister,
    reconcileEquivalence,
    type EquivalenceEntry,
    type MutationReport,
    type ReportMutant
} from "../../scripts/quality/mutation-equivalence.mjs";
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

function gateFixture(
    stage: "building" | "final",
    areas: Record<string, unknown>,
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

function position(source: string, offset: number): { line: number; column: number } {
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
});

// The reconciler only speaks when an area is measured. This is what runs on every quality
// gate, so a proof cannot quietly outlive the code it was written about.
describe("mutation equivalence anchors", () => {
    const areas = sourceAreas();
    const readSource = (file: string): string | undefined => {
        const path = resolve(packageRoot, file);
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    };

    test("resolves every committed entry to exactly one site in the current tree", () => {
        const register = readEquivalenceRegister(
            JSON.parse(
                readFileSync(
                    resolve(packageRoot, "artifacts/quality/mutation-equivalence.json"),
                    "utf8"
                )
            )
        );

        expect(register.length).toBeGreaterThan(0);
        expect(auditEquivalenceAnchors(register, areas, readSource)).toEqual([]);
    });

    test("names the entry when its file, area, symbol, or anchor has moved on", () => {
        const entry = {
            file: "src/identity/scope.ts",
            symbol: "encodeScopeRef",
            mutator: "ConditionalExpression",
            replacement: "false",
            mutated: "scope.projectId === undefined",
            proof: proofFor("encodeScopeRef")
        };

        expect(
            auditEquivalenceAnchors([{ ...entry, file: "src/nowhere/gone.ts" }], areas, readSource)
        ).toEqual([expect.stringContaining("names a file outside the measured areas")]);
        expect(
            auditEquivalenceAnchors([{ ...entry, file: "src/identity/gone.ts" }], areas, readSource)
        ).toEqual([expect.stringContaining("names a missing file")]);
        expect(
            auditEquivalenceAnchors([{ ...entry, symbol: "encodeScope" }], areas, readSource)
        ).toEqual([expect.stringContaining("names a symbol that no longer exists")]);
        expect(
            auditEquivalenceAnchors(
                [{ ...entry, mutated: "scope.projectId === null" }],
                areas,
                readSource
            )
        ).toEqual([expect.stringContaining("anchors 0 sites in its symbol, not one")]);
        expect(
            auditEquivalenceAnchors([{ ...entry, mutated: "kind: scope.kind" }], areas, readSource)
        ).toEqual([expect.stringContaining("anchors 3 sites in its symbol, not one")]);
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
