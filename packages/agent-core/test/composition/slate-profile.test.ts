import { SlateRuntimeBackend, type SlateRuntimePort } from "../../src/composition";
import { EffectDispatch, type BindingRequirement } from "../../src/facets";
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

/** Every runtime argument SlateRuntimeBackend maps a wire field into. */
type MappedSlateArgument =
    | ContentRef
    | Revision
    | SlateDeploymentId
    | SlateId
    | SlatePublicationId
    | SlateVersionId
    | WorkspaceId
    | string
    | readonly BindingRequirement[]
    | undefined;

interface SlateRuntimeCall {
    readonly operation: string;
    readonly values: readonly MappedSlateArgument[];
}

let dispatchCounter = 0;
function dispatchFixture(): EffectDispatch {
    dispatchCounter += 1;
    return new EffectDispatch(`slate-dispatch-${dispatchCounter}`);
}

describe("Slate profile composition", () => {
    test("maps profile wire DTOs to typed SlateRuntime arguments", { tags: "p1" }, async () => {
        const calls: SlateRuntimeCall[] = [];
        const stopped = new TypeError("stop after mapping");
        const capture = (operation: string, values: readonly MappedSlateArgument[]): never => {
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
        await expect(
            backend.rollback({
                slate: "slate",
                deployment: "deployment",
                expectedActiveDeployment: "expected-deployment"
            })
        ).rejects.toBe(stopped);

        // Each wire field maps to one runtime argument of a named class. Comparing the
        // arguments themselves rather than their string values is what keeps a mapping that
        // reached for the right string through the wrong reference class from passing.
        expect(calls).toStrictEqual([
            {
                operation: "update",
                values: [new SlateId("slate"), new ContentRef(source), new Revision(2)]
            },
            { operation: "commit", values: [new SlateId("slate"), new Revision(2)] },
            {
                operation: "fork",
                values: [new SlateVersionId("version"), new WorkspaceId("workspace")]
            },
            {
                operation: "publish",
                // The §11 publish operation declares no capability requirements, so the
                // declared set this mapping carries is empty rather than absent.
                values: [new SlateVersionId("version"), new ContentRef(source), []]
            },
            {
                operation: "deploy",
                values: [
                    new SlatePublicationId("publication"),
                    "production",
                    "dispatch-mapping-key"
                ]
            },
            {
                operation: "rollback",
                values: [new SlateId("slate"), new SlateDeploymentId("deployment"), undefined]
            },
            {
                operation: "rollback",
                values: [
                    new SlateId("slate"),
                    new SlateDeploymentId("deployment"),
                    new SlateDeploymentId("expected-deployment")
                ]
            }
        ]);
    });

    test("maps runtime outcomes and optional profile fields", { tags: "p1" }, async () => {
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
            source,
            []
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
            backend.deploy(
                { publication: publicationId.value, target: "production" },
                dispatchFixture()
            )
        ).resolves.toEqual({
            outcome: "succeeded",
            deploymentId: deploymentId.value,
            receiptId: receiptId.value,
            activated: true
        });
        await expect(
            backend.deploy(
                { publication: publicationId.value, target: "production" },
                dispatchFixture()
            )
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
