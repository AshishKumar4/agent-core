// @ts-nocheck
import { ContentRef, Digest, type JsonValue } from "../../../src/core";
import {
    EffectDispatch,
    EffectDispatchAttempt,
    EnvironmentBackend,
    EnvironmentFacet,
    EnvironmentSessionBinding,
    SLATE_CONTRIBUTIONS,
    SLATE_ISOLATION,
    SLATE_OPERATIONS,
    SLATE_SURFACES,
    SlateBackend,
    SlateFacet,
    type SlateDeployInput
} from "../../../src/facets";
import { EffectAttemptId } from "../../../src/invocations";
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
