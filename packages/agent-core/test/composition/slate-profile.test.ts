import { SlateRuntimeBackend, type SlateRuntimePort } from "../../src/composition";
import { EffectDispatch } from "../../src/facets";
import { ContentRef, Digest, Revision } from "../../src/core";
import { WorkspaceId } from "../../src/identity";
import { InvocationId } from "../../src/interaction-references";
import { ReceiptId } from "../../src/invocation-references";
import {
    Slate,
    SlateDeployment,
    SlateDeploymentId,
    SlateId,
    SlatePublication,
    SlatePublicationId,
    SlateVersion,
    SlateVersionId
} from "../../src/slates";
import { describe, expect, test } from "vitest";

let dispatchCounter = 0;
function dispatchFixture(): EffectDispatch {
    dispatchCounter += 1;
    return new EffectDispatch(`slate-dispatch-${dispatchCounter}`);
}

describe("Slate profile composition", () => {
    test("maps profile wire DTOs to typed SlateRuntime arguments", async () => {
        const calls: Array<{ readonly operation: string; readonly values: readonly unknown[] }> =
            [];
        const stopped = new TypeError("stop after mapping");
        const capture = (operation: string, values: readonly unknown[]): never => {
            calls.push({ operation, values });
            throw stopped;
        };
        const runtime: SlateRuntimePort = {
            update: async (...values) => capture("update", values),
            commit: async (...values) => capture("commit", values),
            fork: async (...values) => capture("fork", values),
            publish: async (...values) => capture("publish", values),
            deploy: async (...values) => capture("deploy", values),
            rollback: async (...values) => capture("rollback", values)
        };
        const backend = new SlateRuntimeBackend(runtime);
        const source = content().value;

        await expect(backend.update({ slate: "slate", source, expectedRevision: 2 })).rejects.toBe(
            stopped
        );
        await expect(backend.commit({ slate: "slate", expectedRevision: 2 })).rejects.toBe(stopped);
        await expect(
            backend.fork({ sourceVersion: "version", workspace: "workspace" })
        ).rejects.toBe(stopped);
        await expect(backend.publish({ version: "version", materialization: source })).rejects.toBe(
            stopped
        );
        await expect(
            backend.deploy(
                { publication: "publication", target: "production" },
                new EffectDispatch("dispatch-mapping-key")
            )
        ).rejects.toBe(stopped);
        await expect(backend.rollback({ slate: "slate", deployment: "deployment" })).rejects.toBe(
            stopped
        );

        expect(
            calls.map((call) => [
                call.operation,
                ...call.values.map((value) =>
                    typeof value === "string" ? value : (value as { value?: unknown })?.value
                )
            ])
        ).toEqual([
            ["update", "slate", source, 2],
            ["commit", "slate", 2],
            ["fork", "version", "workspace"],
            ["publish", "version", source],
            ["deploy", "publication", "production", "dispatch-mapping-key"],
            ["rollback", "slate", "deployment", undefined]
        ]);
    });

    test("maps runtime outcomes and optional profile fields", async () => {
        const workspace = new WorkspaceId("workspace-profile-backend");
        const slateId = new SlateId("slate-profile-backend");
        const versionId = new SlateVersionId("version-profile-backend");
        const publicationId = new SlatePublicationId("publication-profile-backend");
        const deploymentId = new SlateDeploymentId("deployment-profile-backend");
        const invocationId = new InvocationId("invocation-profile-backend");
        const receiptId = new ReceiptId("receipt-profile-backend");
        const source = content();
        const version = new SlateVersion(versionId, workspace, slateId, source);
        const publication = new SlatePublication(
            publicationId,
            workspace,
            slateId,
            versionId,
            source
        );
        const deployment = new SlateDeployment(
            deploymentId,
            workspace,
            slateId,
            publicationId,
            "production",
            source,
            invocationId,
            receiptId
        );
        const initial = Slate.initial(slateId, workspace, source);
        const active = new Slate({
            id: slateId,
            workspaceId: workspace,
            source,
            headVersionId: versionId,
            activeDeploymentId: deploymentId,
            revision: new Revision(2)
        });
        const deployOutcomes = [
            { outcome: "succeeded", deployment, receiptId, activated: true } as const,
            { outcome: "failed", deploymentId, receiptId } as const
        ];
        const runtime: SlateRuntimePort = {
            update: async () => initial,
            commit: async () => version,
            fork: async () => initial,
            publish: async () => publication,
            deploy: async () => deployOutcomes.shift()!,
            rollback: async () => active
        };
        const backend = new SlateRuntimeBackend(runtime);

        await expect(
            backend.update({ slate: slateId.value, source: source.value })
        ).resolves.toMatchObject({ headVersionId: null, activeDeploymentId: null });
        await expect(backend.commit({ slate: slateId.value })).resolves.toEqual({
            versionId: versionId.value,
            slateId: slateId.value,
            source: source.value
        });
        await expect(
            backend.fork({ sourceVersion: versionId.value, workspace: workspace.value })
        ).resolves.toMatchObject({ slateId: slateId.value });
        await expect(
            backend.publish({ version: versionId.value, materialization: source.value })
        ).resolves.toMatchObject({ publicationId: publicationId.value });
        await expect(
            backend.deploy({ publication: publicationId.value, target: "production" }, dispatchFixture())
        ).resolves.toEqual({
            outcome: "succeeded",
            deploymentId: deploymentId.value,
            receiptId: receiptId.value,
            activated: true
        });
        await expect(
            backend.deploy({ publication: publicationId.value, target: "production" }, dispatchFixture())
        ).resolves.toEqual({
            outcome: "failed",
            deploymentId: deploymentId.value,
            receiptId: receiptId.value
        });
        await expect(
            backend.rollback({
                slate: slateId.value,
                deployment: deploymentId.value,
                expectedActiveDeployment: deploymentId.value
            })
        ).resolves.toMatchObject({
            headVersionId: versionId.value,
            activeDeploymentId: deploymentId.value
        });
    });
});

function content(): ContentRef {
    return ContentRef.fromDigest(new Digest("a".repeat(64)));
}
