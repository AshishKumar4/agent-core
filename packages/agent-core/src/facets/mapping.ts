import type { FacetData } from "./data";
import {
    DataRecordCodec,
    canonicalFacetData,
    compareText,
    requireArray,
    requireDataObject,
    requireExactFields,
    requireOptionalString,
    requireString
} from "./data";
import { FacetPackageId } from "./id";

export class FieldMove {
    public readonly from: string | undefined;
    public readonly literal: FacetData | undefined;

    public constructor(
        public readonly to: string,
        init: { readonly from: string } | { readonly literal: FacetData }
    ) {
        requireJsonPointer(to, "Field move target");
        const keys = Object.keys(init);
        if (keys.length !== 1 || (keys[0] !== "from" && keys[0] !== "literal")) {
            throw new TypeError("Field move requires exactly one of from or literal");
        }
        if ("from" in init) {
            requireJsonPointer(init.from, "Field move source");
            this.from = init.from;
            this.literal = undefined;
        } else {
            this.from = undefined;
            this.literal = canonicalFacetData(init.literal);
        }
        Object.freeze(this);
    }

    public static fromData(payload: FacetData): FieldMove {
        const object = requireDataObject(payload, "Field move");
        requireExactFields(object, ["to"], ["from", "literal"]);
        const hasFrom = "from" in object;
        const hasLiteral = "literal" in object;
        if (hasFrom === hasLiteral) {
            throw new TypeError("Field move requires exactly one of from or literal");
        }
        const to = requireString(object["to"], "Field move target");
        return hasFrom
            ? new FieldMove(to, { from: requireString(object["from"], "Field move source") })
            : new FieldMove(to, { literal: object["literal"]! });
    }

    public static encode(move: FieldMove): Uint8Array {
        return fieldMoveCodec.encode(move);
    }

    public static decode(bytes: Uint8Array): FieldMove {
        return fieldMoveCodec.decode(bytes);
    }

    public toData(): FacetData {
        return this.from === undefined
            ? { literal: this.literal!, to: this.to }
            : { from: this.from, to: this.to };
    }
}

const fieldMoveCodec = new DataRecordCodec(
    "facet.field-move",
    (move: FieldMove) => move.toData(),
    (payload) => FieldMove.fromData(payload)
);

abstract class MappingRecord {
    public readonly moves: readonly FieldMove[];

    protected constructor(moves: readonly FieldMove[]) {
        this.moves = Object.freeze([...moves]);
    }

    public toData(): FacetData {
        return this.moves.map((move) => move.toData());
    }
}

export class FieldMapping extends MappingRecord {
    public constructor(moves: readonly FieldMove[]) {
        super(moves);
        Object.freeze(this);
    }

    public static encode(mapping: FieldMapping): Uint8Array {
        return fieldMappingCodec.encode(mapping);
    }

    public static decode(bytes: Uint8Array): FieldMapping {
        return fieldMappingCodec.decode(bytes);
    }
}

const fieldMappingCodec = new DataRecordCodec(
    "facet.field-mapping",
    (mapping: FieldMapping) => mapping.toData(),
    (payload) => new FieldMapping(decodeMoves(payload, "Field mapping"))
);

export class PayloadMapping extends MappingRecord {
    public constructor(moves: readonly FieldMove[]) {
        super(moves);
        Object.freeze(this);
    }

    public static encode(mapping: PayloadMapping): Uint8Array {
        return payloadMappingCodec.encode(mapping);
    }

    public static decode(bytes: Uint8Array): PayloadMapping {
        return payloadMappingCodec.decode(bytes);
    }
}

const payloadMappingCodec = new DataRecordCodec(
    "facet.payload-mapping",
    (mapping: PayloadMapping) => mapping.toData(),
    (payload) => new PayloadMapping(decodeMoves(payload, "Payload mapping"))
);

export class ProvenanceMapping extends MappingRecord {
    public constructor(moves: readonly FieldMove[]) {
        super(moves);
        Object.freeze(this);
    }

    public static encode(mapping: ProvenanceMapping): Uint8Array {
        return provenanceMappingCodec.encode(mapping);
    }

