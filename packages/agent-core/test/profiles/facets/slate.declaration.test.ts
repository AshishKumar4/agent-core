import { ContentRef, Digest } from "../../../src/core";
import {
    EnvironmentBackend,
    EnvironmentFacet,
    EnvironmentSessionBinding,
    SLATE_CONTRIBUTIONS,
    SLATE_ISOLATION,
    SLATE_OPERATIONS,
    SLATE_SURFACES,
    SlateBackend,
    SlateFacet
} from "../../../src/facets";
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

class TestSlateBackend extends SlateBackend {
    public readonly calls: string[] = [];
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
    public async deploy() {
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
