import { applyPatch, validate, type Operation } from "fast-json-patch";
import type { JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import type { JsonPatchEngine } from "../workspaces";

export class DetachedJsonPatchEngine implements JsonPatchEngine {
    public apply(document: JsonValue, patch: readonly JsonValue[]): JsonValue {
        // SAFETY: nothing is trusted about these operations yet. validate() below is
        // fast-json-patch's own RFC 6902 check and rejects the patch before applyPatch
        // sees it, and the detached clone is what keeps that check meaningful.
        // JsonValue[] and Operation[] do not overlap, so TypeScript requires the widen.
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
            return applyPatch(document, operations, false, false, true).newDocument;
        } catch {
            throw invalidPatch();
        }
    }
}

function invalidPatch(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Invalid RFC 6902 patch");
}
