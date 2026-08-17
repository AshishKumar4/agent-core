import ts from "typescript-api";
import { resolveSourceSymbol } from "./evidence.mjs";
import { isJsonObject, isNonEmptyString } from "./project.mjs";

const contentRetentionFields = ["fields", "retentionOwner"];
const recordFields = [
    "codec",
    "durability",
    "kind",
    "ownerActor",
    "source",
    "store",
    "symbol",
    "tests"
];
const contentBearingRecordFields = [...recordFields, "contentRetention"].sort();

export function validateRecordOwnership(records) {
    if (!Array.isArray(records)) throw new TypeError("Record ownership registry must be an array");
    const kinds = new Set();
    const symbols = new Set();

    for (const record of records) {
        validateRecord(record, kinds, symbols);
    }
}

export function validateRecordContentRetention(records, program) {
    validateRecordOwnership(records);
    const checker = program.getTypeChecker();
    const classes = program
        .getSourceFiles()
        .filter(
            (source) => !source.isDeclarationFile && !source.fileName.includes("/node_modules/")
        )
        .flatMap((source) => source.statements.filter(ts.isClassDeclaration));

    for (const record of records) {
        const declaration = resolveSourceSymbol(program, record.source);
        if (!ts.isClassDeclaration(declaration)) {
            throw new TypeError(`Record source is not a class: ${record.source}`);
        }
        const actualFields = contentRefFields(checker, declaration, classes);
        const declared = record.contentRetention;
        if (actualFields.length === 0) {
            if (declared !== undefined) {
                throw new TypeError(`Record ${record.kind} has a stale content declaration`);
            }
            continue;
        }
        if (!isJsonObject(declared)) {
            throw new TypeError(`Record ${record.kind} is missing its content declaration`);
        }
        if (JSON.stringify(declared.fields) !== JSON.stringify(actualFields)) {
            throw new TypeError(
                `Record ${record.kind} ContentRef fields differ from its record shape`
            );
        }
        const expectedOwner =
            actualFields.length > 0 && record.durability === "durable" ? record.ownerActor : null;
        if (declared.retentionOwner !== expectedOwner) {
            throw new TypeError(
                `Record ${record.kind} content retention owner differs from its owning Actor`
            );
        }
    }
}

function validateRecord(record, kinds, symbols) {
    if (
        !isJsonObject(record) ||
        (!sameFields(record, recordFields) && !sameFields(record, contentBearingRecordFields))
    ) {
        throw new TypeError(
            `Durable record ${isJsonObject(record) ? (record.symbol ?? "<unknown>") : "<unknown>"} has missing or unknown fields`
        );
    }
    if (
        ![record.symbol, record.kind, record.source, record.codec].every(isNonEmptyString) ||
        kinds.has(record.kind) ||
        symbols.has(record.symbol)
    ) {
        throw new TypeError(
            `Durable record ownership is duplicated or malformed for ${record.kind}`
        );
    }
    if (
        !Array.isArray(record.tests) ||
        record.tests.length === 0 ||
        new Set(record.tests).size !== record.tests.length ||
        record.tests.some(
            (selector) => !isNonEmptyString(selector) || !selector.includes(`[${record.kind}]`)
        )
    ) {
        throw new TypeError(`Record ${record.kind} requires unique kind-bearing ownership tests`);
    }
    if (record.contentRetention !== undefined) {
        validateContentRetention(record.kind, record.contentRetention);
    }
    if (record.durability === "durable") {
        if (!isNonEmptyString(record.ownerActor) || !isNonEmptyString(record.store)) {
            throw new TypeError(`Durable record ${record.kind} requires one Actor and store`);
        }
    } else if (
        record.durability !== "value" ||
        record.ownerActor !== null ||
        record.store !== null
    ) {
        throw new TypeError(`Value record ${record.kind} must not claim durable ownership`);
    }
    kinds.add(record.kind);
    symbols.add(record.symbol);
}

function validateContentRetention(kind, declaration) {
    if (!isJsonObject(declaration) || !sameFields(declaration, contentRetentionFields)) {
        throw new TypeError(`Record ${kind} content retention declaration is malformed`);
    }
    const fields = declaration.fields;
    if (
        !Array.isArray(fields) ||
        fields.length === 0 ||
        fields.some((field) => !isContentFieldPath(field)) ||
        new Set(fields).size !== fields.length ||
        JSON.stringify(fields) !== JSON.stringify([...fields].sort()) ||
        (declaration.retentionOwner !== null && !isNonEmptyString(declaration.retentionOwner))
    ) {
        throw new TypeError(`Record ${kind} content retention declaration is malformed`);
    }
}

