import * as ts from "typescript/unstable/ast";
import { aliasTarget, hasModifier } from "./compiler.mjs";
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
const runRepository = "src/agents/runs/store.ts#RunRepository";

/**
 * SPEC §8.4 rule 6 gives Binding, Grant and ScopeEpoch one owning Actor, the Tenant. A
 * registry that names one owner per kind proves only that nobody DECLARED a second plane;
 * an implementation that added `putBinding` to the Workspace persistence or the Run
 * repository and never registered it would leave the registry unanimous and the rule
 * broken, which is the defect this walk exists to catch.
 *
 * The discriminator is structural rather than declarative: a durable surface that can
 * hold an authority record has to say so in a member signature, so the record classes
 * reaching persistence surfaces outside the authority bounded context are exactly the
 * second planes. The context is the one AGENTS.md already assigns — `src/authority` owns
 * "Grants, Bindings, resolution, epochs, watermarks" — plus the substrate adapters that
 * implement that context's stores and nothing else.
 */
export const AUTHORITY_RECORD_CLASSES = Object.freeze(["Binding", "Grant", "ScopeEpoch"]);
const AUTHORITY_CONTEXT =
    /^src\/(?:authority\/|substrates\/sqlite\/(?:authority|binding|bootstrap|tenant|watermark)\.ts$)/;
const PERSISTENCE_SURFACE = /(?:Store|Persistence|Repository)$/;

/**
 * Every derived cache in the tree, and how each one satisfies §8.4 rule 3: derived from
 * canonical state, versioned so a stale entry cannot be served, rebuildable after loss,
 * and treating a miss as ordinary rather than as an error.
 *
 * This is the inventory the rule calls complete, and `discoverDerivedCaches` is what makes
 * "complete" a fact instead of a claim: the discovered set and this list must be equal, so
 * a cache added anywhere in `src` fails the check until it is entered here with the four
 * properties named and a test that shows them.
 */
export const DERIVED_CACHE_INVENTORY = Object.freeze([
    Object.freeze({
        source: "src/composition/authority-state.ts#ActorAuthorityState.#cache",
        derivedFrom: "src/composition/authority-state.ts#ActorAuthorityHost.resolve",
        versionedBy: "the candidate's LeaseToken, revalidated against the host's live lease",
        rebuiltBy: "a miss re-resolving through the host and re-populating the entry",
        missIsOrdinary: "an absent or non-matching entry resolves again instead of failing",
        test: "test/composition/authority-state.test.ts#production authority state seams (memory) [C13-OWNERSHIP-SINGLE-OWNER] drops and rebuilds the derived authority cache from canonical Tenant state"
    }),
    Object.freeze({
        source: "src/facets/memory/facet.ts#MemoryBackend.#index",
        derivedFrom: "src/facets/memory/facet.ts#MemoryContentBackend",
        versionedBy: "replacement against the canonical entry set it was built from",
        rebuiltBy: "src/facets/memory/facet.ts#MemoryIndexBackend.replace",
        missIsOrdinary: "a search over a lost index answers empty rather than throwing",
        test: "test/integration/cache-loss.test.ts#[C13-ADV-CACHE-LOSS] [C13-OWNERSHIP-SINGLE-OWNER] rebuilds a lost derived index from canonical content"
    })
]);
const derivedCacheFields = [
    "derivedFrom",
    "missIsOrdinary",
    "rebuiltBy",
    "source",
    "test",
    "versionedBy"
];
/**
 * Every durable persistence surface declared under `packages/agent-core/src`, with the
 * authority record classes each one names and where. Separated from the rule below so a
 * test can hold the discovered set against a surface the tree does not contain — a
 * validator that can only read the tree cannot be shown to refuse anything.
 */
export function discoverPersistenceSurfaces(project) {
    const surfaces = [];
    for (const [path, source] of agentCoreSources(project)) {
        for (const statement of source.statements) {
            if (!ts.isClassDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) {
                continue;
            }
            if (statement.name === undefined || !PERSISTENCE_SURFACE.test(statement.name.text)) {
                continue;
            }
            surfaces.push({
                selector: `${path}#${statement.name.text}`,
                context: path,
                records: authorityRecordsNamedBy(statement, source)
            });
        }
    }
    return surfaces;
}

