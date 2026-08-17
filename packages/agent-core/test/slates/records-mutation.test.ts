import { describe, expect, test } from "vitest";
import {
    ContentRef,
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject,
    type JsonValue
} from "../../src/core";
import {
    EnvironmentId,
    EnvironmentSessionCapability,
    EnvironmentSessionId,
    PortExposureId
} from "../../src/environments";
import { InvocationId, ReceiptId } from "../../src/invocations";
import {
    Slate,
    SlateDeployment,
    SlateDeploymentId,
    SlateDeploymentReservation,
    SlateEffectContext,
    SlateId,
    SlatePreview,
    SlatePreviewId,
    SlatePublication,
    SlatePublicationId,
    SlateResource,
    SlateResourceId,
    SlateResourceReservation,
    SlateVersion,
    SlateVersionId,
    canonicalSlateInvocationRequest,
    canonicalSlateMutationRequest,
    freezeSlateInvocationRequest,
    freezeSlateMutationRequest,
    sameSlateInvocationRequest,
    type SlateInvocationRequest,
    type SlateMutationRequest
} from "../../src/slates";
import { WorkspaceId } from "../../src/workspaces";
import { malformed } from "../helpers/malformed";

const workspace = new WorkspaceId("workspace-record-mutation");
const slateId = new SlateId("slate-record-mutation");
const otherSlateId = new SlateId("slate-record-mutation-origin");
const versionId = new SlateVersionId("version-record-mutation");
const parentVersionId = new SlateVersionId("version-record-mutation-parent");
const publicationId = new SlatePublicationId("publication-record-mutation");
const deploymentId = new SlateDeploymentId("deployment-record-mutation");
const resourceId = new SlateResourceId("resource-record-mutation");
const previewId = new SlatePreviewId("preview-record-mutation");
const invocation = new InvocationId("invocation-record-mutation");
const receipt = new ReceiptId("receipt-record-mutation");
const source = ref("source");
const materialization = ref("materialization");
/**
 * The stand-in for a constructor argument that is present but of the wrong type, which
 * every record below must reject field by field.
 *
 * SAFETY: `never` is assignable to every parameter, so one value covers each field in the
 * override tables without claiming to be any of their types. It is only ever passed to a
 * constructor asserted to throw, and never read.
 */
const invalid = {} as never;

