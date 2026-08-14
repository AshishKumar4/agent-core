import { applyPatch, validate } from "fast-json-patch";
import { isJsonObject, isMember, type JsonObject, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import type { JsonPatchEngine } from "../workspaces";

export class DetachedJsonPatchEngine implements JsonPatchEngine {
    public apply(document: JsonValue, patch: readonly JsonValue[]): JsonValue {
        let operations: JsonValue[];
        try {
            operations = [...structuredClone(patch)];
        } catch {
            throw invalidPatch();
        }
        if (!operations.every(isPatchOperation)) throw invalidPatch();
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

const PATCH_OPERATIONS = Object.freeze(["add", "remove", "replace", "move", "copy", "test"]);

type JsonPatchOperation = JsonObject &
    (
        | {
              readonly op: "add" | "replace" | "test";
              readonly path: string;
              readonly value: JsonValue;
          }
        | { readonly op: "remove"; readonly path: string }
        | { readonly op: "move" | "copy"; readonly from: string; readonly path: string }
    );

function isPatchOperation(value: JsonValue): value is JsonPatchOperation {
    if (!isJsonObject(value) || !isMember(PATCH_OPERATIONS, value["op"])) return false;
    if (typeof value["path"] !== "string") return false;
    switch (value["op"]) {
        case "move":
        case "copy":
            return typeof value["from"] === "string";
        case "add":
        case "replace":
        case "test":
            return Object.hasOwn(value, "value");
        case "remove":
            return true;
    }
    return false;
}

function invalidPatch(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Invalid RFC 6902 patch");
}