/**
 * SPEC §8.4 rule 6 and C13-OWNERSHIP-AUTHORITY-RECORDS: no Actor other than the Tenant
 * holds a canonical or mirrored Binding, Grant or ScopeEpoch. A surface outside the
 * authority context that names one in a member signature is a second durable plane
 * whether or not the registry was told about it.
 */
export function validateAuthorityPlaneExclusivity(surfaces) {
    if (!Array.isArray(surfaces)) throw new TypeError("Persistence surfaces must be an array");
    for (const surface of surfaces) {
        if (!isJsonObject(surface) || !isNonEmptyString(surface.selector)) {
            throw new TypeError("Persistence surface is malformed");
        }
        if (AUTHORITY_CONTEXT.test(String(surface.context)) || surface.records.length === 0) {
            continue;
        }
        const named = [...new Set(surface.records.map((entry) => entry.record))].sort();
        throw new TypeError(
            `Durable surface outside the Tenant authority plane holds ${named.join(", ")}: ${surface.selector}`
        );
    }
}

/**
 * Every cache in the tree: a class-private property whose name or declared type marks it
 * as a cache or a derived index. Private is the discriminating half — an ordinal named
 * `itemIndex` and a record's `cacheLineage` field are public data on a durable record,
 * while owned rebuildable state is exactly the state a class keeps to itself.
 */
export function discoverDerivedCaches(project) {
    const caches = [];
    for (const [path, source] of agentCoreSources(project)) {
        for (const statement of source.statements) {
            if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
            for (const member of statement.members) {
                if (!ts.isPropertyDeclaration(member)) continue;
                const name = member.name?.getText(source) ?? "";
                const owned =
                    name.startsWith("#") || hasModifier(member, ts.SyntaxKind.PrivateKeyword);
                if (!owned) continue;
                const shape = `${name} ${member.type?.getText(source) ?? ""} ${
                    member.initializer?.getText(source) ?? ""
                }`;
                if (!/cache|index/i.test(shape)) continue;
                caches.push({ source: `${path}#${statement.name.text}.${name}` });
            }
        }
    }
    return caches;
}

/**
 * SPEC §8.4 rule 3: every cache is derived, versioned, rebuildable, and treats a miss as
 * ordinary. One cache-loss case proves that of one cache; this proves the inventory is
 * the whole set, which is the half a single case cannot reach.
 */
export function validateDerivedCacheInventory(caches, inventory = DERIVED_CACHE_INVENTORY) {
    for (const entry of inventory) {
        if (!isJsonObject(entry) || !sameFields(entry, derivedCacheFields)) {
            throw new TypeError("Derived cache inventory entry is malformed");
        }
        for (const field of derivedCacheFields) {
            if (!isNonEmptyString(entry[field])) {
                throw new TypeError(`Derived cache ${entry.source} is missing ${field}`);
            }
        }
    }
    const declared = [...new Set(inventory.map((entry) => entry.source))].sort();
    if (declared.length !== inventory.length) {
        throw new TypeError("Derived cache inventory declares one cache twice");
    }
    const discovered = [...new Set(caches.map((cache) => cache.source))].sort();
    const undeclared = discovered.filter((source) => !declared.includes(source));
    if (undeclared.length > 0) {
        throw new TypeError(`Derived cache is not in the inventory: ${undeclared.join(", ")}`);
    }
    const stale = declared.filter((source) => !discovered.includes(source));
    if (stale.length > 0) {
        throw new TypeError(`Derived cache inventory names no such cache: ${stale.join(", ")}`);
    }
}

/**
 * The §4.7 capability namespaces: the name-keyed sets an isolate reaches its whole world
 * through. A namespace assembled as a plain object answers its prototype's names as well
 * as its own, so an isolate given one could address `constructor` or `toString` without
 * anything being passed — and no `instanceof` check on the entries takes that back,
 * because the leak is in the container rather than in what it holds.
 *
 * Keying by a Map is what closes it, and until this checker existed that was a convention
 * a host could drop without any gate noticing.
 */
const NAMESPACE_STRUCTURES = Object.freeze([
    Object.freeze({
        source: "src/operations/authored-code.ts#AuthoredCodeCapabilitySet",
        member: "#capabilities"
    }),
    Object.freeze({
        source: "src/operations/authored-code.ts#AuthoredCodeBackingSet",
        member: "#backings"
    })
]);
const MAP_KEYED = /^(?:Readonly)?Map</;

export { NAMESPACE_STRUCTURES };

