import type { ClassDeclaration } from "typescript/unstable/ast";
import type { Project } from "typescript/unstable/sync";
import type { JsonValue } from "./project.mjs";

export function validateRecordOwnership(records: readonly JsonValue[]): void;
export function validateRecordContentRetention(
    records: readonly JsonValue[],
    project: Project
): void;
export function declaredContentRefFields(
    project: Project,
    declaration: ClassDeclaration
): readonly string[];
