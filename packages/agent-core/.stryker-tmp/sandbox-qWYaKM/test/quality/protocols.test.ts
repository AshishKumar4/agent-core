// @ts-nocheck
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runQualitySubprocess, subprocessTestOptions } from "./subprocess";
import { extractRequestObligations } from "../../scripts/quality/request-obligations.mjs";

const packageRoot = resolve(import.meta.dirname, "../..");
const temporary: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe("shared ownership protocols", subprocessTestOptions, () => {
    test("rejects duplicate shared error requests", async () => {
        const root = await fixture();
        await write(root, "quality/request-schema.json", {
            edition: "1.0.0",
            kinds: { errors: ["code", "owner", "semantics", "spec", "tests"] }
        });
        const entry = {
            code: "authority.denied",
            owner: "W2",
            semantics: "Authority rejected",
            spec: "3.4",
            tests: ["test/authority/deny.test.ts#denies"]
        };
        await write(root, "requests/W2/errors.json", {
            edition: "1.0.0",
            owner: "W2",
            kind: "errors",
            requests: [entry, entry]
        });

        const result = run("requests", ["--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Duplicate shared request");
    });

    test("rejects an unproven verified request evidence document", async () => {
        const root = await fixture();
        await cp(
            resolve(packageRoot, "artifacts/quality/request-schema.json"),
            resolve(root, "quality/request-schema.json")
        );
        await write(root, "requests/W5/forged.json", {
            edition: "1.0.0",
            status: "verified"
        });

        const result = run("requests", ["--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Imported request evidence is malformed");
    });

    test("aggregates requests during building and rejects unresolved final requests", async () => {
        const root = await fixture();
        await write(root, "quality/request-schema.json", {
            edition: "1.0.0",
            kinds: { dependencies: ["context", "symbol", "typeOnly", "reason", "spec"] }
        });
        await write(root, "requests/W6/dependencies.json", {
            edition: "1.0.0",
            owner: "W6",
            kind: "dependencies",
            requests: [
                {
                    context: "agents",
                    symbol: "LeaseToken",
                    typeOnly: true,
                    reason: "Use the exact Run-owned token",
                    spec: "5.3"
                }
            ]
        });

        const building = run("requests", ["--stage", "building", "--artifact-root", root]);
        expect(building.status).toBe(0);
        expect(building.stdout).toContain("aggregated: 1");
        const final = run("requests", ["--stage", "final", "--artifact-root", root]);
        expect(final.status).toBe(1);
        expect(final.stderr).toContain("Final request roots must be empty");
    });

    test("validates the indexed archive while final remains fail-closed", () => {
        const building = run("requests", ["--stage", "building"]);
        expect(building.status).toBe(0);
        expect(building.stdout).toContain("aggregated: 0");
        expect(building.stdout).toContain("pending disposition evidence: 0");
        expect(building.stdout).toContain("archived: 48");

        const final = run("requests", ["--stage", "final"]);
        expect(final.status).toBe(1);
        expect(final.stderr).toContain("does not match final");
    });

    test("passes final only with empty active roots and an exact finalized archive", async () => {
        const repository = await mkdtemp(resolve(tmpdir(), "agent-core-final-request-archive-"));
        temporary.push(repository);
        const root = resolve(repository, "packages/agent-core/artifacts");
        const source = "packages/agent-core/artifacts/requests/W1/request.json";
        const archivePath =
            "packages/agent-core/artifacts/integration/request-archive/W1/request.json";
        const bytes = '{"request":"fixture"}\n';
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        await mkdir(resolve(root, "integration/request-archive/W1"), { recursive: true });
        await mkdir(resolve(root, "quality"), { recursive: true });
        await writeFile(resolve(repository, archivePath), bytes, "utf8");
        await cp(
            resolve(packageRoot, "artifacts/quality/ownership.json"),
            resolve(root, "quality/ownership.json"),
            { recursive: true }
        );
        await cp(
            resolve(packageRoot, "artifacts/quality/request-evidence-schema.json"),
            resolve(root, "quality/request-evidence-schema.json")
        );
        await cp(
            resolve(packageRoot, "artifacts/quality/request-schema.json"),
            resolve(root, "quality/request-schema.json")
        );
        await cp(
            resolve(packageRoot, "artifacts/integration/request-archive-schema.json"),
            resolve(root, "integration/request-archive-schema.json")
        );
        const bom = {
            edition: "1.0.0",
            stage: "final",
            entries: [
                {
                    owner: "W1",
                    artifacts: [
                        {
                            source,
                            sourceSha256: sha256,
                            destination: archivePath,
                            sha256,
                            normalization: "none"
                        }
                    ]
                }
            ]
        };
        await write(root, "integration/bom.json", bom);
        await write(root, "integration/request-archive.json", {
            edition: "1.0.0",
            entries: [
                {
                    owner: "W1",
                    source,
                    sourceSha256: sha256,
                    path: archivePath,
                    sha256
                }
            ]
        });
        git(repository, ["init"]);
        git(repository, ["add", "."]);
        git(repository, [
            "-c",
            "user.name=Agent Core Test",
            "-c",
            "user.email=agent-core@example.invalid",
            "commit",
            "-m",
            "Archive request"
        ]);
        const commit = git(repository, ["rev-parse", "HEAD"]);
        const completion = {
            commit,
            tree: git(repository, ["show", "-s", "--format=%T", commit]),
            artifacts: [
                {
                    path: archivePath,
                    blob: git(repository, ["rev-parse", `${commit}:${archivePath}`]),
                    sha256
                }
            ]
        };
        const obligations = extractRequestObligations(source, sha256, bytes);
        await write(root, "integration/resolutions.json", {
            edition: "1.0.0",
            entries: [
                {
                    source,
                    sourceSha256: sha256,
                    archive: archivePath,
                    archiveSha256: sha256,
                    state: "applied",
                    completion,
                    outcome: {
                        kind: "applied",
                        treatment: "accepted",
                        commit: completion.commit,
                        tree: completion.tree,
                        rationale: "The archived request was applied by the fixture.",
                        tests: [],
                        checks: ["tests"],
                        artifacts: completion.artifacts,
                        items: obligations.map((obligation) => ({
                            obligationId: obligation.obligationId,
                            source: obligation.source,
                            anchor: obligation.anchor,
                            atomSha256: obligation.atomSha256,
                            treatment: "accepted",
                            rationale: "The fixture request is accepted.",
                            artifactPaths: [archivePath],
                            tests: [],
                            checks: ["tests"]
                        }))
                    }
                }
            ],
            decisions: []
        });

        const result = run("requests", [
            "--stage",
            "final",
            "--artifact-root",
            root,
            "--repository-root",
            repository
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("archived: 1");

        await write(root, "integration/bom.json", { ...bom, stage: "building" });
        const wrongStage = run("requests", [
            "--stage",
            "final",
            "--artifact-root",
            root,
            "--repository-root",
            repository
        ]);
        expect(wrongStage.status).toBe(1);
        expect(wrongStage.stderr).toContain("does not match final");

        await write(root, "integration/bom.json", bom);
        await writeFile(resolve(repository, archivePath), "tampered\n", "utf8");
        const tampered = run("requests", [
            "--stage",
            "final",
            "--artifact-root",
            root,
            "--repository-root",
            repository
        ]);
        expect(tampered.status).toBe(1);
        expect(tampered.stderr).toContain("Archived request bytes changed");
    });

    test("discovers root and package request fragments in one aggregation", async () => {
        const repository = await mkdtemp(resolve(tmpdir(), "agent-core-request-roots-"));
        temporary.push(repository);
        const root = resolve(repository, "packages/agent-core/artifacts");
        await mkdir(root, { recursive: true });
        await cp(
            resolve(packageRoot, "artifacts/quality/ownership.json"),
            resolve(root, "quality/ownership.json"),
            { recursive: true }
        );
        await cp(
            resolve(packageRoot, "artifacts/quality/request-evidence-schema.json"),
            resolve(root, "quality/request-evidence-schema.json")
        );
        await write(root, "quality/request-schema.json", {
            edition: "1.0.0",
            kinds: { dependencies: ["context", "symbol", "typeOnly", "reason", "spec"] }
        });
        await write(root, "requests/W6/dependencies.json", {
            edition: "1.0.0",
            owner: "W6",
            kind: "dependencies",
            requests: [
                {
                    context: "agents",
                    symbol: "LeaseToken",
                    typeOnly: true,
                    reason: "Use the canonical token",
                    spec: "5.3"
                }
            ]
        });
        await write(repository, "artifacts/requests/W8/integration.json", {
            schemaVersion: "agent-core.integration-request/v1",
            workstream: "W8",
            baseCommit: "f".repeat(40),
            requests: [
                {
                    id: "W8-W0-TEST",
                    owner: "W0",
                    kind: "quality-registry",
                    state: "requested"
                }
            ]
        });

        const result = run("requests", [
            "--stage",
            "building",
            "--artifact-root",
            root,
            "--repository-root",
            repository
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("aggregated: 2");
    });

    test("rejects a source-removal request outside the requesting wave", async () => {
        const root = await fixture();
        await cp(
            resolve(packageRoot, "artifacts/quality/request-schema.json"),
            resolve(root, "quality/request-schema.json")
        );
        await write(root, "requests/W2/removal.json", {
            edition: "1.0.0",
            owner: "W2",
            kind: "source-removals",
            requests: [
                {
                    path: "packages/agent-core/src/facets/operation.ts",
                    owner: "W2",
                    reason: "coverage gaming",
                    replacement: "none",
                    tests: ["test/facets/operation.test.ts#removed"]
                }
            ]
        });

        const result = run("requests", ["--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("not owned by W2");
    });

    test("rejects duplicate durable owners", async () => {
        const root = await fixture();
        await write(root, "records/index.json", {
            edition: "1.0.0",
            fragments: ["identity-authority.json"],
            pendingFragments: []
        });
        const record = {
            symbol: "Grant",
            kind: "authority.grant",
            durability: "durable",
            ownerActor: "tenant",
            source: "src/authority/grant.ts#Grant",
            codec: "authority.grant",
            store: "src/substrates/sqlite/authority.ts#SqliteGrantStore",
            tests: ["test/authority/grant.test.ts#[authority.grant] persists"]
        };
        await write(root, "records/identity-authority.json", {
            edition: "1.0.0",
            owner: "W2",
            records: [record, { ...record, symbol: "OtherGrant" }]
        });

        const result = run("records", ["--stage", "final", "--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("duplicated");
    });

    test("rejects a verified SlotEntry persistence claim without weakening registry assertions", async () => {
        const root = await fixture();
        await write(root, "records/index.json", {
            edition: "1.0.0",
            fragments: ["facets-operations.json"],
            pendingFragments: []
        });
        await write(root, "records/facets-operations.json", {
            edition: "1.0.0",
            owner: "W3",
            records: [
                {
                    symbol: "SlotEntry",
                    kind: "facet.slot-entry",
                    durability: "durable",
                    ownerActor: "workspace",
                    source: "src/facets/slot-entry.ts#SlotEntry",
                    codec: "src/facets/slot-entry.ts#SlotEntry.codec",
                    store: null,
                    tests: ["test/facets/slot-entry.test.ts#[facet.slot-entry] persists"]
                }
            ]
        });

        const result = run("records", ["--stage", "building", "--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("requires one Actor and store");
    });

    test("applies full structure checks to pending registry fragments", async () => {
        let root = await fixture();
        await write(root, "records/index.json", {
            edition: "1.0.0",
            fragments: [],
            pendingFragments: ["facets-operations.json"]
        });
        await write(root, "records/facets-operations.json", {
            edition: "1.0.0",
            owner: "W3",
            records: [
                {
                    symbol: "SlotEntry",
                    kind: "facet.slot-entry",
                    durability: "durable",
                    ownerActor: "workspace",
                    source: "src/facets/slot-entry.ts#SlotEntry",
                    codec: "src/facets/slot-entry.ts#SlotEntry.codec",
                    store: null,
                    tests: ["test/facets/slot-entry.test.ts#[facet.slot-entry] persists"]
                }
            ]
        });
        let result = run("records", ["--stage", "building", "--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("requires one Actor and store");

        root = await fixture();
        await write(root, "seams/index.json", {
            edition: "1.0.0",
            required: [],
            fragments: [],
            pendingFragments: ["foundation.json"],
            pendingRequired: ["content-store"]
        });
        await write(root, "seams/foundation.json", {
            edition: "1.0.0",
            owner: "W1",
            seams: [
                {
                    id: "content-store",
                    disposition: "verified",
                    contract: "src/content/store.ts#ContentStore",
                    implementations: ["src/content/sqlite.ts#SqliteContentStore"],
                    memoryReference: "src/content/memory.ts#MemoryContentStore",
                    contractTest: "test/content/store.test.ts#[content-store] contract"
                }
            ]
        });
        result = run("seams", ["--stage", "building", "--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("memory reference is not an implementation");
    });

    test("rejects nested fragments that impersonate indexed basenames", async () => {
        const root = await fixture();
        await write(root, "records/index.json", {
            edition: "1.0.0",
            fragments: ["identity-authority.json"],
            pendingFragments: []
        });
        await write(root, "records/nested/identity-authority.json", {
            edition: "1.0.0",
            owner: "W2",
            records: []
        });
        const result = run("records", ["--stage", "building", "--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("exact index");
    });

    test("requires a memory reference and shared seam contract", async () => {
        const root = await fixture();
        await write(root, "seams/index.json", {
            edition: "1.0.0",
            required: ["content-store"],
            fragments: ["foundation.json"]
        });
        await write(root, "seams/foundation.json", {
            edition: "1.0.0",
            owner: "W1",
            seams: [
                {
                    id: "content-store",
                    disposition: "verified",
                    contract: "src/content/store.ts#ContentStore",
                    implementations: ["src/content/memory.ts#MemoryContentStore"],
                    memoryReference: "",
                    contractTest: ""
                }
            ]
        });

        const result = run("seams", ["--stage", "final", "--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("lacks a memory reference");
    });

    test("rejects omitted record, seam, and migration denominators", async () => {
        let root = await fixture();
        await writeFile(
            resolve(root, "record.ts"),
            [
                "export class PropertyCodecRecord {",
                "  public static readonly codec = {};",
                "}",
                "export class GetterCodecRecord {",
                "  public static get codec() { return {}; }",
                "}",
                "export class MethodCodecRecord {",
                "  public static encode() {}",
                "  public static decode() {}",
                "}"
            ].join("\n"),
            "utf8"
        );
        let result = run("records", [
            "--stage",
            "building",
            "--artifact-root",
            root,
            "--source-root",
            root
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("0/3 classified");
        result = run("records", [
            "--stage",
            "final",
            "--artifact-root",
            root,
            "--source-root",
            root
        ]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("record denominator mismatch");

        root = await fixture();
        await write(root, "seams/index.json", {
            edition: "1.0.0",
            required: ["content-store"],
            fragments: []
        });
        result = run("seams", ["--stage", "final", "--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("seam denominator mismatch");

        root = await fixture();
        await write(root, "seams/index.json", {
            edition: "1.0.0",
            required: [],
            fragments: []
        });
        result = run("seams", ["--stage", "final", "--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("src/agents/runs/store.ts#RunStoragePort");

        root = await fixture();
        await write(root, "migrations/index.json", {
            edition: "1.0.0",
            seed: "seed.json",
            required: ["MIGRATE-RUN-PINS"],
            fragments: []
        });
        await write(root, "migrations/seed.json", {
            edition: "1.0.0",
            owner: "W0-seed",
            migrations: []
        });
        await write(root, "conformance/index.json", {
            edition: "1.0.0",
            seed: "seed.json",
            fragments: []
        });
        await write(root, "conformance/seed.json", {
            edition: "1.0.0",
            owner: "W0-seed",
            requirements: []
        });
        result = run("migrations", ["--stage", "final", "--artifact-root", root]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("missing=MIGRATE-RUN-PINS");
    });
});

async function fixture(): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "agent-core-protocol-"));
    temporary.push(root);
    await cp(
        resolve(packageRoot, "artifacts/quality/ownership.json"),
        resolve(root, "quality/ownership.json"),
        { recursive: true }
    );
    await cp(
        resolve(packageRoot, "artifacts/quality/request-evidence-schema.json"),
        resolve(root, "quality/request-evidence-schema.json")
    );
    await write(root, "records/index.json", {
        edition: "1.0.0",
        fragments: [],
        pendingFragments: []
    });
    return root;
}

async function write(root: string, path: string, value: unknown): Promise<void> {
    const target = resolve(root, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(repository: string, args: string[]): string {
    return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function run(name: string, args: string[]): ReturnType<typeof runQualitySubprocess> {
    return runQualitySubprocess(
        process.execPath,
        [resolve(packageRoot, `scripts/quality/${name}.mjs`), ...args],
        packageRoot
    );
}
