// @ts-nocheck
import { describe, expect, test } from "vitest";
import {
    ContentRef,
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import {
    EnvironmentId,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    PortExposureId
} from "../../src/environments";
import { AgentCoreError } from "../../src/errors";
import { InvocationId, ReceiptId } from "../../src/invocations";
import {
    Slate,
    SlateDeployment,
    SlateDeploymentId,
    SlateEffectContext,
    SlateId,
    SlatePreview,
    SlatePreviewId,
    SlatePublication,
    SlatePublicationId,
    SlateResource,
    SlateResourceId,
    SlateVersion,
    SlateVersionId,
    freezeSlateInvocationRequest,
    freezeSlateMutationRequest,
    type SlateInvocationRequest,
    type SlateMutationRequest
} from "../../src/slates";
import { WorkspaceId } from "../../src/workspaces";

describe("Slate records", () => {
    const workspace = new WorkspaceId("workspace-records");
    const slateId = new SlateId("slate-records");
    const versionId = new SlateVersionId("version-records");
    const publicationId = new SlatePublicationId("publication-records");
    const deploymentId = new SlateDeploymentId("deployment-records");
    const source = ref("source");
    const materialization = ref("materialization");
    const invocation = new InvocationId("invocation-records");
    const receipt = new ReceiptId("receipt-records");

    const records = [
        [Slate.codec, Slate.initial(slateId, workspace, source)],
        [SlateVersion.codec, new SlateVersion(versionId, workspace, slateId, source)],
        [
            SlatePublication.codec,
            new SlatePublication(publicationId, workspace, slateId, versionId, materialization)
        ],
        [
            SlateDeployment.codec,
            new SlateDeployment(
                deploymentId,
                workspace,
                slateId,
                publicationId,
                "production",
                materialization,
                invocation,
                receipt
            )
        ],
        [
            SlateResource.codec,
            new SlateResource(
                new SlateResourceId("resource-records"),
                workspace,
                slateId,
                deploymentId,
                "database",
                source,
                materialization,
                invocation,
                receipt
            )
        ],
        [
            SlatePreview.codec,
            new SlatePreview(
                new SlatePreviewId("preview-records"),
                workspace,
                slateId,
                new EnvironmentSessionCapability(
                    new EnvironmentId("environment-records"),
                    new EnvironmentSessionId("session-records"),
                    new Revision(3),
                    4
                ),
                new PortExposureId("exposure-records"),
                source,
                versionId
            )
        ]
    ] as const;

    test.each(records)(
        "[slate] [slate.version] [slate.publication] [slate.deployment] [slate.resource] [slate.preview] round-trips strict codec 1.0 records",
        (codec, record) => {
            const bytes = codec.encode(record as never);
            const envelope = object(decodeCanonicalJson(bytes));

            expect(envelope["version"]).toEqual({ major: 1, minor: 0 });
            expect(codec.encode(codec.decode(bytes) as never)).toEqual(bytes);
            expect(Object.isFrozen(codec.decode(bytes))).toBe(true);
        }
    );

    test.each(records)("rejects unknown codec majors", (codec, record) => {
        const envelope = object(decodeCanonicalJson(codec.encode(record as never)));
        const future = encodeCanonicalJson({ ...envelope, version: { major: 2, minor: 0 } });

        expect(() => codec.decode(future)).toThrowError(
            expect.objectContaining({ code: "codec.unknown-major" })
        );
    });

    test("rejects unknown payload fields and invalid cross-field shapes", () => {
        const envelope = object(
            decodeCanonicalJson(Slate.encode(Slate.initial(slateId, workspace, source)))
        );
        const payload = object(envelope["payload"]);

        expect(() =>
            Slate.decode(
                encodeCanonicalJson({
                    ...envelope,
                    payload: { ...payload, unknown: true }
                })
            )
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source,
                    forkedFrom: { slateId, versionId },
                    revision: Revision.initial()
                })
        ).toThrow(TypeError);
        expect(() => new SlateVersion(versionId, workspace, slateId, source, versionId)).toThrow(
            TypeError
        );
        expect(
            () =>
                new SlateDeployment(
                    deploymentId,
                    workspace,
                    slateId,
                    publicationId,
                    " ",
                    materialization,
                    invocation,
                    receipt
                )
        ).toThrow(TypeError);
    });

    test("rejects primitive, mistyped, negative, and malformed Slate codec states", () => {
        const slate = Slate.initial(slateId, workspace, source);
        const envelope = object(decodeCanonicalJson(Slate.encode(slate)));
        const payload = object(envelope["payload"]);
        for (const malformed of [
            null,
            { ...payload, source: 1 },
            { ...payload, revision: -1 },
            { ...payload, forkedFrom: { slateId: slateId.value } }
        ] as const) {
            expect(() =>
                Slate.decode(encodeCanonicalJson({ ...envelope, payload: malformed }))
            ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
        }
    });

    test("rejects malformed identities for every Slate durable record", () => {
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source,
                    headVersionId: publicationId as unknown as SlateVersionId,
                    revision: Revision.initial()
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source,
                    activeDeploymentId: publicationId as unknown as SlateDeploymentId,
                    revision: Revision.initial()
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source,
                    latestPublicationId: deploymentId as unknown as SlatePublicationId,
                    revision: Revision.initial()
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source: "invalid" as unknown as ContentRef,
                    revision: Revision.initial()
                })
        ).toThrow(TypeError);

        expect(
            () =>
                new SlateVersion(versionId, workspace, slateId, "invalid" as unknown as ContentRef)
        ).toThrow(TypeError);
        expect(
            () =>
                new SlatePublication(
                    publicationId,
                    workspace,
                    slateId,
                    versionId,
                    "invalid" as unknown as ContentRef
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new SlateDeployment(
                    deploymentId,
                    workspace,
                    slateId,
                    publicationId,
                    "production",
                    materialization,
                    invocation,
                    "invalid" as unknown as ReceiptId
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new SlateResource(
                    new SlateResourceId("resource-malformed"),
                    workspace,
                    slateId,
                    deploymentId,
                    "database",
                    source,
                    materialization,
                    invocation,
                    "invalid" as unknown as ReceiptId
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new SlatePreview(
                    new SlatePreviewId("preview-malformed"),
                    workspace,
                    slateId,
                    {} as EnvironmentSessionCapability,
                    new PortExposureId("exposure-malformed"),
                    source
                )
        ).toThrow(TypeError);
    });

    test("rejects non-string deployment targets in codec data", () => {
        const deployment = records[3][1] as SlateDeployment;
        const envelope = object(decodeCanonicalJson(SlateDeployment.encode(deployment)));
        const payload = object(envelope["payload"]);
        expect(() =>
            SlateDeployment.decode(
                encodeCanonicalJson({
                    ...envelope,
                    payload: { ...payload, target: 1 }
                })
            )
        ).toThrowError(expect.objectContaining({ code: "codec.invalid" }));
    });

    test("round-trips optional version ancestry and clears an active deployment", () => {
        const child = new SlateVersion(
            new SlateVersionId("version-child"),
            workspace,
            slateId,
            source,
            versionId
        );
        expect(
            SlateVersion.decode(SlateVersion.encode(child)).parentVersionId?.equals(versionId)
        ).toBe(true);

        const active = Slate.initial(slateId, workspace, source).selectDeployment(deploymentId);
        expect(active.selectDeployment(undefined).activeDeploymentId).toBeUndefined();
    });

    test("uses ContentRef values for every source and materialization", () => {
        const version = records[1][1] as SlateVersion;
        const publication = records[2][1] as SlatePublication;
        const deployment = records[3][1] as SlateDeployment;
        const resource = records[4][1] as SlateResource;
        const preview = records[5][1] as SlatePreview;

        expect(version.source).toBeInstanceOf(ContentRef);
        expect(publication.materialization).toBeInstanceOf(ContentRef);
        expect(deployment.materialization).toBeInstanceOf(ContentRef);
        expect(resource.source).toBeInstanceOf(ContentRef);
        expect(resource.materialization).toBeInstanceOf(ContentRef);
        expect(preview.source).toBeInstanceOf(ContentRef);
        expect(preview.environmentRevision.value).toBe(3);
        expect(preview.sessionEpoch).toBe(4);
        expect(preview.exposureId).toBeInstanceOf(PortExposureId);
    });

    test("canonical intents reject unknown fields and unbranded identifiers", () => {
        const request = freezeSlateInvocationRequest({
            operation: "deploy",
            impact: "externalSend",
            workspaceId: workspace,
            slateId,
            deploymentId,
            publicationId,
            publicationMaterialization: materialization,
            target: "production",
            expectedActiveDeploymentId: undefined
        });
        expect(Object.isFrozen(request)).toBe(true);
        expect(() =>
            freezeSlateInvocationRequest({
                ...request,
                unknown: true
            } as SlateInvocationRequest)
        ).toThrow(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate intent contains missing or unknown fields"
            )
        );
        expect(() =>
            freezeSlateInvocationRequest({
                ...request,
                workspaceId: { value: workspace.value }
            } as SlateInvocationRequest)
        ).toThrow(new AgentCoreError("operation.invalid-input", "Slate Workspace ID is invalid"));
        expect(() =>
            freezeSlateInvocationRequest({
                ...request,
                impact: "mutate"
            } as unknown as SlateInvocationRequest)
        ).toThrow(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate deploy invocation impact must be externalSend"
            )
        );
        expect(() =>
            freezeSlateInvocationRequest({
                operation: "resource.materialize",
                impact: "mutate",
                workspaceId: workspace,
                slateId,
                resourceId: new SlateResourceId("resource-invalid-impact"),
                deploymentId,
                deploymentMaterialization: materialization,
                resourceName: "database",
                resourceSource: source
            } as unknown as SlateInvocationRequest)
        ).toThrow(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate resource invocation impact must be externalSend"
            )
        );
        expect(() =>
            freezeSlateInvocationRequest({
                ...request,
                target: " "
            })
        ).toThrow(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate deployment target must not be blank or exceed 512 characters"
            )
        );

        expect(() =>
            freezeSlateMutationRequest({
                operation: "create",
                impact: "externalSend",
                workspaceId: workspace,
                slateId,
                source
            } as unknown as SlateMutationRequest)
        ).toThrow(
            new AgentCoreError("operation.invalid-input", "Slate mutation impact must be mutate")
        );
        expect(() =>
            freezeSlateMutationRequest({
                operation: "preview.link",
                impact: "mutate",
                workspaceId: workspace,
                slateId,
                previewId: new SlatePreviewId("preview-invalid-epoch"),
                source,
                versionId: undefined,
                environmentId: new EnvironmentId("environment-invalid-epoch"),
                sessionId: new EnvironmentSessionId("session-invalid-epoch"),
                environmentRevision: Revision.initial(),
                sessionEpoch: -1,
                exposureId: new PortExposureId("exposure-invalid-epoch"),
                expectedRevision: Revision.initial()
            })
        ).toThrow(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate preview session epoch must be a non-negative safe integer"
            )
        );
    });

    test("codes Slate operation failures while constructors remain TypeError", () => {
        const slate = Slate.initial(slateId, workspace, source);
        expect(() => slate.update(source)).toThrow(
            new AgentCoreError("operation.invalid-input", "Slate update must change its source")
        );
        const committed = slate.commit(versionId);
        expect(() => committed.commit(versionId)).toThrow(
            new AgentCoreError("protocol.duplicate", "Slate version is already the current head")
        );
        const published = slate.publish(publicationId);
        expect(() => published.publish(publicationId)).toThrow(
            new AgentCoreError("protocol.duplicate", "Slate publication is already current")
        );
        expect(() => slate.selectDeployment(undefined)).toThrow(
            new AgentCoreError("operation.invalid-input", "Slate has no active deployment to clear")
        );
        const deployed = slate.selectDeployment(deploymentId);
        expect(() => deployed.selectDeployment(deploymentId)).toThrow(
            new AgentCoreError("protocol.duplicate", "Slate deployment is already active")
        );
        expect(() =>
            new Slate({
                id: slateId,
                workspaceId: workspace,
                source,
                revision: new Revision(Number.MAX_SAFE_INTEGER)
            }).update(ref("next"))
        ).toThrow(new AgentCoreError("protocol.invalid-state", "Slate revision is exhausted"));

        expect(() => new SlateVersion(versionId, workspace, slateId, source, versionId)).toThrow(
            TypeError
        );
    });

    test("validates and freezes Slate effect context identity", () => {
        const invocationId = new InvocationId("invocation-effect-context");
        const context = new SlateEffectContext(invocationId, 2, 3, "item-key");
        const retry = new SlateEffectContext(invocationId, 2, 4, "item-key");

        expect(Object.isFrozen(context)).toBe(true);
        expect(context.sameItem(retry)).toBe(true);
        expect(() => new SlateEffectContext({} as InvocationId, 0, 0, "item-key")).toThrow(
            TypeError
        );
        expect(() => new SlateEffectContext(invocationId, -1, 0, "item-key")).toThrow(TypeError);
        expect(() => new SlateEffectContext(invocationId, 0, -1, "item-key")).toThrow(TypeError);
        expect(() => new SlateEffectContext(invocationId, 0, 0, " item-key ")).toThrow(TypeError);
    });
});

function ref(label: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(label)));
}

function object(value: JsonValue | undefined): { readonly [key: string]: JsonValue } {
    if (
        value === undefined ||
        value === null ||
        Array.isArray(value) ||
        typeof value !== "object"
    ) {
        throw new TypeError("Expected JSON object");
    }
    return value as { readonly [key: string]: JsonValue };
}
