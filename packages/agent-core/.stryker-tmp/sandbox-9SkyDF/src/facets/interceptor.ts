// @ts-nocheck
import type { FacetData } from "./data";
import {
    DataRecordCodec,
    requireDataObject,
    requireExactFields,
    requireSafeInteger,
    requireString
} from "./data";
import { InterceptorId } from "./id";
import { OperationPattern, OperationSelector } from "./mapping";

export type CutPoint =
    "operation.before" | "operation.after" | "prompt.assemble" | "input.submitted" | "turn.step";

export class InterceptorDeclaration {
    public readonly id: InterceptorId;
    public readonly cutPoint: CutPoint;
    public readonly appliesTo: OperationSelector;
    public readonly priority: number;

    public constructor(
        id: InterceptorId,
        cutPoint: CutPoint,
        ...selection: [appliesTo: OperationSelector, priority: number] | [priority: number]
    ) {
        const [appliesToOrPriority, priority] = selection;
        const resolvedPriority =
            typeof appliesToOrPriority === "number" ? appliesToOrPriority : priority;
        if (resolvedPriority === undefined || !Number.isSafeInteger(resolvedPriority)) {
            throw new TypeError("Interceptor priority must be a safe integer");
        }
        this.id = id;
        this.cutPoint = cutPoint;
        this.appliesTo =
            typeof appliesToOrPriority === "number" ? OperationSelector.own() : appliesToOrPriority;
        this.priority = resolvedPriority;
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): InterceptorDeclaration {
        const object = requireDataObject(payload, "Interceptor declaration");
        requireExactFields(object, ["cutPoint", "id", "priority"], ["appliesTo"]);
        const appliesToValue = object["appliesTo"];
        if (appliesToValue !== undefined && !Array.isArray(appliesToValue)) {
            throw new TypeError("Interceptor operation selector must be an array");
        }
        const id = new InterceptorId(requireString(object["id"], "Interceptor ID"));
        const cutPoint = requireCutPoint(object["cutPoint"]);
        const priority = requireSafeInteger(object["priority"], "Interceptor priority");
        return appliesToValue === undefined
            ? new InterceptorDeclaration(id, cutPoint, priority)
            : new InterceptorDeclaration(
                  id,
                  cutPoint,
                  new OperationSelector(appliesToValue.map(OperationPattern.fromData)),
                  priority
              );
    }

    public static encode(interceptor: InterceptorDeclaration): Uint8Array {
        return interceptorDeclarationCodec.encode(interceptor);
    }

    public static decode(bytes: Uint8Array): InterceptorDeclaration {
        return interceptorDeclarationCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            appliesTo: this.appliesTo.toData(),
            cutPoint: this.cutPoint,
            id: this.id.value,
            priority: this.priority
        };
    }
}

const interceptorDeclarationCodec = new DataRecordCodec(
    "facet.interceptor-declaration",
    (interceptor: InterceptorDeclaration) => interceptor.toData(),
    (payload) => InterceptorDeclaration.fromData(payload)
);

function requireCutPoint(value: FacetData | undefined): CutPoint {
    if (
        value === "operation.before" ||
        value === "operation.after" ||
        value === "prompt.assemble" ||
        value === "input.submitted" ||
        value === "turn.step"
    ) {
        return value;
    }
    throw new TypeError("Interceptor cut point is invalid");
}
