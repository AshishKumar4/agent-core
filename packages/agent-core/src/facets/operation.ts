import type { FacetData } from "./data";
import { DataRecordCodec, requireDataObject, requireExactFields, requireString } from "./data";
import { BindingName, FacetRef, OperationName } from "./id";

export class BoundOperationRef {
    public static get codec(): DataRecordCodec<BoundOperationRef> {
        return boundOperationRefCodec;
    }

    public constructor(
        public readonly binding: BindingName,
        public readonly operation: OperationName
    ) {
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): BoundOperationRef {
        const object = requireDataObject(payload, "Bound operation reference");
        requireExactFields(object, ["binding", "operation"]);
        return new BoundOperationRef(
            new BindingName(requireString(object["binding"], "Operation binding")),
            new OperationName(requireString(object["operation"], "Operation name"))
        );
    }

    public equals(other: BoundOperationRef): boolean {
        return this.binding.equals(other.binding) && this.operation.equals(other.operation);
    }

    public toData(): FacetData {
        return { binding: this.binding.value, operation: this.operation.value };
    }
}

export class FacetOperationRef {
    public static get codec(): DataRecordCodec<FacetOperationRef> {
        return facetOperationRefCodec;
    }

    public constructor(
        public readonly facet: FacetRef,
        public readonly operation: OperationName
    ) {
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): FacetOperationRef {
        const object = requireDataObject(payload, "Facet operation reference");
        requireExactFields(object, ["facet", "operation"]);
        return new FacetOperationRef(
            new FacetRef(requireString(object["facet"], "Operation Facet reference")),
            new OperationName(requireString(object["operation"], "Operation name"))
        );
    }

    public equals(other: FacetOperationRef): boolean {
        return this.facet.equals(other.facet) && this.operation.equals(other.operation);
    }

    public toData(): FacetData {
        return { facet: this.facet.value, operation: this.operation.value };
    }
}

const boundOperationRefCodec = new DataRecordCodec<BoundOperationRef>(
    "facet.bound-operation-ref",
    (reference) => reference.toData(),
    (payload) => BoundOperationRef.fromData(payload)
);

const facetOperationRefCodec = new DataRecordCodec<FacetOperationRef>(
    "facet.operation-ref",
    (reference) => reference.toData(),
    (payload) => FacetOperationRef.fromData(payload)
);
