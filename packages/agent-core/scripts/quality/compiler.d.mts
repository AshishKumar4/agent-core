import type { Node, SourceFile, SyntaxKind } from "typescript/unstable/ast";
import type { ConfigResponse } from "typescript/unstable/proto";
import type {
    Checker,
    CompilerOptions,
    Diagnostic,
    Project,
    Symbol as TypeSymbol
} from "typescript/unstable/sync";

export function sourceFiles(paths: readonly string[]): Map<string, SourceFile>;
export function sourceFile(path: string): SourceFile | undefined;
export function parseSource(name: string, text: string): SourceFile;
export function syntaxErrors(path: string): readonly Diagnostic[];
export function forget(paths: readonly string[]): void;
export function openProject(options: {
    files: readonly string[];
    extend?: string;
    compilerOptions?: CompilerOptions;
}): Project;
export function configuredProject(path: string): Project;
export function configuration(path: string): ConfigResponse;
export function hasModifier(node: Node, kind: SyntaxKind): boolean;
export function aliasTarget(checker: Checker, symbol: TypeSymbol): TypeSymbol;