/** How each declared §4.7 namespace stores its entries, read off the declaration. */
export function discoverNamespaceStructures(project) {
    const wanted = new Map(NAMESPACE_STRUCTURES.map((entry) => [entry.source, entry.member]));
    const structures = [];
    for (const [path, source] of agentCoreSources(project)) {
        for (const statement of source.statements) {
            if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
            const selector = `${path}#${statement.name.text}`;
            const member = wanted.get(selector);
            if (member === undefined) continue;
            const declared = statement.members.find(
                (candidate) =>
                    ts.isPropertyDeclaration(candidate) &&
                    candidate.name?.getText(source) === member
            );
            if (declared === undefined) {
                throw new TypeError(`§4.7 namespace member is missing: ${selector}`);
            }
            structures.push({
                source: selector,
                member,
                keying: (declared.type?.getText(source) ?? "").trim()
            });
        }
    }
    const found = structures.map((entry) => entry.source);
    for (const entry of NAMESPACE_STRUCTURES) {
        if (!found.includes(entry.source)) {
            throw new TypeError(`§4.7 namespace is missing: ${entry.source}`);
        }
    }
    return structures;
}

/** SPEC §4.7: an isolate's namespace answers exactly the names it was passed. */
export function validateClosedNamespaceStructure(structures) {
    if (!Array.isArray(structures)) throw new TypeError("Namespace structures must be an array");
    for (const structure of structures) {
        if (!isJsonObject(structure) || !isNonEmptyString(structure.source)) {
            throw new TypeError("Namespace structure is malformed");
        }
        if (!MAP_KEYED.test(String(structure.keying))) {
            throw new TypeError(`§4.7 namespace is not keyed by a Map: ${structure.source}`);
        }
    }
}

/** Package-relative `src` paths and their parsed sources, from the one shared program. */
function agentCoreSources(project) {
    const sources = [];
    for (const name of project.program.getSourceFileNames()) {
        const match = /packages\/agent-core\/(src\/.+)$/.exec(name.replaceAll("\\", "/"));
        if (match === null || name.includes("/node_modules/")) continue;
        const source = project.program.getSourceFile(name);
        if (source === undefined || source.isDeclarationFile) continue;
        sources.push([match[1], source]);
    }
    return sources;
}

function authorityRecordsNamedBy(declaration, source) {
    const named = [];
    for (const member of declaration.members) {
        const text = member.getText(source);
        for (const record of AUTHORITY_RECORD_CLASSES) {
            if (new RegExp(`\\b${record}\\b`).test(text)) {
                named.push({ record, member: member.name?.getText(source) ?? "<anonymous>" });
            }
        }
    }
    return named;
}

export function validateRecordOwnership(records) {
    if (!Array.isArray(records)) throw new TypeError("Record ownership registry must be an array");
    const kinds = new Set();
    const symbols = new Set();

    for (const record of records) {
        validateRecord(record, kinds, symbols);
    }
}

