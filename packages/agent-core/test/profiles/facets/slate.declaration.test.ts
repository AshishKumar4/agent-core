import { MemoryContentStore } from "../../../src/content";
import { CompatRange, ContentRef, Digest, SemVer, type JsonValue } from "../../../src/core";
import {
    BindingName,
    BindingRequirement,
    EffectDispatch,
    EffectDispatchAttempt,
    EnvironmentBackend,
    EnvironmentFacet,
    EnvironmentSessionBinding,
    FacetPackageId,
    OperationName,
    SLATE_CONTRIBUTIONS,
    SLATE_ENVIRONMENT_BINDING,
    SLATE_ISOLATION,
    SLATE_OPERATIONS,
    SLATE_OPERATION_CONTRACTS,
    SLATE_SURFACES,
    SlateBackend,
    SlateFacet,
    createSlateManifest,
    type FacetManifest,
    type InternalProfileFacetRuntime,
    type OperationContext,
    type SlateDeployInput
} from "../../../src/facets";
import { EffectAttemptId, InvocationId } from "../../../src/invocations";
import { describe, expect, test } from "vitest";
import { denyingRuntime, operationDeclarationEvidence, recordingRuntime } from "./harness";

operationDeclarationEvidence("Slate", SLATE_OPERATIONS, {
    update: "mutate",
    commit: "mutate",
    fork: "mutate",
    publish: "mutate",
    deploy: "externalSend",
    rollback: "mutate"
});

describe("Slate protected profile", () => {
    test("[P11-SLATE-PREVIEW] routes all six Operations and delegates preview to Environment control", async () => {
        const slateRuntime = recordingRuntime("slate");
        const environmentRuntime = recordingRuntime("environment");
        const backend = new TestSlateBackend();
        const environment = new EnvironmentFacet(
            environmentRuntime.runtime,
            new PreviewEnvironmentBackend()
        );
        const slate = new SlateFacet(slateRuntime.runtime, backend, environment);

        await slate.update({
            slate: "slate",
            source: content().value,
            expectedRevision: 1
        });
        await slate.commit({ slate: "slate", expectedRevision: 1 });
        await slate.fork({
            sourceVersion: "version",
            workspace: "workspace"
        });
        await slate.publish({
            version: "version",
            materialization: content().value
        });
        await slate.deploy({
            publication: "publication",
            target: "production"
        });
        await slate.rollback({
            slate: "slate",
            deployment: "deployment"
        });
        await expect(slate.preview({ session: "preview", port: 8080 })).resolves.toBe(
            "https://preview.test/"
        );

        expect(slateRuntime.admission.calls.map((call) => call.name)).toEqual([
            "update",
            "commit",
            "fork",
            "publish",
            "deploy",
            "rollback"
        ]);
        expect(environmentRuntime.admission.calls.map((call) => [call.kind, call.name])).toEqual([
            ["control", "environment.exposePreview"]
        ]);
    });

    test("denial prevents Slate backend mutation", async () => {
        const backend = new TestSlateBackend();
        const environment = new EnvironmentFacet(
            recordingRuntime("environment").runtime,
            new PreviewEnvironmentBackend()
        );
        const slate = new SlateFacet(denyingRuntime("slate").runtime, backend, environment);
        await expect(
            slate.deploy({
                publication: "publication",
                target: "production"
            })
        ).rejects.toMatchObject({ code: "authority.denied" });
        expect(backend.calls).toEqual([]);
    });

    test("declares dynamic isolation and operation contributions", () => {
        expect(SLATE_ISOLATION).toEqual(["dynamic"]);
        expect(SLATE_CONTRIBUTIONS.entries.map((entry) => entry.slot.value)).toEqual([
            "operations",
            "surfaces"
        ]);
        expect(SLATE_SURFACES.map((surface) => surface.id.value)).toEqual([
            "slate.publication",
            "slate.embed"
        ]);
    });

    test("internal runtime routes all six Operations and both Surfaces", { tags: "p1" }, async () => {
        const { runtime } = recordingRuntime("slate");
        const backend = new TestSlateBackend();
        const environment = new EnvironmentFacet(
            recordingRuntime("environment").runtime,
            new PreviewEnvironmentBackend()
        );
        const internal = new SlateFacet(runtime, backend, environment).asInternalRuntime(
            slateManifest()
        );
        await internal.start({ signal: new AbortController().signal });
        expect(internal.active).toBe(true);
        expect(
            SLATE_SURFACES.every((surface) => internal.surface(surface.id)?.descriptor === surface)
        ).toBe(true);

        const context = internalContext();
        await expect(
            execute(internal, "update", {
                slateId: "slate",
                source: content().value,
                expectedRevision: 1
            }, context)
        ).resolves.toEqual({ name: "update" });
        await execute(internal, "commit", { slateId: "slate" }, context);
        await execute(internal, "fork", {
            sourceVersionId: "version",
            workspaceId: "workspace"
        }, context);
        await execute(internal, "publish", {
            versionId: "version",
            materialization: content().value
        }, context);
        await execute(internal, "deploy", {
            publicationId: "publication",
            target: "production"
        }, context);
        await execute(internal, "rollback", {
            slateId: "slate",
            deploymentId: "deployment",
            expectedActiveDeploymentId: "active"
        }, context);

        expect(backend.calls).toEqual([
            "update",
            "commit",
            "fork",
            "publish",
            "deploy",
            "rollback"
        ]);
        expect(backend.dispatched[0]?.idempotencyKey).toBe("internal-idempotency");
    });
});

