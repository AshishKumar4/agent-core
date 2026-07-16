// @ts-nocheck
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../core";
import { invalidDefinition } from "./error";

export type BlueprintDeclarationField =
    "scopes" | "agents" | "slots" | "subscriptions" | "environments" | "surfaces";

export interface BlueprintDeclarationCodec {
    readonly field: BlueprintDeclarationField;
    canonicalize(value: JsonValue): JsonValue;
}

export class BlueprintDeclarationCodecPort {
    readonly #codecs: ReadonlyMap<BlueprintDeclarationField, BlueprintDeclarationCodec>;

    public constructor(codecs: readonly BlueprintDeclarationCodec[]) {
        const map = new Map<BlueprintDeclarationField, BlueprintDeclarationCodec>();
        for (const codec of codecs) {
            if (map.has(codec.field)) {
                throw new TypeError(`Duplicate Blueprint declaration codec for ${codec.field}`);
            }
            map.set(codec.field, codec);
        }
        this.#codecs = map;
        Object.freeze(this);
    }

    public canonicalize(field: BlueprintDeclarationField, value: JsonValue): JsonValue {
        const codec = this.#codecs.get(field);
        if (codec === undefined) {
            throw invalidDefinition(
                `Missing owner-published Blueprint declaration codec for ${field}`
            );
        }
        return canonicalData(codec.canonicalize(canonicalData(value)));
    }
}

function canonicalData(value: JsonValue): JsonValue {
    return decodeCanonicalJson(encodeCanonicalJson(value));
}
