import { SymbolFlags } from "typescript/unstable/sync";
import { assertObject, assertOneOf, compareCanonicalText } from "./project.mjs";

const declarationKinds = [
    "class",
    "enum",
    "function",
    "interface",
    "namespace",
    "type",
    "variable"
];
const vocabularyKinds = new Set(["class", "enum", "interface", "type"]);

export function exportedDeclarations(checker, module) {
    return Object.fromEntries(
        checker
            .getExportsOfModule(module)
            .map((symbol) => [symbol.name, declarationKind(checker, symbol)])
            .sort(([left], [right]) => compareCanonicalText(left, right))
    );
}

export function declarationRegistry(document) {
    if (document.edition !== "2.0.0") {
        throw new TypeError("Export registry must use edition 2.0.0");
    }
    const declarations = assertObject(document.declarations, "Export registry declarations");
    const validated = {};
    for (const [specifier, value] of Object.entries(declarations)) {
        const entries = assertObject(value, `Export registry declarations for ${specifier}`);
        const names = Object.keys(entries);
        const sorted = [...names].sort((left, right) => compareCanonicalText(left, right));
        if (JSON.stringify(names) !== JSON.stringify(sorted)) {
            throw new TypeError(`${specifier} declaration registry is not sorted by name`);
        }
        validated[specifier] = Object.fromEntries(
            names.map((name) => [
                name,
                assertOneOf(
                    entries[name],
                    declarationKinds,
                    `Export registry declaration ${specifier}#${name}`
                )
            ])
        );
    }
    return validated;
}

export function vocabularyDeclarationNames(document) {
    const declarations = declarationRegistry(document);
    return new Set(
        Object.values(declarations).flatMap((entries) =>
            Object.entries(entries)
                .filter(([, kind]) => vocabularyKinds.has(kind))
                .map(([name]) => name)
        )
    );
}

function declarationKind(checker, symbol) {
    const target = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const flags = target.flags;
    if (flags & SymbolFlags.Class) return "class";
    if (flags & SymbolFlags.Enum) return "enum";
    if (flags & SymbolFlags.Interface) return "interface";
    if (flags & SymbolFlags.TypeAlias) return "type";
    if (flags & SymbolFlags.Function) return "function";
    if (flags & SymbolFlags.Variable) return "variable";
    if (flags & SymbolFlags.NamespaceModule) return "namespace";
    throw new TypeError(`Public declaration ${symbol.name} has an unsupported declaration kind`);
}
