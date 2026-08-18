import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    assertArray,
    assertObject,
    assertString,
    type JsonValue
} from "../../scripts/quality/project.mjs";
import {
    DeploymentId,
    DeploymentKey,
    DeploymentRecord,
    FailClosedRunPinsReservationPort,
    PackageId,
    RunPinEvidence,
    selectPlacement
} from "../../src/definition";
import { MemoryPackageStore } from "../../src/definition/memory";
import { TenantId } from "../../src/identity";

const packageRoot = resolve(import.meta.dirname, "../..");

describe("W4 error taxonomy", () => {
    test("classifies every W4 throw site without bare errors", { tags: "p2", timeout: 120_000 }, () => {
        const result = spawnSync(
            process.execPath,
            [resolve(packageRoot, "artifacts/quality/check-w4-error-taxonomy.mjs")],
            { cwd: packageRoot, encoding: "utf8" }
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Integrated W4 error taxonomy verified");
        const taxonomy = JSON.parse(
            readFileSync(resolve(packageRoot, "artifacts/quality/w4-error-taxonomy.json"), "utf8")
        );
        expect(taxonomy.edition).toBe("3.0.0");
        expect(taxonomy.allowedTypeErrorSites).toHaveLength(170);
        expect(taxonomy.allowedTypeErrorSites[0]).toEqual({
            declarationSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            file: expect.stringMatching(/^src\/.+\.ts$/u),
            symbol: expect.any(String),
            statementSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            occurrence: expect.any(Number)
        });
        expect(taxonomy.expected).toEqual({
            agentCoreOperationalThrows: 241,
            allowedTypeErrors: 170,
            preservedRethrows: 1,
            bareErrors: 0
        });
        expect(taxonomy.expectedOperationalByCode).toEqual({
            "codec.invalid": 113,
            "operation.invalid-input": 35,
            "protocol.invalid-envelope": 5,
            "protocol.invalid-state": 71,
            "protocol.revision-conflict": 17
        });
    });

    test("uses closed codes for unavailable pins and invalid evidence", { tags: "p2" }, () => {
        const port = new FailClosedRunPinsReservationPort<undefined>();
        expectOperational(() => port.reserve(), "protocol.invalid-state");
        expectOperational(
            () =>
                selectPlacement({
                    manifest: [],
                    policy: ["dynamic"],
                    substrate: ["dynamic"],
                    trust: ["dynamic"]
                }),
            "operation.invalid-input"
        );
        const deployment = DeploymentRecord.initial(
            new TenantId("tenant"),
            new DeploymentKey("platform")
        );
        expectOperational(
            () => deployment.begin(Digest.sha256(new Uint8Array()), 2),
            "protocol.revision-conflict"
        );
        expectOperational(
            () =>
                new MemoryPackageStore({
                    releases: [
                        {
                            packageId: forgedPackageId(""),
                            version: "1.0.0",
                            manifestDigest: "0".repeat(64),
                            codeDigest: "0".repeat(64),
                            bytes: new Uint8Array([0])
                        }
                    ],
                    snapshots: [],
                    locks: []
                }),
            "codec.invalid"
        );
        expect(() => new RunPinEvidence("clear", ["run"])).toThrow(TypeError);
        expect(() => new DeploymentId("bad")).toThrow(TypeError);
        expect(new ActorRef("tenant", new ActorId("tenant")).id.value).toBe("tenant");
    });

    test("binds a permit to declaration semantics but not formatting", { tags: "p2" }, () => {
        const original = fingerprint(`
function requireObject(value: unknown, subject: string): void {
    if (typeof value !== "object") throw new TypeError(\`\${subject} must be an object\`);
}
`);
        const reformatted = fingerprint(`
function requireObject(value: unknown, subject: string): void {
    // Formatting and comments do not reopen the review.
    if (typeof value !== "object")
        throw new TypeError(\`\${subject} must be an object\`);
}
`);
        const changedGuard = fingerprint(`
function requireObject(value: unknown, subject: string): void {
    if (typeof value !== "object" && subject.length > 0)
        throw new TypeError(\`\${subject} must be an object\`);
}
`);

        expect(reformatted).toEqual(original);
        expect(changedGuard.statementSha256).toBe(original.statementSha256);
        expect(changedGuard.declarationSha256).not.toBe(original.declarationSha256);
    });

    test.each([
        "test/definition/fixtures/taxonomy-rethrow.ts",
        "test/definition/fixtures/taxonomy-shadow.ts",
        "test/definition/fixtures/taxonomy-shadow-type-error.ts",
        "test/definition/fixtures/taxonomy-type-error.ts"
    ])("rejects adversarial unclassified fixture %s", { tags: "p2", timeout: 15_000 }, (fixture) => {
        const result = spawnSync(
            process.execPath,
            [resolve(packageRoot, "artifacts/quality/check-w4-error-taxonomy.mjs")],
            {
                cwd: packageRoot,
                encoding: "utf8",
                env: { ...process.env, W4_TAXONOMY_FIXTURE: fixture }
            }
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Unclassified integrated W4 error sites");
    });
});

interface TaxonomyFingerprint {
    readonly declarationSha256: string;
    readonly statementSha256: string;
}

function fingerprint(source: string): TaxonomyFingerprint {
    const result = spawnSync(
        process.execPath,
        [
            resolve(packageRoot, "artifacts/quality/check-w4-error-taxonomy.mjs"),
            "--fingerprint-source",
            "-"
        ],
        { cwd: packageRoot, encoding: "utf8", input: source }
    );
    expect(result.status, result.stderr).toBe(0);
    const parsed: JsonValue = JSON.parse(result.stdout);
    const values = assertArray(parsed, "taxonomy fingerprint output");
    if (values.length !== 1) throw new TypeError("Taxonomy fingerprint output must have one site");
    const site = assertObject(values[0], "taxonomy fingerprint site");
    return {
        declarationSha256: assertString(site["declarationSha256"], "declaration digest"),
        statementSha256: assertString(site["statementSha256"], "statement digest")
    };
}

function expectOperational(action: () => void, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new TypeError("Expected operational error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}

/**
 * An empty package ID, typed as one. PackageId rejects an empty value, so a store row carrying one
 * can only be built by skipping that constructor — and the store's own validation is what this
 * asserts on.
 */
function forgedPackageId<TActual>(value: TActual): PackageId {
    // SAFETY: not a PackageId. The store must report the row as invalid rather than index it.
    return value as TActual & PackageId;
}
