// @ts-nocheck
import { Digest, type JsonValue } from "../../core";
import type { InvocationId } from "../../interaction-references";
import {
    Contributions,
    Contribution,
    OperationDescriptor,
    SurfaceDescriptor
} from "../contribution";
import { canonicalFacetData, requireDataObject, requireString } from "../data";
import { OperationName, SlotName, SurfaceId } from "../id";
import type { FacetManifest } from "../manifest";
import {
    DetailedProfileError,
    InternalProfileFacetRuntime,
    ProfileEffectContext,
    ProfileOperationContract,
    facetDataWireCodec,
    profileWireCodec,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema
} from "../profile-runtime";

export interface GatewayObservationInput extends PublicProfileInput {
    readonly resource: string;
}

export interface GatewayActionInput extends PublicProfileInput {
    readonly resource: string;
}

export class ApprovalGatewayAction {
    public readonly action: JsonValue;

    public constructor(
        public readonly invocationId: InvocationId,
        public readonly intentDigest: Digest,
        public readonly resource: string,
        action: JsonValue
    ) {
        if (resource.trim().length === 0 || resource !== resource.trim()) {
            throw new TypeError("Approved resource must be canonical");
        }
        this.action = canonicalFacetData(action);
        Object.freeze(this);
    }

    public actionFor(context: ProfileEffectContext, resource: string): JsonValue {
        if (
            context.attempt === undefined ||
            !context.invocation.equals(this.invocationId) ||
            context.intentDigest?.equals(this.intentDigest) !== true ||
            resource !== this.resource
        ) {
            throw new ApprovalGatewayError(
                "approval.mismatch",
                "Approval does not bind the exact admitted intent"
            );
        }
        return this.action;
    }
}

export abstract class ApprovalGatewayBackend {
    public abstract observe(resource: string): Promise<JsonValue>;
    public abstract apply(
        context: ProfileEffectContext,
        resource: string,
        action: JsonValue
    ): Promise<JsonValue>;
}

const resourceProperty = { type: "string", minLength: 1 } as const;
const inputSchema = strictObjectSchema({ resource: resourceProperty }, ["resource"]);
const inputCodec = profileWireCodec<GatewayObservationInput | GatewayActionInput>(
    (input) => ({ resource: input.resource }),
    (data) => ({
        resource: requireString(
            requireDataObject(data, "Gateway input")["resource"],
            "Gateway resource"
        )
    })
);

export const APPROVAL_GATEWAY_OPERATION_CONTRACTS = Object.freeze({
    observe: new ProfileOperationContract<"observe", GatewayObservationInput, JsonValue>(
        "observe",
        new OperationDescriptor(new OperationName("observe"), "observe", inputSchema, schema({})),
        inputCodec,
        facetDataWireCodec<JsonValue>(),
        "output"
    ),
    applyAction: new ProfileOperationContract<"applyAction", GatewayActionInput, JsonValue>(
        "applyAction",
        new OperationDescriptor(
            new OperationName("applyAction"),
            "externalSend",
            inputSchema,
            schema({})
        ),
        inputCodec,
        facetDataWireCodec<JsonValue>(),
        "output"
    )
});

export const APPROVAL_GATEWAY_OPERATIONS: readonly OperationDescriptor[] = Object.freeze(
    Object.values(APPROVAL_GATEWAY_OPERATION_CONTRACTS).map((contract) => contract.descriptor)
);

export const APPROVAL_GATEWAY_SURFACE = new SurfaceDescriptor(
    new SurfaceId("approval.gateway"),
    "Approvals",
    "Renders whole-intent approval requests and outcomes."
);

export const APPROVAL_GATEWAY_CONTRIBUTIONS = new Contributions([
    new Contribution(
        new SlotName("operations"),
        APPROVAL_GATEWAY_OPERATIONS.map((operation) => operation.toData())
    ),
    new Contribution(new SlotName("surfaces"), [APPROVAL_GATEWAY_SURFACE.toData()])
]);

export const APPROVAL_GATEWAY_ISOLATION = Object.freeze(["provider"] as const);

export class ApprovalGatewayFacet<Receipt> {
    public static readonly operations = APPROVAL_GATEWAY_OPERATIONS;
    public static readonly surface = APPROVAL_GATEWAY_SURFACE;
    public static readonly isolation = APPROVAL_GATEWAY_ISOLATION;

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly approval: ApprovalGatewayAction,
        private readonly backend: ApprovalGatewayBackend
    ) {}

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({
            manifest,
            runtime: this.runtime,
            operations: [
                this.runtime.operation(APPROVAL_GATEWAY_OPERATION_CONTRACTS.observe, (input) =>
                    this.backend.observe(input.resource)
                ),
                this.runtime.operation(
                    APPROVAL_GATEWAY_OPERATION_CONTRACTS.applyAction,
                    (input, context) => {
                        const action = this.approval.actionFor(context, input.resource);
                        return this.backend.apply(context, input.resource, action);
                    }
                )
            ],
            surfaces: [this.runtime.surface(APPROVAL_GATEWAY_SURFACE)]
        });
    }

    public observe(input: GatewayObservationInput): Promise<JsonValue> {
        return this.runtime.invoke(
            APPROVAL_GATEWAY_OPERATION_CONTRACTS.observe,
            input,
            (admitted) => this.backend.observe(admitted.resource)
        );
    }

    public applyAction(input: GatewayActionInput): Promise<JsonValue> {
        return this.runtime.invoke(
            APPROVAL_GATEWAY_OPERATION_CONTRACTS.applyAction,
            input,
            (admitted, context) => {
                const action = this.approval.actionFor(context, admitted.resource);
                return this.backend.apply(context, admitted.resource, action);
            }
        );
    }
}

export type ApprovalGatewayErrorCode = "approval.invalid" | "approval.mismatch";

export class ApprovalGatewayError extends DetailedProfileError<ApprovalGatewayErrorCode> {
    public constructor(detailCode: ApprovalGatewayErrorCode, message: string) {
        super("invocation.invalid", detailCode, message);
        this.name = "ApprovalGatewayError";
    }
}