describe("Slate wire codec evidence", () => {
    test("update and commit encode expected revisions only when present", { tags: "p1" }, () => {
        const update = SLATE_OPERATION_CONTRACTS.update;
        expect(
            update.encodeInput({ slate: "slate", source: content().value, expectedRevision: 2 })
        ).toEqual({ slateId: "slate", source: content().value, expectedRevision: 2 });
        expect(wireKeys(update.encodeInput({ slate: "slate", source: content().value }))).toEqual([
            "slateId",
            "source"
        ]);
        const commit = SLATE_OPERATION_CONTRACTS.commit;
        expect(commit.encodeInput({ slate: "slate", expectedRevision: 2 })).toEqual({
            slateId: "slate",
            expectedRevision: 2
        });
        expect(wireKeys(commit.encodeInput({ slate: "slate" }))).toEqual(["slateId"]);
    });

    test("update and commit decode expected revisions with the zero boundary", { tags: "p1" }, () => {
        const update = SLATE_OPERATION_CONTRACTS.update;
        expect(
            update.decodeInput({ slateId: "slate", source: content().value, expectedRevision: 0 })
        ).toEqual({ slate: "slate", source: content().value, expectedRevision: 0 });
        expect(
            Object.keys(update.decodeInput({ slateId: "slate", source: content().value }))
        ).toEqual(["slate", "source"]);
        const commit = SLATE_OPERATION_CONTRACTS.commit;
        expect(commit.decodeInput({ slateId: "slate", expectedRevision: 3 })).toEqual({
            slate: "slate",
            expectedRevision: 3
        });
        expect(Object.keys(commit.decodeInput({ slateId: "slate" }))).toEqual(["slate"]);
        expect(() =>
            update.decodeInput({
                slateId: "slate",
                source: content().value,
                expectedRevision: -1
            })
        ).toThrow("Expected Slate revision must not be negative");
    });

    test("fork, publish, and deploy inputs decode from their wire form", { tags: "p1" }, () => {
        expect(
            SLATE_OPERATION_CONTRACTS.fork.decodeInput({
                sourceVersionId: "version",
                workspaceId: "workspace"
            })
        ).toEqual({ sourceVersion: "version", workspace: "workspace" });
        expect(
            SLATE_OPERATION_CONTRACTS.publish.decodeInput({
                versionId: "version",
                materialization: content().value
            })
        ).toEqual({ version: "version", materialization: content().value });
        expect(
            SLATE_OPERATION_CONTRACTS.deploy.decodeInput({
                publicationId: "publication",
                target: "production"
            })
        ).toEqual({ publication: "publication", target: "production" });
    });

    test("rollback codes the expected active deployment only when present", { tags: "p1" }, () => {
        const rollback = SLATE_OPERATION_CONTRACTS.rollback;
        expect(
            rollback.encodeInput({
                slate: "slate",
                deployment: "deployment",
                expectedActiveDeployment: "active"
            })
        ).toEqual({
            slateId: "slate",
            deploymentId: "deployment",
            expectedActiveDeploymentId: "active"
        });
        expect(wireKeys(rollback.encodeInput({ slate: "slate", deployment: "deployment" }))).toEqual(
            ["deploymentId", "slateId"]
        );
        expect(
            rollback.decodeInput({
                slateId: "slate",
                deploymentId: "deployment",
                expectedActiveDeploymentId: "active"
            })
        ).toEqual({
            slate: "slate",
            deployment: "deployment",
            expectedActiveDeployment: "active"
        });
        expect(
            Object.keys(rollback.decodeInput({ slateId: "slate", deploymentId: "deployment" }))
        ).toEqual(["slate", "deployment"]);
    });

    test("names the expected active deployment when it is not a string", { tags: "p2" }, () => {
        expect(() =>
            SLATE_OPERATION_CONTRACTS.rollback.decodeInput({
                slateId: "slate",
                deploymentId: "deployment",
                expectedActiveDeploymentId: 5
            })
        ).toThrow("Expected active Slate deployment ID must be a string");
    });
});

