export type FacetData =
    | null
    | boolean
    | number
    | string
    | readonly FacetData[]
    | FacetDataMap;

export interface FacetDataMap {
    readonly [name: string]: FacetData;
}

export abstract class FacetDataSchema<Data extends FacetData = FacetData> {
    protected constructor(public readonly name: string) {
        if (name.length === 0) {
            throw new TypeError("Facet data schema name must not be empty");
        }
    }

    public abstract accepts(value: unknown): value is Data;
}

class AnyFacetDataSchema extends FacetDataSchema {
    public constructor() {
        super("any");
    }

    public accepts(value: unknown): value is FacetData {
        return isFacetData(value);
    }
}

class ObjectFacetDataSchema extends FacetDataSchema<FacetDataMap> {
    public constructor() {
        super("object");
    }

    public accepts(value: unknown): value is FacetDataMap {
        return isFacetDataMap(value);
    }
}

export class FacetDataSchemas {
    public static any(): FacetDataSchema {
        return anyFacetDataSchema;
    }

    public static object(): FacetDataSchema<FacetDataMap> {
        return objectFacetDataSchema;
    }
}

const anyFacetDataSchema = new AnyFacetDataSchema();
const objectFacetDataSchema = new ObjectFacetDataSchema();

export function isFacetData(value: unknown): value is FacetData {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return typeof value !== "number" || Number.isFinite(value);
    }

    if (Array.isArray(value)) {
        return value.every(isFacetData);
    }

    return isFacetDataMap(value);
}

export function isFacetDataMap(value: unknown): value is FacetDataMap {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    return Object.values(value).every(isFacetData);
}
