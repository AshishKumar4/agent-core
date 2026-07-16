// @ts-nocheck
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageUrl = new URL("../../", import.meta.url);
const manifest = JSON.parse(
    readFileSync(
        new URL("artifacts/integration/request-archive/W1/verification-manifest.json", packageUrl),
        "utf8"
    )
) as VerificationManifest;
const taxonomy = JSON.parse(
    readFileSync(
        new URL("artifacts/integration/request-archive/W1/error-taxonomy.json", packageUrl),
        "utf8"
    )
) as ErrorTaxonomy;
const coverage = readFileSync(
    new URL("artifacts/integration/request-archive/W1/coverage.md", packageUrl),
    "utf8"
);
const integration = JSON.parse(
    readFileSync(new URL("artifacts/quality/integrated-w1.json", packageUrl), "utf8")
) as IntegratedW1Manifest;

const genericProtocolSources = [
    "src/protocol/authentication.ts",
    "src/protocol/dispatcher.ts",
    "src/protocol/envelope.ts",
    "src/protocol/index.ts",
    "src/protocol/ingress.ts",
    "src/protocol/memory.ts",
    "src/protocol/payload.ts",
    "src/protocol/persistence.ts",
    "src/protocol/policy.ts",
    "src/protocol/registration.ts",
    "src/protocol/write.ts"
] as const;
const sqliteSources = [
    "src/substrates/sqlite/actor.ts",
    "src/substrates/sqlite/content-retention.ts",
    "src/substrates/sqlite/content.ts",
    "src/substrates/sqlite/protocol.ts",
    "src/substrates/sqlite/sqlite.ts"
] as const;
const genericProtocolTests = [
    "test/protocol/codec.test.ts",
    "test/protocol/dispatcher.test.ts",
    "test/protocol/ingress.test.ts",
    "test/protocol/persistence-memory.test.ts",
    "test/protocol/persistence-sqlite.test.ts"
] as const;
const sqliteTests = ["test/substrates/sqlite/sqlite.test.ts"] as const;
const forbiddenPath =
    /\/(?:authority|definition|quality|scripts)\/|\/(?:bootstrap|materialization)[^/]*\.ts$/;

describe("W1 verification manifest", () => {
    test("is the exact live W1 source and test ownership inventory", () => {
        const discoveredSources = [
            ...discover("src/actors", ".ts"),
            ...discover("src/content", ".ts"),
            ...discover("src/core", ".ts"),
            ...genericProtocolSources,
            ...sqliteSources
        ].sort();
        const liveSources = discoveredSources.filter(
            (path) => !integration.sourceExtensions.includes(path)
        );
        const liveTests = [
            ...discover("test/actors", ".test.ts"),
            ...discover("test/content", ".test.ts"),
            ...discover("test/core", ".test.ts"),
            ...genericProtocolTests,
            ...sqliteTests
        ].sort();
        const coverageInventory = [...coverage.matchAll(/^src\/[^\n]+\.ts$/gm)].map(
            (match) => match[0]
        );

        expect(manifest.schemaVersion).toBe("agent-core.w1-verification/v1");
        expect(manifest.baseCommit).toBe("058157571e1815840f8c6f7c53ff4e4c26827b54");
        expect(manifest.sourceFiles).toEqual([...manifest.sourceFiles].sort());
        expect(manifest.testFiles).toEqual([...manifest.testFiles].sort());
        expect(manifest.sourceFiles).toEqual(liveSources);
        expect(manifest.testFiles).toEqual(liveTests);
        expect(manifest.sourceFiles).toEqual(coverageInventory);
        expect(manifest.sourceFiles).toEqual(taxonomy.sources);
        expect(integration.sourceExtensions).toEqual(["src/actors/id.ts"]);
        expect(discoveredSources).toEqual(
            [...manifest.sourceFiles, ...integration.sourceExtensions].sort()
        );
        expect(
            [...manifest.sourceFiles, ...manifest.testFiles].every((path) =>
                existsSync(new URL(path, packageUrl))
            )
        ).toBe(true);
        expect(
            [...manifest.sourceFiles, ...manifest.testFiles].filter((path) =>
                forbiddenPath.test(`/${path}`)
            )
        ).toEqual([]);
    });
});

interface VerificationManifest {
    readonly schemaVersion: string;
    readonly baseCommit: string;
    readonly sourceFiles: readonly string[];
    readonly testFiles: readonly string[];
}

interface ErrorTaxonomy {
    readonly sources: readonly string[];
}

interface IntegratedW1Manifest {
    readonly sourceExtensions: readonly string[];
}

function discover(root: string, suffix: string): string[] {
    const absoluteRoot = fileURLToPath(new URL(`${root}/`, packageUrl));
    const walk = (absolute: string, relative: string): string[] =>
        readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
            const path = `${relative}/${entry.name}`;
            return entry.isDirectory()
                ? walk(join(absolute, entry.name), path)
                : entry.isFile() && entry.name.endsWith(suffix)
                  ? [path]
                  : [];
        });
    return walk(absoluteRoot, root);
}
