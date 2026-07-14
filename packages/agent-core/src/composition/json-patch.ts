import { applyPatch, validate, type Operation } from "fast-json-patch";
import type { JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import type { JsonPatchEngine } from "../workspaces";

export class DetachedJsonPatchEngine implements JsonPatchEngine {
    public apply(document: JsonValue, patch: readonly JsonValue[]): JsonValue {
        const operations = structuredClone(patch) as unknown as Operation[];
        let validationError;
        try {
            validationError = validate(operations, document);
        } catch {
            throw invalidPatch();
        }
        if (validationError !== undefined) {
            throw invalidPatch();
        }
        try {
            return applyPatch(document, operations, false, false, true).newDocument as JsonValue;
        } catch {
            throw invalidPatch();
        }
    }
}

function invalidPatch(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Invalid RFC 6902 patch");
}
