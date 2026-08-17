import { describe, expect, test } from "vitest";
import {
    CompatRange,
    ContentRef,
    Digest,
    Revision,
    SecretRef,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject,
    type JsonValue
} from "../../src/core";
import { Blueprint, BlueprintMeta, PolicySet } from "../../src/definition";
import { BindingName, BindingRequirement, FacetPackageId } from "../../src/facets";
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
    SlateSkeleton,
    SlateVersion,
    SlateVersionId,
    freezeSlateInvocationRequest,
    freezeSlateMutationRequest,
    type SlateInvocationRequest
} from "../../src/slates";
import { WorkspaceId } from "../../src/workspaces";
import { codecCase } from "../helpers/codec-case";
import { malformed, violating } from "../helpers/malformed";

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

    const memory = new BindingRequirement(
        new BindingName("memory"),
        new FacetPackageId("core.memory"),
        new CompatRange("^1.0.0", "^1.0.0")
    );
    const deployer = new BindingRequirement(
        new BindingName("acme.deploy"),
        new FacetPackageId("acme.deploy"),
        new CompatRange("^2.0.0", "^1.0.0")
    );
    const skeleton = new SlateSkeleton(source.digest, [memory, deployer]);

    const slate = Slate.initial(slateId, workspace, source);
    const version = new SlateVersion(versionId, workspace, slateId, source);
    const publication = new SlatePublication(
        publicationId,
        workspace,
        slateId,
        versionId,
        materialization,
        []
    );
    const deployment = new SlateDeployment(
        deploymentId,
        workspace,
        slateId,
        publicationId,
        "production",
        materialization,
        invocation,
        receipt
    );
    const resource = new SlateResource(
        new SlateResourceId("resource-records"),
        workspace,
        slateId,
        deploymentId,
        "database",
        source,
        materialization,
        invocation,
        receipt
    );
    const preview = new SlatePreview(
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
    );

    const records = [
        { name: "[slate]", ...codecCase(Slate.codec, slate) },
        { name: "[slate.version]", ...codecCase(SlateVersion.codec, version) },
        { name: "[slate.publication]", ...codecCase(SlatePublication.codec, publication) },
        { name: "[slate.deployment]", ...codecCase(SlateDeployment.codec, deployment) },
        { name: "[slate.resource]", ...codecCase(SlateResource.codec, resource) },
        { name: "[slate.preview]", ...codecCase(SlatePreview.codec, preview) },
        { name: "[slate.skeleton]", ...codecCase(SlateSkeleton.codec, skeleton) }
    ] as const;

    test.each(records)("$name round-trips a strict codec 1.0 record", { tags: "p1" }, (subject) => {
        const bytes = subject.encode();
        const envelope = object(decodeCanonicalJson(bytes));

        expect(envelope["version"]).toEqual({ major: 1, minor: 0 });
        expect(subject.reencode(bytes)).toEqual(bytes);
        expect(subject.decodeIsFrozen(bytes)).toBe(true);
    });

    test.each(records)("$name rejects unknown codec majors", { tags: "p1" }, (subject) => {
        const envelope = object(decodeCanonicalJson(subject.encode()));
        const future = encodeCanonicalJson({ ...envelope, version: { major: 2, minor: 0 } });

        expect(() => subject.decode(future)).toThrowError(
            expect.objectContaining({ code: "codec.unknown-major" })
        );
    });

    test("rejects unknown payload fields and invalid cross-field shapes", { tags: "p1" }, () => {
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

    test("rejects primitive, mistyped, negative, and malformed Slate codec states", { tags: "p1" }, () => {
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

    test("rejects malformed identities for every Slate durable record", { tags: "p1" }, () => {
        // Every TextId subclass declares the same members, so TypeScript accepts one
        // branded identity wherever another is asked for. Nothing but the runtime brand
        // check separates these calls from correct ones, which is what they exercise.
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source,
                    headVersionId: publicationId,
                    revision: Revision.initial()
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source,
                    activeDeploymentId: publicationId,
                    revision: Revision.initial()
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source,
                    latestPublicationId: deploymentId,
                    revision: Revision.initial()
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source: malformed<ContentRef>("invalid"),
                    revision: Revision.initial()
                })
        ).toThrow(TypeError);

        expect(
            () =>
                new SlateVersion(versionId, workspace, slateId, malformed<ContentRef>("invalid"))
        ).toThrow(TypeError);
        expect(
            () =>
                new SlatePublication(
                    publicationId,
                    workspace,
                    slateId,
                    versionId,
                    malformed<ContentRef>("invalid"),
                    []
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
                    malformed<ReceiptId>("invalid")
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
                    malformed<ReceiptId>("invalid")
                )
        ).toThrow(TypeError);
        expect(
            () =>
                new SlatePreview(
                    new SlatePreviewId("preview-malformed"),
                    workspace,
                    slateId,
                    malformed<EnvironmentSessionCapability>({}),
                    new PortExposureId("exposure-malformed"),
                    source
                )
        ).toThrow(TypeError);
    });

    test("rejects non-string deployment targets in codec data", { tags: "p1" }, () => {
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

    test("round-trips optional version ancestry and clears an active deployment", { tags: "p1" }, () => {
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

    test("uses ContentRef values for every source and materialization", { tags: "p1" }, () => {
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

    test("canonical intents reject unknown fields and unbranded identifiers", { tags: "p1" }, () => {
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
        // SAFETY: a request carrying a field the contract does not declare. The excess is
        // what freezeSlateInvocationRequest must reject, and no well-typed value has it.
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
        // SAFETY: a request whose Workspace ID is a bare `{ value }` rather than the
        // branded identity, standing in for one that survived an encoding round trip
        // without being reconstructed.
        expect(() =>
            freezeSlateInvocationRequest({
                ...request,
                workspaceId: { value: workspace.value }
            } as SlateInvocationRequest)
        ).toThrow(new AgentCoreError("operation.invalid-input", "Slate Workspace ID is invalid"));
        expect(() =>
            freezeSlateInvocationRequest(violating(request, { impact: "mutate" }))
        ).toThrow(
            new AgentCoreError(
                "operation.invalid-input",
                "Slate deploy invocation impact must be externalSend"
            )
        );
        const resourceRequest = freezeSlateInvocationRequest({
            operation: "resource.materialize",
            impact: "externalSend",
            workspaceId: workspace,
            slateId,
            resourceId: new SlateResourceId("resource-invalid-impact"),
            deploymentId,
            deploymentMaterialization: materialization,
            resourceName: "database",
            resourceSource: source
        });
        expect(() =>
            freezeSlateInvocationRequest(violating(resourceRequest, { impact: "mutate" }))
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

        const createRequest = freezeSlateMutationRequest({
            operation: "create",
            impact: "mutate",
            workspaceId: workspace,
            slateId,
            source
        });
        expect(() =>
            freezeSlateMutationRequest(violating(createRequest, { impact: "externalSend" }))
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

    test("codes Slate operation failures while constructors remain TypeError", { tags: "p1" }, () => {
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

    test("validates and freezes Slate effect context identity", { tags: "p0" }, () => {
        const invocationId = new InvocationId("invocation-effect-context");
        const context = new SlateEffectContext(invocationId, 2, 3, "item-key");
        const retry = new SlateEffectContext(invocationId, 2, 4, "item-key");

        expect(Object.isFrozen(context)).toBe(true);
        expect(context.sameItem(retry)).toBe(true);
        expect(() =>
            new SlateEffectContext(malformed<InvocationId>({}), 0, 0, "item-key")
        ).toThrow(TypeError);
        expect(() => new SlateEffectContext(invocationId, -1, 0, "item-key")).toThrow(TypeError);
        expect(() => new SlateEffectContext(invocationId, 0, -1, "item-key")).toThrow(TypeError);
        expect(() => new SlateEffectContext(invocationId, 0, 0, " item-key ")).toThrow(TypeError);
    });

    test(
        "[C13-SLATE-SKELETON-CREDENTIAL-FREE] [slate.skeleton] admits no credential, no resolved Binding, and no resolvable reference",
        { tags: "p0" },
        () => {
            // A credential the publishing Workspace legitimately holds. Nothing about it
            // may reach an export: the ref conveys no authority outside its own Tenant and
            // recorded consumer (C13-CONFIG-SECRET-CUSTODY), but it still names a
            // credential's identity and topology, so absence rather than inertness is the
            // only sound outcome.
            const secret = new SecretRef("tenant-records", "acme-vault", "deploy-key");
            const encoded = new TextDecoder().decode(SlateSkeleton.encode(skeleton));
            for (const component of [secret.source, secret.provider, secret.id]) {
                expect(encoded).not.toContain(component);
            }
            // Nor may the export name where it came from, which is what would make a
            // cross-Scope admission a lineage or retainer edge.
            for (const leaked of [workspace.value, slateId.value, publicationId.value]) {
                expect(encoded).not.toContain(leaked);
            }
            expect(encoded).not.toContain("sha256:");

            const payload = object(object(decodeCanonicalJson(SlateSkeleton.encode(skeleton)))["payload"]);
            expect(Object.keys(payload)).toEqual(["bindings", "sourceDigest"]);

            // Every shape that could smuggle one is refused at the exact key set rather
            // than tolerated and ignored, so a producer cannot attach a credential field a
            // future consumer starts reading.
            for (const smuggled of [
                { ...payload, secrets: [{ $secret: "acme/deploy-key" }] },
                { ...payload, credentials: { apiKey: "live-key" } },
                { ...payload, workspaceId: workspace.value },
                { ...payload, source: source.value },
                {
                    ...payload,
                    bindings: [{ ...object(memory.toData()), secret: { $secret: "acme/key" } }]
                }
            ]) {
                expect(() => SlateSkeleton.fromData(smuggled)).toThrow(TypeError);
            }

            // A ContentRef where the digest belongs is refused, so a skeleton can never
            // carry a reference that resolves through some Tenant's ContentStore.
            expect(() =>
                SlateSkeleton.fromData({ ...payload, sourceDigest: source.value })
            ).toThrow(TypeError);
            expect(() => new SlateSkeleton(malformed<Digest>(source.value), [])).toThrow(TypeError);

            // The declared set is canonical and unique by name: a name declared twice
            // leaves which entry a consumer must bind undecided.
            expect(new SlateSkeleton(source.digest, [deployer, memory]).toData()).toEqual(
                skeleton.toData()
            );
            expect(skeleton.bindings.map((requirement) => requirement.name.value)).toEqual([
                "acme.deploy",
                "memory"
            ]);
            expect(() => new SlateSkeleton(source.digest, [memory, memory])).toThrow(
                new TypeError("Slate skeleton bindings declares memory more than once")
            );
            expect(Object.isFrozen(skeleton.bindings)).toBe(true);
            expect(() => new SlateSkeleton(source.digest, malformed([memory.toData()]))).toThrow(
                TypeError
            );
        }
    );

    test(
        "[C13-SLATE-SKELETON-ARTIFACT] a Blueprint declares no Slates, so skeleton export is its own artifact",
        { tags: "p1" },
        () => {
            const declaration = new Blueprint({
                meta: new BlueprintMeta("records-platform", new SemVer("1.2.0")),
                packages: [],
                policies: PolicySet.empty(),
                agents: []
            }).toData();

            // The control: this exact declaration is admissible.
            expect(Blueprint.fromData(declaration)).toBeInstanceOf(Blueprint);
            // Adding Slates to it is not, so a Blueprint can never be the vehicle for a
            // Slate and §9.3 materialization is never asked to place one.
            expect(() =>
                Blueprint.fromData({ ...object(declaration), slates: [] })
            ).toThrow(TypeError);
            expect(() =>
                Blueprint.fromData({
                    ...object(declaration),
                    slates: [{ sourceDigest: source.digest.value, bindings: [] }]
                })
            ).toThrow(TypeError);
        }
    );
});

function ref(label: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(label)));
}

function object(value: JsonValue | undefined): JsonObject {
    if (!isJsonObject(value)) throw new TypeError("Expected JSON object");
    return value;
}