describe("Slate effect identity to deployment backend", () => {
    test("[P11-SLATE-DISPATCH] delivers the canonical effect identity derived from the context to deploy", async () => {
        const { runtime, admission } = recordingRuntime("slate-dispatch");
        const backend = new TestSlateBackend();
        const environment = new EnvironmentFacet(
            recordingRuntime("environment").runtime,
            new PreviewEnvironmentBackend()
        );
        const slate = new SlateFacet(runtime, backend, environment);

        await slate.deploy({ publication: "publication", target: "production" });

        const invoke = admission.calls.find((call) => call.kind === "invoke")!;
        const expected = invoke.context!.dispatch();
        const delivered = backend.dispatched[0]!;
        expect(Object.isFrozen(delivered)).toBe(true);
        expect(delivered.idempotencyKey).toBe(expected.idempotencyKey);
        expect(delivered.attempt?.id.equals(expected.attempt!.id)).toBe(true);
        expect(delivered.attempt?.ordinal).toBe(expected.attempt!.ordinal);
        expect(delivered.attempt?.intentDigest.equals(expected.attempt!.intentDigest)).toBe(true);
    });

    test("[P11-SLATE-CRASH-RETRY] a crash-after-send deploy retry reuses the key so the provider dedups instead of redeploying", async () => {
        const backend = new DedupSlateBackend();
        const dispatch = new EffectDispatch(
            "slate-test-key",
            new EffectDispatchAttempt(
                new EffectAttemptId("slate-test-attempt"),
                0,
                Digest.sha256(new TextEncoder().encode("slate-test"))
            )
        );
        const input = { publication: "publication", target: "production" };

        await expect(backend.deploy(input, dispatch)).rejects.toThrow("crash after send");
        const retry = await backend.deploy(input, dispatch);

        expect(backend.attempts.map((attempt) => attempt.idempotencyKey)).toEqual([
            "slate-test-key",
            "slate-test-key"
        ]);
        expect(
            backend.attempts.every((attempt) =>
                attempt.attempt!.id.equals(new EffectAttemptId("slate-test-attempt"))
            )
        ).toBe(true);
        expect(backend.deliveries).toBe(1);
        expect(retry).toEqual({ outcome: "succeeded" });
    });
});

