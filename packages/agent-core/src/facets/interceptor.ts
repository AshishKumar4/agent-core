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

/** The cut points whose value in flight belongs to one Operation of one target Facet. */
export type OperationCutPoint = "operation.before" | "operation.after";

/**
 * The cut points whose value in flight belongs to a Turn rather than to an Operation
 * (SPEC §4.4). The distinction is drawn once, here, because three separate rules turn on
 * it: the context carries a Turn instead of an Operation, an `OperationSelector` has
 * nothing to select, and cross-facet opt-in cannot scope what has no target.
 */
export type TurnBoundCutPoint = "prompt.assemble" | "input.submitted" | "turn.step";

export type CutPoint = OperationCutPoint | TurnBoundCutPoint;

export type InterceptorMode = "rewrite" | "gate";

export const TURN_BOUND_CUT_POINTS: readonly TurnBoundCutPoint[] = Object.freeze([
    "prompt.assemble",
    "input.submitted",
    "turn.step"
]);

export function isTurnBoundCutPoint(cutPoint: CutPoint): cutPoint is TurnBoundCutPoint {
    return TURN_BOUND_CUT_POINTS.some((candidate) => candidate === cutPoint);
}

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
        // SPEC §4.4: a Turn-bound cut point has no target Operation, so a selector there
        // names nothing. Refusing a supplied one keeps the absence of scoping a declared
        // fact rather than a silently ignored claim; the default wildcard stands because
        // every declaration carries one and none of them selects at these cut points.
        const [only] = this.appliesTo.patterns;
        if (
            isTurnBoundCutPoint(cutPoint) &&
            (this.appliesTo.patterns.length !== 1 ||
                only?.facet !== undefined ||
                only?.operation !== "*")
        ) {
            throw new TypeError(
                "A Turn-bound cut point selects no Operation, so its interceptor declares no operation selector"
            );
        }
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