    public static decode(bytes: Uint8Array): ProvenanceMapping {
        return provenanceMappingCodec.decode(bytes);
    }
}

const provenanceMappingCodec = new DataRecordCodec(
    "facet.provenance-mapping",
    (mapping: ProvenanceMapping) => mapping.toData(),
    (payload) => new ProvenanceMapping(decodeMoves(payload, "Provenance mapping"))
);

export class OperationPattern {
    public readonly facet: FacetPackageId | undefined;

    public constructor(
        public readonly operation: string,
        facet?: FacetPackageId
    ) {
        requirePrefixPattern(operation, "Operation selector operation");
        this.facet = facet;
        Object.freeze(this);
    }

    public static own(operation = "*"): OperationPattern {
        return new OperationPattern(operation);
    }

    public static fromData(payload: FacetData): OperationPattern {
        const object = requireDataObject(payload, "Operation pattern");
        requireExactFields(object, ["operation"], ["facet"]);
        const facet = requireOptionalString(object["facet"], "Operation pattern facet");
        return new OperationPattern(
            requireString(object["operation"], "Operation pattern operation"),
            facet === undefined ? undefined : new FacetPackageId(facet)
        );
    }

    public static encode(pattern: OperationPattern): Uint8Array {
        return operationPatternCodec.encode(pattern);
    }

    public static decode(bytes: Uint8Array): OperationPattern {
        return operationPatternCodec.decode(bytes);
    }

    public toData(): FacetData {
        return this.facet === undefined
            ? { operation: this.operation }
            : { facet: this.facet.value, operation: this.operation };
    }
}

const operationPatternCodec = new DataRecordCodec(
    "facet.operation-pattern",
    (pattern: OperationPattern) => pattern.toData(),
    (payload) => OperationPattern.fromData(payload)
);

export class OperationSelector {
    public readonly patterns: readonly OperationPattern[];

    public constructor(patterns: readonly OperationPattern[]) {
        if (patterns.length === 0) {
            throw new TypeError("Operation selector must contain at least one pattern");
        }
        const ordered = [...patterns].sort((left, right) =>
            compareText(patternKey(left), patternKey(right))
        );
        ensureUnique(ordered.map(patternKey), "Operation selector patterns must be unique");
        this.patterns = Object.freeze(ordered);
        Object.freeze(this);
    }

    public static own(operation = "*"): OperationSelector {
        return new OperationSelector([OperationPattern.own(operation)]);
    }

    public static encode(selector: OperationSelector): Uint8Array {
        return operationSelectorCodec.encode(selector);
    }

    public static decode(bytes: Uint8Array): OperationSelector {
        return operationSelectorCodec.decode(bytes);
    }

    public toData(): FacetData {
        return this.patterns.map((pattern) => pattern.toData());
    }
}

const operationSelectorCodec = new DataRecordCodec(
    "facet.operation-selector",
    (selector: OperationSelector) => selector.toData(),
    (payload) =>
        new OperationSelector(
            requireArray(payload, "Operation selector").map(OperationPattern.fromData)
        )
);

function decodeMoves(payload: FacetData, subject: string): readonly FieldMove[] {
    return requireArray(payload, subject).map(FieldMove.fromData);
}

function patternKey(pattern: OperationPattern): string {
    return `${pattern.facet?.value ?? ""}\u0000${pattern.operation}`;
}

function ensureUnique(values: readonly string[], message: string): void {
    if (new Set(values).size !== values.length) {
        throw new TypeError(message);
    }
}

function requireJsonPointer(value: string, subject: string): void {
    if (value !== "" && (!value.startsWith("/") || /~(?:[^01]|$)/.test(value))) {
        throw new TypeError(`${subject} must be an RFC 6901 JSON Pointer`);
    }
}

function requirePrefixPattern(value: string, subject: string): void {
    if (value.length === 0 || value.trim() !== value || value.slice(0, -1).includes("*")) {
        throw new TypeError(`${subject} must be a literal or suffix-wildcard pattern`);
    }
}
