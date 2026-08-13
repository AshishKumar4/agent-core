import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    assertArray,
    assertObject,
    assertString,
    parseCanonicalJson,
    type JsonObject,
    type JsonValue
} from "../../scripts/quality/project.mjs";

export const packageRoot = resolve(import.meta.dirname, "../..");

/**
 * The gate tests assert against the repository's own artifacts. Read through the
 * strict parser the gates themselves use, and through accessors that name the
 * field they want, a test whose artifact has changed shape fails where the shape
 * changed — rather than quietly asserting against undefined, which is how an
 * evidence test stops testing anything without anyone noticing.
 */
export async function readArtifact(path: string): Promise<JsonObject> {
    return assertObject(
        parseCanonicalJson(await readFile(resolve(packageRoot, path), "utf8"), path),
        path
    );
}

export function readArtifactSync(path: string): JsonObject {
    return assertObject(
        parseCanonicalJson(readFileSync(resolve(packageRoot, path), "utf8"), path),
        path
    );
}

export function objectAt(owner: JsonObject, field: string): JsonObject {
    return assertObject(owner[field], field);
}

export function arrayAt(owner: JsonObject, field: string): readonly JsonValue[] {
    return assertArray(owner[field], field);
}

export function objectsAt(owner: JsonObject, field: string): readonly JsonObject[] {
    return arrayAt(owner, field).map((entry, index) => assertObject(entry, `${field}[${index}]`));
}

export function stringAt(owner: JsonObject, field: string): string {
    return assertString(owner[field], field);
}

export function stringsAt(owner: JsonObject, field: string): readonly string[] {
    return arrayAt(owner, field).map((entry, index) => assertString(entry, `${field}[${index}]`));
}