export function validateRecordContentRetention(records, project) {
    validateRecordOwnership(records);
    const checker = project.checker;
    const runDescriptors = runDescriptorFactories(project, checker);
    // Names first, files second: a program spanning both packages also carries every
    // library declaration it resolved, and materialising those across the API boundary
    // to discard them is the one avoidable cost in this walk.
    const classes = recordClasses(project);

    for (const record of records) {
        const declaration = resolveSourceSymbol(project, record.source);
        if (!ts.isClassDeclaration(declaration)) {
            throw new TypeError(`Record source is not a class: ${record.source}`);
        }
        const actualFields = contentRefFields(checker, declaration, classes);
        if (record.store === runRepository) {
            validateRunContentProjection(record, declaration, actualFields, runDescriptors);
        }
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

export function declaredContentRefFields(project, declaration) {
    return contentRefFields(project.checker, declaration, recordClasses(project));
}

function recordClasses(project) {
    return project.program
        .getSourceFileNames()
        .filter((name) => !name.includes("/node_modules/"))
        .map((name) => project.program.getSourceFile(name))
        .filter((source) => source !== undefined && !source.isDeclarationFile)
        .flatMap((source) => source.statements.filter(ts.isClassDeclaration));
}

function validateRunContentProjection(record, declaration, actualFields, descriptors) {
    const descriptor = descriptors.get(declaration.name?.text);
    const expectedFactory =
        actualFields.length === 0 ? "recordDescriptor" : "contentRecordDescriptor";
    if (descriptor?.factory !== expectedFactory) {
        throw new TypeError(
            `Record ${record.kind} runtime content descriptor differs from its record shape`
        );
    }
    if (actualFields.length === 0) return;
    const projected = contentProjectionFields(descriptor.projection, declaration);
    if (JSON.stringify(projected) !== JSON.stringify(actualFields)) {
        throw new TypeError(
            `Record ${record.kind} content projection differs from its record shape`
        );
    }
}

function runDescriptorFactories(project, checker) {
    const declaration = resolveSourceSymbol(
        project,
        "src/agents/runs/store.ts#RUN_RECORD_DESCRIPTORS"
    );
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) {
        throw new TypeError("Run record descriptors are not a variable initializer");
    }
    const expression = unwrapExpression(declaration.initializer);
    if (!ts.isObjectLiteralExpression(expression)) {
        throw new TypeError("Run record descriptors are not an object literal");
    }
    const descriptors = new Map();
    for (const property of expression.properties) {
        if (!ts.isPropertyAssignment(property)) {
            throw new TypeError("Run record descriptors must use property assignments");
        }
        const call = unwrapExpression(property.initializer);
        if (
            !ts.isCallExpression(call) ||
            !ts.isIdentifier(call.expression) ||
            (call.expression.text !== "recordDescriptor" &&
                call.expression.text !== "contentRecordDescriptor") ||
            call.arguments.length < 1 ||
            !ts.isIdentifier(call.arguments[0])
        ) {
            throw new TypeError("Run record descriptor is malformed");
        }
        const codecType = checker.getTypeAtLocation(call.arguments[0]);
        const recordType = typeArguments(checker, codecType)[0];
        const record = recordType?.getSymbol()?.name;
        if (record === undefined) throw new TypeError("Run record descriptor codec is untyped");
        if (descriptors.has(record))
            throw new TypeError(`Duplicate Run record descriptor ${record}`);
        descriptors.set(record, {
            factory: call.expression.text,
            projection:
                call.expression.text === "contentRecordDescriptor"
                    ? contentProjectionDeclaration(checker, call.arguments[2])
                    : undefined
        });
    }
    return descriptors;
}

function unwrapExpression(expression) {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current)
    ) {
        current = current.expression;
    }
    if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.expression.getText(current.getSourceFile()) === "Object" &&
        current.expression.name.text === "freeze" &&
        current.arguments.length === 1
    ) {
        return unwrapExpression(current.arguments[0]);
    }
    return current;
}

function contentProjectionDeclaration(checker, expression) {
    if (expression === undefined || !ts.isIdentifier(expression)) {
        throw new TypeError("Run content descriptor projection is malformed");
    }
    const imported = checker.getSymbolAtLocation(expression);
    const symbol = imported === undefined ? undefined : aliasTarget(checker, imported);
    const declaration = (symbol?.valueDeclaration ?? symbol?.declarations?.[0])?.resolve();
    if (declaration === undefined || !ts.isFunctionDeclaration(declaration)) {
        throw new TypeError("Run content descriptor projection is not a function declaration");
    }
    return declaration;
}

function contentProjectionFields(projection, record) {
    const parameter = projection?.parameters[0];
    const statement = projection?.body?.statements[0];
    if (
        projection?.body?.statements.length !== 1 ||
        projection.parameters.length !== 1 ||
        parameter === undefined ||
        !ts.isIdentifier(parameter.name) ||
        statement === undefined ||
        !ts.isReturnStatement(statement) ||
        statement.expression === undefined ||
        !ts.isCallExpression(statement.expression) ||
        !ts.isIdentifier(statement.expression.expression) ||
        statement.expression.expression.text !== "contentRetentionFields" ||
        statement.expression.arguments.length !== 1 ||
        !ts.isArrayLiteralExpression(statement.expression.arguments[0])
    ) {
        throw new TypeError(
            `Run record ${record.name?.text ?? "<unknown>"} content projection is indirect`
        );
    }
    return statement.expression.arguments[0].elements
        .map((element) => contentProjectionField(record, parameter.name.text, element))
        .sort();
}

