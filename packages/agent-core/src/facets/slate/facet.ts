import type { JsonValue } from "../../core";
import {
    Contributions,
    Contribution,
    OperationDescriptor,
    SurfaceDescriptor
} from "../contribution";
import { requireDataObject, requireSafeInteger, requireString } from "../data";
import type { EnvironmentFacet, EnvironmentPreviewInput } from "../environment";
import { OperationName, SlotName, SurfaceId } from "../id";
import type { FacetManifest } from "../manifest";
import {
    ProfileOperationContract,
    InternalProfileFacetRuntime,
    facetDataWireCodec,
    profileWireCodec,
    type EffectDispatch,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema
} from "../profile-runtime";

export interface SlateUpdateInput extends PublicProfileInput {
    readonly slate: string;
    readonly source: string;
    readonly expectedRevision?: number;
}
export interface SlateCommitInput extends PublicProfileInput {
    readonly slate: string;
    readonly expectedRevision?: number;
}
export interface SlateForkInput extends PublicProfileInput {
    readonly sourceVersion: string;
    readonly workspace: string;
}
export interface SlatePublishInput extends PublicProfileInput {
    readonly version: string;
    readonly materialization: string;
}
export interface SlateDeployInput extends PublicProfileInput {
    readonly publication: string;
    readonly target: string;
}
export interface SlateRollbackInput extends PublicProfileInput {
    readonly slate: string;
    readonly deployment: string;
    readonly expectedActiveDeployment?: string;
}

export abstract class SlateBackend {
    public abstract update(input: SlateUpdateInput): Promise<JsonValue>;
    public abstract commit(input: SlateCommitInput): Promise<JsonValue>;
    public abstract fork(input: SlateForkInput): Promise<JsonValue>;
    public abstract publish(input: SlatePublishInput): Promise<JsonValue>;
    /**
     * Deploys a publication to its target — the profile's one `externalSend` Operation —
     * carrying its canonical effect identity. The provider MUST treat
     * `dispatch.idempotencyKey` as the dedup key for the deployment and MUST be able to
     * answer a reconciliation query addressed by `dispatch.attempt` identity, so a
     * crash-after-send retry neither redeploys nor stays indeterminate (SPEC §7.4).
     */
    public abstract deploy(input: SlateDeployInput, dispatch: EffectDispatch): Promise<JsonValue>;
    public abstract rollback(input: SlateRollbackInput): Promise<JsonValue>;
}

function operation<Name extends string, Input extends PublicProfileInput>(
    name: Name,
    impact: "mutate" | "externalSend",
    inputSchema: ReturnType<typeof strictObjectSchema>,
    inputCodec: ReturnType<typeof profileWireCodec<Input>>
): ProfileOperationContract<Name, Input, JsonValue> {
    return new ProfileOperationContract(
        name,
        new OperationDescriptor(
            new OperationName(name),
            impact,
            inputSchema,
            schema({ type: "object" })
        ),
        inputCodec,
        facetDataWireCodec<JsonValue>(),
        "output"
    );
}

