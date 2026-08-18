import type { FacetData } from "./data";
import {
    DataRecordCodec,
    requireDataObject,
    requireExactFields,
    requireSafeInteger,
    requireString
} from "./data";
import { FacetPackageId, InterceptorId } from "./id";
import { OperationPattern, OperationSelector } from "./mapping";
import { TextId } from "../core";

export type CutPoint =
    "operation.before" | "operation.after" | "prompt.assemble" | "input.submitted" | "turn.step";

export type InterceptorMode = "rewrite" | "gate";

/**
 * SPEC §4.4 rule 3's leading ordering component. A declared mode dominates local
 * priority, so this array — not a number a contributor picks — decides which band an
 * interceptor runs in, and rule 10 makes the `gate` band's read-only claim enforceable.
 */
const interceptorModeOrder: readonly InterceptorMode[] = Object.freeze(["rewrite", "gate"]);

export class InterceptorDeclaration {
    public readonly id: InterceptorId;
    public readonly cutPoint: CutPoint;
    public readonly mode: InterceptorMode;
    public readonly modeRank: number;
    public readonly appliesTo: OperationSelector;
    public readonly priority: number;

    public constructor(
        id: InterceptorId,
        cutPoint: CutPoint,
        mode: InterceptorMode,
        ...selection: [appliesTo: OperationSelector, priority: number] | [priority: number]
    ) {
        const [appliesToOrPriority, priority] = selection;
        const selected = appliesToOrPriority instanceof OperationSelector;
        const resolvedPriority = selected ? priority : appliesToOrPriority;
        if (resolvedPriority === undefined || !Number.isSafeInteger(resolvedPriority)) {
            throw new TypeError("Interceptor priority must be a safe integer");
        }
        const modeRank = interceptorModeOrder.indexOf(mode);
        if (modeRank < 0) throw new TypeError("Interceptor mode is invalid");
        this.id = id;
        this.cutPoint = cutPoint;
        this.mode = mode;
        this.modeRank = modeRank;
        this.appliesTo = selected ? appliesToOrPriority : OperationSelector.own();
        this.priority = resolvedPriority;
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): InterceptorDeclaration {
        const object = requireDataObject(payload, "Interceptor declaration");
        requireExactFields(object, ["cutPoint", "id", "mode", "priority"], ["appliesTo"]);
        const appliesToValue = object["appliesTo"];
        if (appliesToValue !== undefined && !Array.isArray(appliesToValue)) {
            throw new TypeError("Interceptor operation selector must be an array");
        }
        const id = new InterceptorId(requireString(object["id"], "Interceptor ID"));
        const cutPoint = requireCutPoint(object["cutPoint"]);
        const mode = requireMode(object["mode"]);
        const priority = requireSafeInteger(object["priority"], "Interceptor priority");
        return appliesToValue === undefined
            ? new InterceptorDeclaration(id, cutPoint, mode, priority)
            : new InterceptorDeclaration(
                  id,
                  cutPoint,
                  mode,
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
            mode: this.mode,
            priority: this.priority
        };
    }
}

const interceptorDeclarationCodec = new DataRecordCodec(
    [
        InterceptorDeclaration,
        TextId,
        OperationPattern,
        OperationSelector,
        InterceptorId,
        FacetPackageId
    ],
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

function requireMode(value: FacetData | undefined): InterceptorMode {
    const mode = interceptorModeOrder.find((candidate) => candidate === value);
    if (mode === undefined) throw new TypeError("Interceptor mode is invalid");
    return mode;
}
