import type { FacetData } from "./data";
import {
    DataRecordCodec,
    dataRecord,
    requireArray,
    requireDataObject,
    requireExactFields,
    requireOptionalString,
    requireString
} from "./data";
import { EventPattern } from "./event";
import { BindingName, FacetPackageId, OperationName, OperationRef } from "./id";
import { FieldMove, JsonPointer, MappingRecord, PayloadMapping } from "./mapping";
import { BoundOperationRef } from "./operation";
import { TextId } from "../core";

export type DedupePolicy = "none" | "event" | "causation" | "payload";
export type AutomationAuthority = "initiator" | "delegated";

export interface AutomationInit {
    readonly source: EventPattern;
    readonly target: OperationRef;
    readonly binding: BindingName;
    readonly mapping?: PayloadMapping | undefined;
    readonly dedupe?: DedupePolicy | undefined;
    readonly authority?: AutomationAuthority | undefined;
}

export class Automation {
    public readonly source: EventPattern;
    public readonly target: OperationRef;
    public readonly binding: BindingName;
    public readonly mapping: PayloadMapping | undefined;
    public readonly dedupe: DedupePolicy | undefined;
    public readonly authority: AutomationAuthority | undefined;
    public readonly operation: BoundOperationRef;

    public constructor(init: AutomationInit) {
        this.source = init.source;
        this.target = init.target;
        this.binding = init.binding;
        this.operation = new BoundOperationRef(init.binding, init.target.operation);
        this.mapping = init.mapping;
        this.dedupe = init.dedupe;
        this.authority = init.authority;
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): Automation {
        const object = requireDataObject(payload, "Automation");
        requireExactFields(
            object,
            ["binding", "source", "target"],
            ["authority", "dedupe", "mapping"]
        );
        const mapping = object["mapping"];
        const dedupe = requireOptionalString(object["dedupe"], "Automation dedupe policy");
        const authority = requireOptionalString(object["authority"], "Automation authority");
        const decodedMapping =
            mapping === undefined
                ? undefined
                : new PayloadMapping(
                      requireArray(mapping, "Automation mapping").map(FieldMove.fromData)
                  );
        return new Automation({
            source: EventPattern.fromData(object["source"]!),
            target: new OperationRef(requireString(object["target"], "Automation target")),
            binding: new BindingName(requireString(object["binding"], "Automation binding")),
            mapping: decodedMapping,
            dedupe: dedupe === undefined ? undefined : requireDedupePolicy(dedupe),
            authority: authority === undefined ? undefined : requireAuthority(authority)
        });
    }

    public static encode(automation: Automation): Uint8Array {
        return automationCodec.encode(automation);
    }

    public static decode(bytes: Uint8Array): Automation {
        return automationCodec.decode(bytes);
    }

    public toData(): FacetData {
        return dataRecord({
            binding: this.binding.value,
            source: this.source.toData(),
            target: this.target.value,
            authority: this.authority,
            dedupe: this.dedupe,
            mapping: this.mapping?.toData()
        });
    }
}

const automationCodec = new DataRecordCodec(
    [
        Automation,
        TextId,
        MappingRecord,
        FieldMove,
        EventPattern,
        OperationRef,
        BindingName,
        FacetPackageId,
        OperationName,
        BoundOperationRef,
        PayloadMapping,
        JsonPointer
    ],
    "facet.automation",
    (automation: Automation) => automation.toData(),
    (payload) => Automation.fromData(payload)
);

function requireDedupePolicy(value: string): DedupePolicy {
    if (value === "none" || value === "event" || value === "causation" || value === "payload") {
        return value;
    }
    throw new TypeError("Automation dedupe policy is invalid");
}

function requireAuthority(value: string): AutomationAuthority {
    if (value === "initiator" || value === "delegated") {
        return value;
    }
    throw new TypeError("Automation authority is invalid");
}