export const SLATE_OPERATION_CONTRACTS = Object.freeze({
    update: operation<"update", SlateUpdateInput>(
        "update",
        "mutate",
        strictObjectSchema(
            {
                slateId: { type: "string", minLength: 1 },
                source: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
                expectedRevision: { type: "integer", minimum: 0 }
            },
            ["slateId", "source"]
        ),
        profileWireCodec(
            (input) => ({
                slateId: input.slate,
                source: input.source,
                ...(input.expectedRevision === undefined
                    ? {}
                    : { expectedRevision: input.expectedRevision })
            }),
            (data) => {
                const input = requireDataObject(data, "Slate update input");
                return {
                    slate: requireString(input["slateId"], "Slate ID"),
                    source: requireString(input["source"], "Slate source"),
                    ...decodeExpectedRevision(input)
                };
            }
        )
    ),
    commit: operation<"commit", SlateCommitInput>(
        "commit",
        "mutate",
        strictObjectSchema(
            {
                slateId: { type: "string", minLength: 1 },
                expectedRevision: { type: "integer", minimum: 0 }
            },
            ["slateId"]
        ),
        profileWireCodec(
            (input) => ({
                slateId: input.slate,
                ...(input.expectedRevision === undefined
                    ? {}
                    : { expectedRevision: input.expectedRevision })
            }),
            (data) => {
                const input = requireDataObject(data, "Slate commit input");
                return {
                    slate: requireString(input["slateId"], "Slate ID"),
                    ...decodeExpectedRevision(input)
                };
            }
        )
    ),
    fork: operation<"fork", SlateForkInput>(
        "fork",
        "mutate",
        strictObjectSchema(
            {
                sourceVersionId: { type: "string", minLength: 1 },
                workspaceId: { type: "string", minLength: 1 }
            },
            ["sourceVersionId", "workspaceId"]
        ),
        profileWireCodec(
            (input) => ({
                sourceVersionId: input.sourceVersion,
                workspaceId: input.workspace
            }),
            (data) => {
                const input = requireDataObject(data, "Slate fork input");
                return {
                    sourceVersion: requireString(
                        input["sourceVersionId"],
                        "Slate source version ID"
                    ),
                    workspace: requireString(input["workspaceId"], "Slate Workspace ID")
                };
            }
        )
    ),
    publish: operation<"publish", SlatePublishInput>(
        "publish",
        "mutate",
        strictObjectSchema(
            {
                versionId: { type: "string", minLength: 1 },
                materialization: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }
            },
            ["versionId", "materialization"]
        ),
        profileWireCodec(
            (input) => ({
                versionId: input.version,
                materialization: input.materialization
            }),
            (data) => {
                const input = requireDataObject(data, "Slate publish input");
                return {
                    version: requireString(input["versionId"], "Slate version ID"),
                    materialization: requireString(
                        input["materialization"],
                        "Slate materialization"
                    )
                };
            }
        )
    ),
    deploy: operation<"deploy", SlateDeployInput>(
        "deploy",
        "externalSend",
        strictObjectSchema(
            {
                publicationId: { type: "string", minLength: 1 },
                target: { type: "string", minLength: 1 }
            },
            ["publicationId", "target"]
        ),
        profileWireCodec(
            (input) => ({ publicationId: input.publication, target: input.target }),
            (data) => {
                const input = requireDataObject(data, "Slate deploy input");
                return {
                    publication: requireString(input["publicationId"], "Slate publication ID"),
                    target: requireString(input["target"], "Slate deployment target")
                };
            }
        )
    ),
    rollback: operation<"rollback", SlateRollbackInput>(
        "rollback",
        "mutate",
        strictObjectSchema(
            {
                slateId: { type: "string", minLength: 1 },
                deploymentId: { type: "string", minLength: 1 },
                expectedActiveDeploymentId: { type: "string", minLength: 1 }
            },
            ["slateId", "deploymentId"]
        ),
        profileWireCodec(
            (input) => ({
                slateId: input.slate,
                deploymentId: input.deployment,
                ...(input.expectedActiveDeployment === undefined
                    ? {}
                    : { expectedActiveDeploymentId: input.expectedActiveDeployment })
            }),
            (data) => {
                const input = requireDataObject(data, "Slate rollback input");
                const expected = input["expectedActiveDeploymentId"];
                return {
                    slate: requireString(input["slateId"], "Slate ID"),
                    deployment: requireString(input["deploymentId"], "Slate deployment ID"),
                    ...(expected === undefined
                        ? {}
                        : {
                              expectedActiveDeployment: requireString(
                                  expected,
                                  "Expected active Slate deployment ID"
                              )
                          })
                };
            }
        )
    )
});

export const SLATE_OPERATIONS: readonly OperationDescriptor[] = Object.freeze(
    Object.values(SLATE_OPERATION_CONTRACTS).map((contract) => contract.descriptor)
);