class TestSlateBackend extends SlateBackend {
    public readonly calls: string[] = [];
    public readonly dispatched: EffectDispatch[] = [];
    public async update() {
        return this.record("update");
    }
    public async commit() {
        return this.record("commit");
    }
    public async fork() {
        return this.record("fork");
    }
    public async publish() {
        return this.record("publish");
    }
    public async deploy(_input: SlateDeployInput, dispatch: EffectDispatch) {
        this.dispatched.push(dispatch);
        return this.record("deploy");
    }
    public async rollback() {
        return this.record("rollback");
    }
    private record(name: string) {
        this.calls.push(name);
        return { name };
    }
}

/**
 * A Slate backend that dedups its one external deployment on the canonical idempotency
 * key: the first deploy delivers then crashes before the outcome is recorded; a retry
 * carrying the same key returns the prior result without redeploying (SPEC §7.4).
 */
class DedupSlateBackend extends SlateBackend {
    public readonly attempts: EffectDispatch[] = [];
    public deliveries = 0;
    readonly #results = new Map<string, JsonValue>();
    public async update(): Promise<JsonValue> {
        return {};
    }
    public async commit(): Promise<JsonValue> {
        return {};
    }
    public async fork(): Promise<JsonValue> {
        return {};
    }
    public async publish(): Promise<JsonValue> {
        return {};
    }
    public async rollback(): Promise<JsonValue> {
        return {};
    }
    public async deploy(_input: SlateDeployInput, dispatch: EffectDispatch): Promise<JsonValue> {
        this.attempts.push(dispatch);
        const prior = this.#results.get(dispatch.idempotencyKey);
        if (prior !== undefined) return prior;
        this.deliveries += 1;
        this.#results.set(dispatch.idempotencyKey, { outcome: "succeeded" });
        throw new TypeError("crash after send");
    }
}

class PreviewEnvironmentBackend extends EnvironmentBackend {
    public async exposePreview(): Promise<string> {
        return "https://preview.test/";
    }
    public async open(): Promise<EnvironmentSessionBinding> {
        return this.session();
    }
    public async use(): Promise<EnvironmentSessionBinding> {
        return this.session();
    }
    public async close(): Promise<void> {}
    public async snapshot(): Promise<ContentRef> {
        return content();
    }
    public async restore(): Promise<EnvironmentSessionBinding> {
        return this.session();
    }
    public async backupEphemeral(): Promise<ContentRef> {
        return content();
    }
    public async restoreEphemeral(): Promise<void> {}
    public async forwardCredential(): Promise<ContentRef> {
        return content();
    }
    private session(): EnvironmentSessionBinding {
        return new EnvironmentSessionBinding("preview", 0, []);
    }
}

function content(): ContentRef {
    return ContentRef.fromDigest(new Digest("a".repeat(64)));
}

function wireKeys(data: JsonValue): readonly string[] {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new TypeError("Wire value must be an object");
    }
    return Object.keys(data);
}

function slateManifest(): FacetManifest {
    return createSlateManifest({
        id: new FacetPackageId("profile.slate"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        bindings: [
            new BindingRequirement(
                new BindingName(SLATE_ENVIRONMENT_BINDING),
                new FacetPackageId("dependency.environment"),
                new CompatRange("^1.0.0", "^1.0.0")
            )
        ]
    });
}

function internalContext(): OperationContext {
    return Object.freeze({
        invocation: new InvocationId("internal-invocation"),
        itemIndex: 0,
        idempotencyKey: "internal-idempotency",
        attempt: Object.freeze({
            id: new EffectAttemptId("internal-attempt"),
            ordinal: 0,
            intentDigest: Digest.sha256(new TextEncoder().encode("internal"))
        }),
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    });
}

function execute(
    internal: InternalProfileFacetRuntime,
    name: string,
    input: JsonValue,
    context: OperationContext
): Promise<JsonValue> {
    const operation = internal.operation(new OperationName(name));
    if (operation === undefined) throw new TypeError(`Missing internal Operation ${name}`);
    return operation.execute(context, input);
}
