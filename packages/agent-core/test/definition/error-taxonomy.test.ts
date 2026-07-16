import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import {
    DeploymentId,
    DeploymentKey,
    DeploymentRecord,
    FailClosedRunPinsReservationPort,
    RunPinEvidence,
    selectPlacement
} from "../../src/definition";
import { MemoryPackageStore } from "../../src/definition/memory";
import { TenantId } from "../../src/identity";

const packageRoot = resolve(import.meta.dirname, "../..");

describe("W4 error taxonomy", () => {
    test("classifies every W4 throw site without bare errors", () => {
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
        expect(taxonomy.expected).toEqual({
            agentCoreOperationalThrows: 236,
            allowedTypeErrors: 153,
            preservedRethrows: 1,
            bareErrors: 0
        });
        expect(taxonomy.expectedOperationalByCode).toEqual({
            "codec.invalid": 113,
            "operation.invalid-input": 30,
            "protocol.invalid-envelope": 5,
            "protocol.invalid-state": 71,
            "protocol.revision-conflict": 17
        });
    }, 120_000);

    test("uses closed codes for unavailable pins and invalid evidence", () => {
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
                            packageId: "" as never,
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

    test.each([
        "test/definition/fixtures/taxonomy-rethrow.ts",
        "test/definition/fixtures/taxonomy-shadow.ts",
        "test/definition/fixtures/taxonomy-shadow-type-error.ts",
        "test/definition/fixtures/taxonomy-type-error.ts"
    ])("rejects adversarial unclassified fixture %s", { timeout: 15_000 }, (fixture) => {
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

function expectOperational(action: () => unknown, code: AgentCoreError["code"]): void {
    try {
        action();
        throw new TypeError("Expected operational error");
    } catch (error) {
        expect(error).toBeInstanceOf(AgentCoreError);
        expect(error).toMatchObject({ code });
    }
}