describe("Slate record mutation kills", () => {
    test("names every Slate identifier subject exactly", { tags: "p2" }, () => {
        const cases = [
            [() => new SlateId(""), "Slate ID"],
            [() => new SlateVersionId(""), "Slate version ID"],
            [() => new SlatePublicationId(""), "Slate publication ID"],
            [() => new SlateDeploymentId(""), "Slate deployment ID"],
            [() => new SlateResourceId(""), "Slate resource ID"],
            [() => new SlatePreviewId(""), "Slate preview ID"]
        ] as const;
        for (const [construct, subject] of cases) {
            expect(construct).toThrow(
                new TypeError(`${subject} must contain between 1 and 256 characters`)
            );
        }
    });

    test("rejects each malformed constructor field independently", { tags: "p1" }, () => {
        const versionCases = [
            () => new SlateVersion(invalid, workspace, slateId, source),
            () => new SlateVersion(versionId, invalid, slateId, source),
            () => new SlateVersion(versionId, workspace, invalid, source),
            () => new SlateVersion(versionId, workspace, slateId, invalid),
            () => new SlateVersion(versionId, workspace, slateId, source, invalid)
        ];
        for (const construct of versionCases) {
            expect(construct).toThrow(new TypeError("Slate version is malformed"));
        }

        const publicationCases = [
            () =>
                new SlatePublication(invalid, workspace, slateId, versionId, materialization, []),
            () =>
                new SlatePublication(
                    publicationId,
                    invalid,
                    slateId,
                    versionId,
                    materialization,
                    []
                ),
            () =>
                new SlatePublication(
                    publicationId,
                    workspace,
                    invalid,
                    versionId,
                    materialization,
                    []
                ),
            () =>
                new SlatePublication(
                    publicationId,
                    workspace,
                    slateId,
                    invalid,
                    materialization,
                    []
                ),
            () => new SlatePublication(publicationId, workspace, slateId, versionId, invalid, [])
        ];
        for (const construct of publicationCases) {
            expect(construct).toThrow(new TypeError("Slate publication is malformed"));
        }

        const deployment = (
            overrides: Partial<Record<"id" | "ws" | "slate" | "pub" | "mat" | "inv" | "rec", never>>
        ): SlateDeployment =>
            new SlateDeployment(
                overrides.id ?? deploymentId,
                overrides.ws ?? workspace,
                overrides.slate ?? slateId,
                overrides.pub ?? publicationId,
                "production",
                overrides.mat ?? materialization,
                overrides.inv ?? invocation,
                overrides.rec ?? receipt
            );
        for (const overrides of [
            { id: invalid },
            { ws: invalid },
            { slate: invalid },
            { pub: invalid },
            { mat: invalid },
            { inv: invalid },
            { rec: invalid }
        ]) {
            expect(() => deployment(overrides)).toThrow(
                new TypeError("Slate deployment is malformed")
            );
        }

        const resource = (
            overrides: Partial<
                Record<"id" | "ws" | "slate" | "dep" | "src" | "mat" | "inv" | "rec", never>
            >
        ): SlateResource =>
            new SlateResource(
                overrides.id ?? resourceId,
                overrides.ws ?? workspace,
                overrides.slate ?? slateId,
                overrides.dep ?? deploymentId,
                "database",
                overrides.src ?? source,
                overrides.mat ?? materialization,
                overrides.inv ?? invocation,
                overrides.rec ?? receipt
            );
        for (const overrides of [
            { id: invalid },
            { ws: invalid },
            { slate: invalid },
            { dep: invalid },
            { src: invalid },
            { mat: invalid },
            { inv: invalid },
            { rec: invalid }
        ]) {
            expect(() => resource(overrides)).toThrow(new TypeError("Slate resource is malformed"));
        }

        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source,
                    forkedFrom: { slateId: invalid, versionId },
                    revision: Revision.initial()
                })
        ).toThrow(new TypeError("Slate fork reference is invalid"));
        expect(
            () =>
                new Slate({
                    id: slateId,
                    workspaceId: workspace,
                    source,
                    forkedFrom: { slateId: otherSlateId, versionId: invalid },
                    revision: Revision.initial()
                })
        ).toThrow(new TypeError("Slate fork reference is invalid"));
        expect(
            () =>
                new Slate({ id: invalid, workspaceId: workspace, source, revision: Revision.initial() })
        ).toThrow(new TypeError("Slate identity, ownership, source, and revision are required"));
        expect(
            () => new Slate({ id: slateId, workspaceId: workspace, source, revision: invalid })
        ).toThrow(new TypeError("Slate identity, ownership, source, and revision are required"));
    });

    test("rejects malformed preview fields and hollow capabilities", { tags: "p1" }, () => {
        const capability = new EnvironmentSessionCapability(
            new EnvironmentId("environment-preview-mutation"),
            new EnvironmentSessionId("session-preview-mutation"),
            new Revision(2),
            1
        );
        const preview = (overrides: Partial<PreviewFields>): SlatePreview =>
            new SlatePreview(
                overrides.id ?? previewId,
                overrides.ws ?? workspace,
                overrides.slate ?? slateId,
                overrides.cap ?? capability,
                overrides.exp ?? new PortExposureId("exposure-preview-mutation"),
                overrides.src ?? source,
                "version" in overrides ? overrides.version : versionId
            );
        for (const overrides of [
            { id: invalid },
            { ws: invalid },
            { slate: invalid },
            { cap: invalid },
            { exp: invalid },
            { src: invalid },
            { version: invalid }
        ]) {
            expect(() => preview(overrides)).toThrow(new TypeError("Slate preview is malformed"));
        }

        expect(() => preview({ cap: hollowCapability({}) })).toThrow(
            new TypeError("Slate preview is malformed")
        );
        expect(() =>
            preview({ cap: hollowCapability({ environmentId: capability.environmentId }) })
        ).toThrow(new TypeError("Slate preview is malformed"));
        expect(() =>
            preview({
                cap: hollowCapability({
                    environmentId: capability.environmentId,
                    sessionId: capability.sessionId
                })
            })
        ).toThrow(new TypeError("Slate preview is malformed"));
    });

    test("rejects each malformed reservation field independently", { tags: "p1" }, () => {
        const deploymentReservation = (
            overrides: Partial<
                Record<"id" | "ws" | "slate" | "pub" | "mat" | "inv" | "expected", never>
            >
        ): SlateDeploymentReservation => {
            const init = {
                id: overrides.id ?? deploymentId,
                workspaceId: overrides.ws ?? workspace,
                slateId: overrides.slate ?? slateId,
                publicationId: overrides.pub ?? publicationId,
                publicationMaterialization: overrides.mat ?? materialization,
                target: "production",
                externalKey: "external-record-mutation",
                invocationId: overrides.inv ?? invocation
            };
            return new SlateDeploymentReservation(
                "expected" in overrides
                    ? { ...init, expectedActiveDeploymentId: overrides.expected }
                    : init
            );
        };
        for (const overrides of [
            { id: invalid },
            { ws: invalid },
            { slate: invalid },
            { pub: invalid },
            { mat: invalid },
            { inv: invalid },
            { expected: invalid }
        ]) {
            expect(() => deploymentReservation(overrides)).toThrow(
                new TypeError("Slate deployment reservation is malformed")
            );
        }

        const resourceReservation = (
            overrides: Partial<Record<"id" | "ws" | "slate" | "dep" | "mat" | "src" | "inv", never>>
        ): SlateResourceReservation =>
            new SlateResourceReservation({
                id: overrides.id ?? resourceId,
                workspaceId: overrides.ws ?? workspace,
                slateId: overrides.slate ?? slateId,
                deploymentId: overrides.dep ?? deploymentId,
                deploymentMaterialization: overrides.mat ?? materialization,
                name: "database",
                source: overrides.src ?? source,
                invocationId: overrides.inv ?? invocation
            });
        for (const overrides of [
            { id: invalid },
            { ws: invalid },
            { slate: invalid },
            { dep: invalid },
            { mat: invalid },
            { src: invalid },
            { inv: invalid }
        ]) {
            expect(() => resourceReservation(overrides)).toThrow(
                new TypeError("Slate resource reservation is malformed")
            );
        }
    });

    test("text fields admit their exact maximum lengths", { tags: "p1" }, () => {
        const longestName = "n".repeat(256);
        const namedResource = new SlateResource(
            resourceId,
            workspace,
            slateId,
            deploymentId,
            longestName,
            source,
            materialization,
            invocation,
            receipt
        );
        expect(namedResource.name).toBe(longestName);
        expect(
            () =>
                new SlateResource(
                    resourceId,
                    workspace,
                    slateId,
                    deploymentId,
                    "n".repeat(257),
                    source,
                    materialization,
                    invocation,
                    receipt
                )
        ).toThrow(
            new TypeError("Slate resource name must not be blank or exceed 256 characters")
        );

        const longestTarget = "t".repeat(512);
        const deployment = new SlateDeployment(
            deploymentId,
            workspace,
            slateId,
            publicationId,
            longestTarget,
            materialization,
            invocation,
            receipt
        );
        expect(deployment.target).toBe(longestTarget);
        expect(
            () =>
                new SlateDeployment(
                    deploymentId,
                    workspace,
                    slateId,
                    publicationId,
                    "t".repeat(513),
                    materialization,
                    invocation,
                    receipt
                )
        ).toThrow(
            new TypeError("Slate deployment target must not be blank or exceed 512 characters")
        );

        expect(() =>
            new SlateDeploymentReservation({
                id: deploymentId,
                workspaceId: workspace,
                slateId,
                publicationId,
                publicationMaterialization: materialization,
                target: "production",
                externalKey: " ",
                invocationId: invocation
            })
        ).toThrow(
            new TypeError("Slate deployment external key must not be blank or exceed 512 characters")
        );
    });

    test("codec field failures name their exact subjects", { tags: "p1" }, () => {
        const slate = new Slate({
            id: slateId,
            workspaceId: workspace,
            source,
            headVersionId: versionId,
            latestPublicationId: publicationId,
            activeDeploymentId: deploymentId,
            revision: new Revision(3)
        });
        const slatePayload = payloadOf(slate.toData());
        const version = new SlateVersion(versionId, workspace, slateId, source, parentVersionId);
        const versionPayload = payloadOf(version.toData());
        const publication = new SlatePublication(
            publicationId,
            workspace,
            slateId,
            versionId,
            materialization,
            []
        );
        const publicationPayload = payloadOf(publication.toData());
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
        const deploymentPayload = payloadOf(deployment.toData());
        const resource = new SlateResource(
            resourceId,
            workspace,
            slateId,
            deploymentId,
            "database",
            source,
            materialization,
            invocation,
            receipt
        );
        const resourcePayload = payloadOf(resource.toData());
        const preview = new SlatePreview(
            previewId,
            workspace,
            slateId,
            new EnvironmentSessionCapability(
                new EnvironmentId("environment-codec-mutation"),
                new EnvironmentSessionId("session-codec-mutation"),
                new Revision(1),
                2
            ),
            new PortExposureId("exposure-codec-mutation"),
            source,
            versionId
        );
        const previewPayload = payloadOf(preview.toData());

        expectDecodeFailure(
            Slate,
            slate,
            { ...slatePayload, headVersionId: 1 },
            "Invalid slate record: Slate head version ID must be a string"
        );
        expectDecodeFailure(
            Slate,
            slate,
            { ...slatePayload, latestPublicationId: 1 },
            "Invalid slate record: Slate latest publication ID must be a string"
        );
        expectDecodeFailure(
            Slate,
            slate,
            { ...slatePayload, activeDeploymentId: 1 },
            "Invalid slate record: Slate active deployment ID must be a string"
        );
        expectDecodeFailure(
            Slate,
            slate,
            { ...slatePayload, source: 1 },
            "Invalid slate record: Slate source must be a string"
        );
        expectDecodeFailure(
            SlateVersion,
            version,
            { ...versionPayload, parentVersionId: 1 },
            "Invalid slate.version record: Slate parent version ID must be a string"
        );
        expectDecodeFailure(
            SlateVersion,
            version,
            { ...versionPayload, source: 1 },
            "Invalid slate.version record: Slate version source must be a string"
        );
        expectDecodeFailure(
            SlatePublication,
            publication,
            { ...publicationPayload, materialization: 1 },
            "Invalid slate.publication record: Slate publication materialization must be a string"
        );
        expectDecodeFailure(
            SlateDeployment,
            deployment,
            { ...deploymentPayload, materialization: 1 },
            "Invalid slate.deployment record: Slate deployment materialization must be a string"
        );
        expectDecodeFailure(
            SlateDeployment,
            deployment,
            { ...deploymentPayload, target: 1 },
            "Invalid slate.deployment record: Slate deployment target must be a string"
        );
        expectDecodeFailure(
            SlateResource,
            resource,
            { ...resourcePayload, name: 1 },
            "Invalid slate.resource record: Slate resource name must be a string"
        );
        expectDecodeFailure(
            SlateResource,
            resource,
            { ...resourcePayload, source: 1 },
            "Invalid slate.resource record: Slate resource source must be a string"
        );
        expectDecodeFailure(
            SlateResource,
            resource,
            { ...resourcePayload, materialization: 1 },
            "Invalid slate.resource record: Slate resource materialization must be a string"
        );
        expectDecodeFailure(
            SlatePreview,
            preview,
            { ...previewPayload, versionId: 1 },
            "Invalid slate.preview record: Slate preview version ID must be a string"
        );
        expectDecodeFailure(
            SlatePreview,
            preview,
            { ...previewPayload, source: 1 },
            "Invalid slate.preview record: Slate preview source must be a string"
        );
        expectDecodeFailure(
            SlatePreview,
            preview,
            { ...previewPayload, sessionId: 1 },
            "Invalid slate.preview record: Slate preview session ID must be a string"
        );
        expectDecodeFailure(
            SlatePreview,
            preview,
            { ...previewPayload, environmentId: 1 },
            "Invalid slate.preview record: Slate preview environment ID must be a string"
        );
        expectDecodeFailure(
            SlatePreview,
            preview,
            { ...previewPayload, exposureId: 1 },
            "Invalid slate.preview record: Slate preview exposure ID must be a string"
        );
        expectDecodeFailure(
            SlatePreview,
            preview,
            { ...previewPayload, sessionEpoch: -1 },
            "Invalid slate.preview record: Slate preview session epoch must be a non-negative safe integer"
        );
        expectDecodeFailure(
            SlatePreview,
            preview,
            { ...previewPayload, environmentRevision: -1 },
            "Invalid slate.preview record: Slate preview environment revision must be a non-negative safe integer"
        );

        const resourceReservation = new SlateResourceReservation({
            id: resourceId,
            workspaceId: workspace,
            slateId,
            deploymentId,
            deploymentMaterialization: materialization,
            name: "database",
            source,
            invocationId: invocation
        });
        const reservationPayload = payloadOf(resourceReservation.toData());
        expectDecodeFailure(
            SlateResourceReservation,
            resourceReservation,
            { ...reservationPayload, source: 1 },
            "Invalid slate.resource-reservation record: Slate resource source must be a string"
        );
    });

    test(
        "round-trips populated Slates and reservations without dropping optional fields",
        { tags: "p0" },
        () => {
            const populated = new Slate({
                id: slateId,
                workspaceId: workspace,
                source,
                headVersionId: versionId,
                latestPublicationId: publicationId,
                activeDeploymentId: deploymentId,
                forkedFrom: { slateId: otherSlateId, versionId: parentVersionId },
                revision: new Revision(5)
            });
            const decoded = Slate.decode(Slate.encode(populated));
            expect(decoded).toEqual(populated);
            expect(decoded.headVersionId?.value).toBe(versionId.value);
            expect(decoded.latestPublicationId?.value).toBe(publicationId.value);
            expect(decoded.activeDeploymentId?.value).toBe(deploymentId.value);
            expect(decoded.forkedFrom?.slateId.value).toBe(otherSlateId.value);
            expect(decoded.forkedFrom?.versionId.value).toBe(parentVersionId.value);

            const updated = populated.update(ref("next-source"));
            expect(updated.revision.value).toBe(6);
            expect(updated.headVersionId?.value).toBe(versionId.value);
            expect(updated.latestPublicationId?.value).toBe(publicationId.value);
            expect(updated.activeDeploymentId?.value).toBe(deploymentId.value);
            expect(updated.forkedFrom?.slateId.value).toBe(otherSlateId.value);

            const reservation = new SlateDeploymentReservation({
                id: deploymentId,
                workspaceId: workspace,
                slateId,
                publicationId,
                publicationMaterialization: materialization,
                target: "production",
                externalKey: "external-roundtrip",
                invocationId: invocation,
                expectedActiveDeploymentId: new SlateDeploymentId("deployment-previously-active")
            });
            const decodedReservation = SlateDeploymentReservation.decode(
                SlateDeploymentReservation.encode(reservation)
            );
            expect(decodedReservation).toEqual(reservation);
            expect(decodedReservation.expectedActiveDeploymentId?.value).toBe(
                "deployment-previously-active"
            );
        }
    );

    test("static codec entry points and the preview capability round-trip", { tags: "p1" }, () => {
        const capability = new EnvironmentSessionCapability(
            new EnvironmentId("environment-static-codec"),
            new EnvironmentSessionId("session-static-codec"),
            new Revision(4),
            2
        );
        const preview = new SlatePreview(
            previewId,
            workspace,
            slateId,
            capability,
            new PortExposureId("exposure-static-codec"),
            source,
            versionId
        );
        expect(SlatePreview.decode(SlatePreview.encode(preview))).toEqual(preview);
        const rebuilt = preview.capability;
        expect(rebuilt).toBeInstanceOf(EnvironmentSessionCapability);
        expect(rebuilt.environmentId.equals(capability.environmentId)).toBe(true);
        expect(rebuilt.sessionId.equals(capability.sessionId)).toBe(true);
        expect(rebuilt.environmentRevision.equals(capability.environmentRevision)).toBe(true);
        expect(rebuilt.epoch).toBe(capability.epoch);

        const publication = new SlatePublication(
            publicationId,
            workspace,
            slateId,
            versionId,
            materialization,
            []
        );
        expect(SlatePublication.decode(SlatePublication.encode(publication))).toEqual(publication);

        const resource = new SlateResource(
            resourceId,
            workspace,
            slateId,
            deploymentId,
            "database",
            source,
            materialization,
            invocation,
            receipt
        );
        expect(SlateResource.decode(SlateResource.encode(resource))).toEqual(resource);
    });

    test("canonical intents carry every field for every operation", { tags: "p0" }, () => {
        const base = {
            impact: "mutate",
            operation: "unset",
            slateId: slateId.value,
            workspaceId: workspace.value
        };
        const mutationCases: readonly [SlateMutationRequest, JsonValue][] = [
            [
                { operation: "create", impact: "mutate", workspaceId: workspace, slateId, source },
                { ...base, operation: "create", source: source.value }
            ],
            [
                {
                    operation: "update",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    source,
                    expectedRevision: new Revision(2)
                },
                { ...base, operation: "update", expectedRevision: 2, source: source.value }
            ],
            [
                {
                    operation: "commit",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    versionId,
                    source,
                    parentVersionId,
                    expectedRevision: new Revision(3)
                },
                {
                    ...base,
                    operation: "commit",
                    expectedRevision: 3,
                    parentVersionId: parentVersionId.value,
                    source: source.value,
                    versionId: versionId.value
                }
            ],
            [
                {
                    operation: "fork",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    sourceSlateId: otherSlateId,
                    sourceVersionId: parentVersionId,
                    source,
                    expectedSourceRevision: new Revision(4)
                },
                {
                    ...base,
                    operation: "fork",
                    expectedSourceRevision: 4,
                    source: source.value,
                    sourceSlateId: otherSlateId.value,
                    sourceVersionId: parentVersionId.value
                }
            ],
            [
                {
                    operation: "publish",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    publicationId,
                    versionId,
                    source,
                    materialization,
                    bindings: [],
                    expectedRevision: new Revision(5)
                },
                {
                    ...base,
                    operation: "publish",
                    expectedRevision: 5,
                    bindings: [],
                    materialization: materialization.value,
                    publicationId: publicationId.value,
                    source: source.value,
                    versionId: versionId.value
                }
            ],
            [
                {
                    operation: "deploy.reserve",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    deploymentId,
                    publicationId,
                    publicationMaterialization: materialization,
                    target: "production",
                    expectedActiveDeploymentId: deploymentId,
                    invocationId: invocation
                },
                {
                    ...base,
                    operation: "deploy.reserve",
                    deploymentId: deploymentId.value,
                    expectedActiveDeploymentId: deploymentId.value,
                    invocationId: invocation.value,
                    publicationId: publicationId.value,
                    publicationMaterialization: materialization.value,
                    target: "production"
                }
            ],
            [
                {
                    operation: "deploy.finalize",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    deploymentId,
                    publicationId,
                    publicationMaterialization: materialization,
                    target: "production",
                    expectedActiveDeploymentId: undefined,
                    invocationId: invocation,
                    receiptId: receipt,
                    materialization
                },
                {
                    ...base,
                    operation: "deploy.finalize",
                    deploymentId: deploymentId.value,
                    expectedActiveDeploymentId: null,
                    invocationId: invocation.value,
                    materialization: materialization.value,
                    publicationId: publicationId.value,
                    publicationMaterialization: materialization.value,
                    receiptId: receipt.value,
                    target: "production"
                }
            ],
            [
                {
                    operation: "resource.reserve",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    resourceId,
                    deploymentId,
                    deploymentMaterialization: materialization,
                    resourceName: "database",
                    resourceSource: source,
                    invocationId: invocation
                },
                {
                    ...base,
                    operation: "resource.reserve",
                    deploymentId: deploymentId.value,
                    deploymentMaterialization: materialization.value,
                    invocationId: invocation.value,
                    resourceId: resourceId.value,
                    resourceName: "database",
                    resourceSource: source.value
                }
            ],
            [
                {
                    operation: "resource.finalize",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    resourceId,
                    deploymentId,
                    deploymentMaterialization: materialization,
                    resourceName: "database",
                    resourceSource: source,
                    invocationId: invocation,
                    receiptId: receipt,
                    materialization
                },
                {
                    ...base,
                    operation: "resource.finalize",
                    deploymentId: deploymentId.value,
                    deploymentMaterialization: materialization.value,
                    invocationId: invocation.value,
                    materialization: materialization.value,
                    receiptId: receipt.value,
                    resourceId: resourceId.value,
                    resourceName: "database",
                    resourceSource: source.value
                }
            ],
            [
                {
                    operation: "preview.link",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    previewId,
                    source,
                    versionId,
                    environmentId: new EnvironmentId("environment-intent-mutation"),
                    sessionId: new EnvironmentSessionId("session-intent-mutation"),
                    environmentRevision: new Revision(6),
                    sessionEpoch: 7,
                    exposureId: new PortExposureId("exposure-intent-mutation"),
                    expectedRevision: new Revision(8)
                },
                {
                    ...base,
                    operation: "preview.link",
                    environmentId: "environment-intent-mutation",
                    environmentRevision: 6,
                    expectedRevision: 8,
                    exposureId: "exposure-intent-mutation",
                    previewId: previewId.value,
                    sessionEpoch: 7,
                    sessionId: "session-intent-mutation",
                    source: source.value,
                    versionId: versionId.value
                }
            ],
            [
                {
                    operation: "rollback",
                    impact: "mutate",
                    workspaceId: workspace,
                    slateId,
                    deploymentId,
                    expectedActiveDeploymentId: deploymentId,
                    expectedRevision: new Revision(9)
                },
                {
                    ...base,
                    operation: "rollback",
                    deploymentId: deploymentId.value,
                    expectedActiveDeploymentId: deploymentId.value,
                    expectedRevision: 9
                }
            ]
        ];
        for (const [request, expected] of mutationCases) {
            expect(
                decodeCanonicalJson(canonicalSlateMutationRequest(request)),
                request.operation
            ).toEqual(expected);
        }

        const invocationCases: readonly [SlateInvocationRequest, JsonValue][] = [
            [
                {
                    operation: "deploy",
                    impact: "externalSend",
                    workspaceId: workspace,
                    slateId,
                    deploymentId,
                    publicationId,
                    publicationMaterialization: materialization,
                    target: "production",
                    expectedActiveDeploymentId: undefined
                },
                {
                    impact: "externalSend",
                    operation: "deploy",
                    slateId: slateId.value,
                    workspaceId: workspace.value,
                    deploymentId: deploymentId.value,
                    expectedActiveDeploymentId: null,
                    publicationId: publicationId.value,
                    publicationMaterialization: materialization.value,
                    target: "production"
                }
            ],
            [
                {
                    operation: "resource.materialize",
                    impact: "externalSend",
                    workspaceId: workspace,
                    slateId,
                    resourceId,
                    deploymentId,
                    deploymentMaterialization: materialization,
                    resourceName: "database",
                    resourceSource: source
                },
                {
                    impact: "externalSend",
                    operation: "resource.materialize",
                    slateId: slateId.value,
                    workspaceId: workspace.value,
                    deploymentId: deploymentId.value,
                    deploymentMaterialization: materialization.value,
                    resourceId: resourceId.value,
                    resourceName: "database",
                    resourceSource: source.value
                }
            ]
        ];
        for (const [request, expected] of invocationCases) {
            expect(
                decodeCanonicalJson(canonicalSlateInvocationRequest(request)),
                request.operation
            ).toEqual(expected);
        }
    });

    test("compares invocation requests by their canonical bytes", { tags: "p0" }, () => {
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

        expect(sameSlateInvocationRequest(request, { ...request })).toBe(true);
        expect(sameSlateInvocationRequest(request, { ...request, target: "staging" })).toBe(false);
        expect(
            sameSlateInvocationRequest(request, {
                ...request,
                expectedActiveDeploymentId: deploymentId
            })
        ).toBe(false);
    });

    test("intent validation failures carry exact subjects", { tags: "p1" }, () => {
        const incomplete: Partial<SlateMutationRequest> & { readonly wrongField: ContentRef } = {
            operation: "create",
            impact: "mutate",
            workspaceId: workspace,
            slateId,
            wrongField: source
        };
        // SAFETY: `incomplete` states what it is — a create mutation missing the `source`
        // it requires and carrying a field the contract does not declare. It reaches
        // freezeSlateMutationRequest only to be rejected for both at once.
        expect(() =>
            freezeSlateMutationRequest(incomplete as SlateMutationRequest)
        ).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: "Slate intent contains missing or unknown fields"
            })
        );
        expect(() =>
            freezeSlateMutationRequest({
                operation: "commit",
                impact: "mutate",
                workspaceId: workspace,
                slateId,
                versionId,
                source,
                parentVersionId: malformed<SlateVersionId>("bad"),
                expectedRevision: Revision.initial()
            })
        ).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: "Parent Slate version ID is invalid"
            })
        );
        expect(() =>
            freezeSlateMutationRequest({
                operation: "rollback",
                impact: "mutate",
                workspaceId: workspace,
                slateId,
                deploymentId,
                expectedActiveDeploymentId: malformed<SlateDeploymentId>("bad"),
                expectedRevision: Revision.initial()
            })
        ).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: "Expected active Slate deployment ID is invalid"
            })
        );

        const deployIntent = (target: string): SlateInvocationRequest => ({
            operation: "deploy",
            impact: "externalSend",
            workspaceId: workspace,
            slateId,
            deploymentId,
            publicationId,
            publicationMaterialization: materialization,
            target,
            expectedActiveDeploymentId: undefined
        });
        expect(() => freezeSlateInvocationRequest(deployIntent("t".repeat(512)))).not.toThrow();
        expect(() => freezeSlateInvocationRequest(deployIntent("t".repeat(513)))).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: "Slate deployment target must not be blank or exceed 512 characters"
            })
        );

        const resourceIntent = (resourceName: string): SlateInvocationRequest => ({
            operation: "resource.materialize",
            impact: "externalSend",
            workspaceId: workspace,
            slateId,
            resourceId,
            deploymentId,
            deploymentMaterialization: materialization,
            resourceName,
            resourceSource: source
        });
        expect(() => freezeSlateInvocationRequest(resourceIntent("n".repeat(256)))).not.toThrow();
        expect(() => freezeSlateInvocationRequest(resourceIntent("n".repeat(257)))).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: "Slate resource name must not be blank or exceed 256 characters"
            })
        );
        expect(() =>
            freezeSlateInvocationRequest(resourceIntent(malformed<string>(1)))
        ).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: "Slate resource name must not be blank or exceed 256 characters"
            })
        );
    });

    test("effect contexts discriminate their item identity", { tags: "p0" }, () => {
        const context = new SlateEffectContext(invocation, 2, 3, "item-key");

        expect(context.sameItem(new SlateEffectContext(invocation, 2, 9, "item-key"))).toBe(true);
        expect(
            context.sameItem(
                new SlateEffectContext(new InvocationId("invocation-other"), 2, 3, "item-key")
            )
        ).toBe(false);
        expect(context.sameItem(new SlateEffectContext(invocation, 3, 3, "item-key"))).toBe(false);
        expect(context.sameItem(new SlateEffectContext(invocation, 2, 3, "other-key"))).toBe(false);
        expect(() => new SlateEffectContext(invocation, 0, 0, malformed<string>(5))).toThrow(
            new TypeError("Slate effect idempotency key must be canonical")
        );
    });

    test("rejects empty effect idempotency keys", { tags: "p1" }, () => {
        expect(() => new SlateEffectContext(invocation, 0, 0, "")).toThrow(TypeError);
    });

    test("distinguishes same-length canonical invocation encodings", { tags: "p0" }, () => {
        const request = freezeSlateInvocationRequest({
            operation: "deploy",
            impact: "externalSend",
            workspaceId: workspace,
            slateId,
            deploymentId,
            publicationId,
            publicationMaterialization: materialization,
            target: "aa",
            expectedActiveDeploymentId: undefined
        });

        expect(sameSlateInvocationRequest(request, { ...request })).toBe(true);
        expect(sameSlateInvocationRequest(request, { ...request, target: "ab" })).toBe(false);
    });

    test("rejects array and function payload containers outright", { tags: "p2" }, () => {
        const fields = {
            activeDeploymentId: null,
            forkedFrom: null,
            headVersionId: null,
            id: "slate-container",
            latestPublicationId: null,
            revision: 0,
            source: source.value,
            workspaceId: workspace.value
        };

        expect(() => Slate.fromData(payloadContainer(Object.assign([], fields)))).toThrow(
            TypeError
        );
        expect(() =>
            Slate.fromData(payloadContainer(Object.assign(() => undefined, fields)))
        ).toThrow(TypeError);
    });
});