function contentRefFields(checker, declaration, classes) {
    const variants = hasModifier(declaration, ts.SyntaxKind.AbstractKeyword)
        ? [
              declaration,
              ...classes.filter(
                  (candidate) =>
                      candidate !== declaration && extendsClass(checker, candidate, declaration)
              )
          ]
        : [declaration];
    const fields = new Set();
    for (const variant of variants) {
        collectContentRefFields(
            checker,
            checker.getTypeAtLocation(variant),
            "",
            new Set(),
            fields,
            true
        );
    }
    return [...fields].sort();
}

function collectContentRefFields(checker, type, path, active, fields, topLevel) {
    if (isContentRef(type)) {
        if (path.length === 0) throw new TypeError("A record cannot itself be a ContentRef");
        fields.add(path);
        return;
    }
    if (active.has(type.id)) return;
    const next = new Set(active).add(type.id);
    if (type.isUnionOrIntersection()) {
        for (const constituent of type.types) {
            collectContentRefFields(checker, constituent, path, next, fields, topLevel);
        }
        return;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
        for (const element of checker.getTypeArguments(type)) {
            collectContentRefFields(checker, element, `${path}[]`, next, fields, false);
        }
        return;
    }

    const properties = dataProperties(checker, type);
    for (const { symbol, declaration } of properties) {
        const fieldType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
        const transparent =
            topLevel && symbol.name === "init" && fieldType.getSymbol()?.name.endsWith("Init");
        const fieldPath = transparent
            ? path
            : path.length === 0
              ? symbol.name
              : `${path}.${symbol.name}`;
        collectContentRefFields(checker, fieldType, fieldPath, next, fields, false);
    }

    const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (indexed !== undefined && containsContentRef(checker, indexed, new Set())) {
        throw new TypeError(
            `ContentRef-bearing index shape is not a declared record field: ${path}`
        );
    }
    if (!isLocallyDeclaredRecordType(type)) {
        for (const argument of checker.getTypeArguments(type)) {
            if (containsContentRef(checker, argument, new Set())) {
                throw new TypeError(
                    `ContentRef-bearing container is not a declared record field: ${path}`
                );
            }
        }
    }
}

function containsContentRef(checker, type, active) {
    if (isContentRef(type)) return true;
    if (active.has(type.id)) return false;
    const next = new Set(active).add(type.id);
    if (type.isUnionOrIntersection()) {
        return type.types.some((constituent) => containsContentRef(checker, constituent, next));
    }
    if (
        checker
            .getTypeArguments(type)
            .some((argument) => containsContentRef(checker, argument, next))
    ) {
        return true;
    }
    return dataProperties(checker, type).some(({ symbol, declaration }) =>
        containsContentRef(checker, checker.getTypeOfSymbolAtLocation(symbol, declaration), next)
    );
}

function dataProperties(checker, type) {
    return checker.getPropertiesOfType(type).flatMap((symbol) => {
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (
            declaration === undefined ||
            ts.isMethodDeclaration(declaration) ||
            ts.isMethodSignature(declaration) ||
            ("name" in declaration && ts.isPrivateIdentifier(declaration.name)) ||
            hasModifier(declaration, ts.SyntaxKind.PrivateKeyword) ||
            hasModifier(declaration, ts.SyntaxKind.ProtectedKeyword) ||
            hasModifier(declaration, ts.SyntaxKind.StaticKeyword)
        ) {
            return [];
        }
        return [{ symbol, declaration }];
    });
}

function extendsClass(checker, candidate, base) {
    const baseSymbol = checker.getTypeAtLocation(base).getSymbol();
    const pending = [checker.getTypeAtLocation(candidate)];
    const visited = new Set();
    while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined || visited.has(current.id)) continue;
        visited.add(current.id);
        for (const parent of checker.getBaseTypes(current) ?? []) {
            if (parent.getSymbol() === baseSymbol) return true;
            pending.push(parent);
        }
    }
    return false;
}

function isContentRef(type) {
    return (
        type.getSymbol()?.name === "ContentRef" &&
        (type.getSymbol()?.declarations ?? []).some(
            (declaration) =>
                declaration
                    .getSourceFile()
                    .fileName.replaceAll("\\", "/")
                    .endsWith("/src/core/content-ref.ts") && ts.isClassDeclaration(declaration)
        )
    );
}

function isLocallyDeclaredRecordType(type) {
    return (type.getSymbol()?.declarations ?? []).some((declaration) => {
        const source = declaration.getSourceFile();
        return !source.isDeclarationFile && !source.fileName.includes("/node_modules/");
    });
}

function hasModifier(node, kind) {
    return (
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    );
}

function isContentFieldPath(value) {
    return (
        isNonEmptyString(value) &&
        /^[A-Za-z_$][A-Za-z0-9_$]*(?:\[\])?(?:\.[A-Za-z_$][A-Za-z0-9_$]*(?:\[\])?)*$/u.test(value)
    );
}

function sameFields(record, fields) {
    const actual = Object.keys(record).sort();
    return (
        actual.length === fields.length && actual.every((field, index) => field === fields[index])
    );
}