function contentProjectionField(record, parameter, element) {
    if (
        !ts.isArrayLiteralExpression(element) ||
        element.elements.length !== 2 ||
        !ts.isStringLiteral(element.elements[0])
    ) {
        throw new TypeError(
            `Run record ${record.name?.text ?? "<unknown>"} content projection is malformed`
        );
    }
    const field = element.elements[0].text;
    if (propertyPath(element.elements[1], parameter) !== field) {
        throw new TypeError(
            `Run record ${record.name?.text ?? "<unknown>"} content projection names the wrong field`
        );
    }
    return field;
}

function propertyPath(expression, root) {
    const parts = [];
    let current = expression;
    while (ts.isPropertyAccessExpression(current)) {
        parts.unshift(current.name.text);
        current = current.expression;
    }
    return ts.isIdentifier(current) && current.text === root ? parts.join(".") : undefined;
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
    if (type.isUnionType() || type.isIntersectionType()) {
        for (const constituent of type.getTypes()) {
            collectContentRefFields(checker, constituent, path, next, fields, topLevel);
        }
        return;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
        for (const element of typeArguments(checker, type)) {
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

    for (const indexed of stringIndexTypes(checker, type)) {
        if (containsContentRef(checker, indexed, new Set())) {
            throw new TypeError(
                `ContentRef-bearing index shape is not a declared record field: ${path}`
            );
        }
    }
    if (!isLocallyDeclaredRecordType(type)) {
        for (const argument of typeArguments(checker, type)) {
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
    if (type.isUnionType() || type.isIntersectionType()) {
        return type
            .getTypes()
            .some((constituent) => containsContentRef(checker, constituent, next));
    }
    if (
        typeArguments(checker, type).some((argument) => containsContentRef(checker, argument, next))
    ) {
        return true;
    }
    return dataProperties(checker, type).some(({ symbol, declaration }) =>
        containsContentRef(checker, checker.getTypeOfSymbolAtLocation(symbol, declaration), next)
    );
}

/**
 * The type arguments of a generic reference, and nothing for anything else. The walk
 * asks this of every type it reaches, and the TypeScript 7 checker dereferences a nil
 * target when asked of a type that is not a reference, which crashes the compiler server
 * rather than returning empty.
 */
function typeArguments(checker, type) {
    return type.isTypeReference() ? checker.getTypeArguments(type) : [];
}

/**
 * The value types of every index signature a string key selects. TypeScript 7 reports
 * index signatures as key/value pairs rather than by index kind, so applicability is the
 * assignability question the kind used to stand for.
 */
function stringIndexTypes(checker, type) {
    return checker
        .getIndexInfosOfType(type)
        .filter((info) => checker.isTypeAssignableTo(checker.getStringType(), info.keyType))
        .map((info) => info.valueType);
}

function dataProperties(checker, type) {
    return checker.getPropertiesOfType(type).flatMap((symbol) => {
        const declaration = (symbol.valueDeclaration ?? symbol.declarations[0])?.resolve();
        if (
            declaration !== undefined &&
            "name" in declaration &&
            ts.isPrivateIdentifier(declaration.name)
        ) {
            const field = checker.getTypeOfSymbolAtLocation(symbol, declaration);
            if (containsContentRef(checker, field, new Set())) {
                throw new TypeError("ECMAScript-private ContentRef fields cannot be projected");
            }
            return [];
        }
        if (
            declaration === undefined ||
            ts.isMethodDeclaration(declaration) ||
            ts.isMethodSignatureDeclaration(declaration) ||
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
        for (const parent of current.getBaseTypes() ?? []) {
            if (baseSymbol !== undefined && parent.getSymbol()?.id === baseSymbol.id) return true;
            pending.push(parent);
        }
    }
    return false;
}

// A symbol's declarations arrive as handles carrying their kind and their file, which is
// all either question needs; resolving them to nodes would answer the same thing after a
// round trip per declaration.
function isContentRef(type) {
    const symbol = type.getSymbol();
    return (
        symbol?.name === "ContentRef" &&
        symbol.declarations.some(
            (declaration) =>
                declaration.path.replaceAll("\\", "/").endsWith("/src/core/content-ref.ts") &&
                declaration.kind === ts.SyntaxKind.ClassDeclaration
        )
    );
}

function isLocallyDeclaredRecordType(type) {
    return (type.getSymbol()?.declarations ?? []).some((declaration) => {
        const path = declaration.path.replaceAll("\\", "/");
        return !/\.d\.[cm]?ts$/u.test(path) && !path.includes("/node_modules/");
    });
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