function expectDecodeFailure<Record>(
    recordClass: { encode(record: Record): Uint8Array; decode(bytes: Uint8Array): Record },
    record: Record,
    payload: JsonValue,
    message: string
): void {
    const envelope = payloadOf(decodeCanonicalJson(recordClass.encode(record)));
    const version = payloadOf(fieldOf(envelope, "version"));
    expect(() =>
        recordClass.decode(
            encodeCanonicalJson({
                kind: fieldOf(envelope, "kind"),
                version: { major: fieldOf(version, "major"), minor: fieldOf(version, "minor") },
                payload
            })
        )
    ).toThrowError(expect.objectContaining({ code: "codec.invalid", message }));
}

/**
 * A capability carrying the real prototype and only the fields named, standing in for one
 * rebuilt field by field and left incomplete. A `instanceof` check alone accepts it, so it
 * is what separates a prototype test from a field test.
 */
function hollowCapability(
    fields: Partial<EnvironmentSessionCapability>
): EnvironmentSessionCapability {
    // SAFETY: Object.create returns a bare prototype instance that the constructor never
    // validated, so the required fields it omits are missing on purpose. It only ever
    // reaches SlatePreview, which is asserted to reject it.
    return Object.assign(
        Object.create(EnvironmentSessionCapability.prototype) as EnvironmentSessionCapability,
        fields
    );
}