export const SLATE_ISOLATION = Object.freeze(["dynamic"] as const);
export const SLATE_SURFACES = Object.freeze([
    new SurfaceDescriptor(
        new SurfaceId("slate.publication"),
        "Published Slate",
        "Renders an immutable published Slate version."
    ),
    new SurfaceDescriptor(
        new SurfaceId("slate.embed"),
        "Embedded Slate",
        "Embeds an immutable published Slate version in another Surface."
    )
]);
export const SLATE_CONTRIBUTIONS = new Contributions([
    new Contribution(
        new SlotName("operations"),
        SLATE_OPERATIONS.map((operation) => operation.toData())
    ),
    new Contribution(
        new SlotName("surfaces"),
        SLATE_SURFACES.map((surface) => surface.toData())
    )
]);

export class SlateFacet<Receipt> {
    public static readonly operations = SLATE_OPERATIONS;
    public static readonly isolation = SLATE_ISOLATION;
    public static readonly surfaces = SLATE_SURFACES;

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly backend: SlateBackend,
        private readonly environment: Pick<EnvironmentFacet<Receipt>, "exposePreview">
    ) {}

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({
            manifest,
            runtime: this.runtime,
            operations: [
                this.runtime.operation(SLATE_OPERATION_CONTRACTS.update, (input) =>
                    this.backend.update(input)
                ),
                this.runtime.operation(SLATE_OPERATION_CONTRACTS.commit, (input) =>
                    this.backend.commit(input)
                ),
                this.runtime.operation(SLATE_OPERATION_CONTRACTS.fork, (input) =>
                    this.backend.fork(input)
                ),
                this.runtime.operation(SLATE_OPERATION_CONTRACTS.publish, (input) =>
                    this.backend.publish(input)
                ),
                this.runtime.operation(SLATE_OPERATION_CONTRACTS.deploy, (input, context) =>
                    this.backend.deploy(input, context.dispatch())
                ),
                this.runtime.operation(SLATE_OPERATION_CONTRACTS.rollback, (input) =>
                    this.backend.rollback(input)
                )
            ],
            surfaces: SLATE_SURFACES.map((surface) => this.runtime.surface(surface))
        });
    }

    public update(input: SlateUpdateInput): Promise<JsonValue> {
        return this.runtime.invoke(SLATE_OPERATION_CONTRACTS.update, input, (admitted) =>
            this.backend.update(admitted)
        );
    }

    public commit(input: SlateCommitInput): Promise<JsonValue> {
        return this.runtime.invoke(SLATE_OPERATION_CONTRACTS.commit, input, (admitted) =>
            this.backend.commit(admitted)
        );
    }

    public fork(input: SlateForkInput): Promise<JsonValue> {
        return this.runtime.invoke(SLATE_OPERATION_CONTRACTS.fork, input, (admitted) =>
            this.backend.fork(admitted)
        );
    }

    public publish(input: SlatePublishInput): Promise<JsonValue> {
        return this.runtime.invoke(SLATE_OPERATION_CONTRACTS.publish, input, (admitted) =>
            this.backend.publish(admitted)
        );
    }

    public deploy(input: SlateDeployInput): Promise<JsonValue> {
        return this.runtime.invoke(SLATE_OPERATION_CONTRACTS.deploy, input, (admitted, context) =>
            this.backend.deploy(admitted, context.dispatch())
        );
    }

    public rollback(input: SlateRollbackInput): Promise<JsonValue> {
        return this.runtime.invoke(SLATE_OPERATION_CONTRACTS.rollback, input, (admitted) =>
            this.backend.rollback(admitted)
        );
    }

    public preview(input: EnvironmentPreviewInput): Promise<string> {
        return this.environment.exposePreview(input);
    }
}

function decodeExpectedRevision(input: ReturnType<typeof requireDataObject>): {
    readonly expectedRevision?: number;
} {
    const expected = input["expectedRevision"];
    if (expected === undefined) return {};
    const revision = requireSafeInteger(expected, "Expected Slate revision");
    if (revision < 0) throw new TypeError("Expected Slate revision must not be negative");
    return { expectedRevision: revision };
}
