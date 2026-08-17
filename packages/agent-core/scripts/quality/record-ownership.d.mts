import type ts from "typescript-api";
import type { JsonValue } from "./project.mjs";

export function validateRecordOwnership(records: readonly JsonValue[]): void;
export function validateRecordContentRetention(
    records: readonly JsonValue[],
    program: ts.Program
): void;