/** The SlatePreview constructor arguments, each replaceable on its own. */
type PreviewFields = {
    readonly id: SlatePreviewId;
    readonly ws: WorkspaceId;
    readonly slate: SlateId;
    readonly cap: EnvironmentSessionCapability;
    readonly exp: PortExposureId;
    readonly src: ContentRef;
    readonly version: SlateVersionId | undefined;
};

function payloadOf(value: JsonValue): JsonObject {
    if (!isJsonObject(value)) throw new TypeError("Slate record payload must be an object");
    return value;
}

function fieldOf(record: JsonObject, field: string): JsonValue {
    const value = record[field];
    if (value === undefined) throw new TypeError(`Slate record envelope is missing ${field}`);
    return value;
}

/**
 * A payload container carrying a valid record's fields on something that is not a JSON
 * object: an array, or a function. Both reach a decoder as `typeof x === "object"` or as a
 * callable, and both must be turned away before any field is read.
 */
function payloadContainer(container: readonly JsonValue[] | (() => void)): JsonValue {
    // SAFETY: a function is not a JsonValue at all, and an array carrying named fields is
    // not the object payload the decoder expects. Slate.fromData is asserted to reject
    // both, so neither is ever read as JSON.
    return container as JsonValue;
}

function ref(label: string): ContentRef {
    return ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode(label)));
}
