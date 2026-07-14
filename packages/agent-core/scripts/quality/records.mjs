import { basename, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
    artifactRoot,
    assertFlatFragmentNames,
    collectFiles,
    readCanonicalJson,
    reportRoot,
    writeCanonicalJson
} from "./project.mjs";
import {
    createProgram,
    executedTestSelectors,
    requirePassingTests,
    resolveSourceSymbol
} from "./evidence.mjs";

const stage = stageArgument(process.argv.slice(2));
const selectedArtifactRoot = pathArgument(process.argv.slice(2), "--artifact-root") ?? artifactRoot;
const selectedSourceRoot = pathArgument(process.argv.slice(2), "--source-root");
const sourceRoots =
    selectedSourceRoot === undefined
        ? [
              { root: resolve(process.cwd(), "src"), prefix: "" },
              {
                  root: resolve(process.cwd(), "../agent-core-cloudflare/src"),
                  prefix: "cloudflare/"
              }
          ]
        : [{ root: selectedSourceRoot, prefix: "" }];
const discoveredCodecs = new Map(
    (
        await Promise.all(
            sourceRoots.map((source) => discoverCodecRecords(source.root, source.prefix))
        )
    )
        .flat()
        .map((record) => [record.source, record.kind])
);
const discovered = new Set(discoveredCodecs.keys());
const ownership = await readCanonicalJson(resolve(selectedArtifactRoot, "quality/ownership.json"));
const index = await readCanonicalJson(resolve(selectedArtifactRoot, "records/index.json"));
const activeFragmentNames = assertFlatFragmentNames(index.fragments ?? [], "Record fragments");
const pendingFragmentNames = assertFlatFragmentNames(
    index.pendingFragments ?? [],
    "Pending record fragments"
);
if (activeFragmentNames.some((name) => pendingFragmentNames.includes(name))) {
    throw new TypeError("Record fragment is both active and pending");
}
const fragmentOwners = new Map(
    Object.entries(ownership.domainFragments).map(([owner, fragment]) => [
        `${fragment}.json`,
        owner
    ])
);
const recordsRoot = resolve(selectedArtifactRoot, "records");
const files = (await collectFiles(recordsRoot, (path) => path.endsWith(".json"))).filter(
    (path) => relative(recordsRoot, path).replaceAll("\\", "/") !== "index.json"
);
const actualFragmentNames = files
    .map((path) => relative(recordsRoot, path).replaceAll("\\", "/"))
    .sort();
if (
    JSON.stringify(actualFragmentNames) !==
    JSON.stringify([...activeFragmentNames, ...pendingFragmentNames].sort())
) {
    throw new TypeError("Record fragments differ from the exact index");
}
const kinds = new Set();
const symbols = new Set();
const records = [];
for (const path of files.filter((path) => activeFragmentNames.includes(basename(path)))) {
    const fragment = await readCanonicalJson(path);
    if (
        fragment.edition !== "1.0.0" ||
        typeof fragment.owner !== "string" ||
        !Array.isArray(fragment.records)
    ) {
        throw new TypeError("Durable record fragment is malformed");
    }
    if (fragmentOwners.get(basename(path)) !== fragment.owner) {
        throw new TypeError(`Record fragment ${basename(path)} is owned by the wrong wave`);
    }
    for (const record of fragment.records) {
        validateRecordStructure(record);
        records.push({ ...record, fragmentOwner: fragment.owner });
    }
}
for (const path of files.filter((path) => pendingFragmentNames.includes(basename(path)))) {
    const fragment = await readCanonicalJson(path);
    if (
        fragment.edition !== "1.0.0" ||
        fragmentOwners.get(basename(path)) !== fragment.owner ||
        !Array.isArray(fragment.records) ||
        fragment.records.length === 0
    ) {
        throw new TypeError(`Pending record fragment ${basename(path)} is malformed`);
    }
    for (const record of fragment.records) validateRecordStructure(record);
}
const missing = [...discovered].filter(
    (selector) => !records.some((record) => record.source === selector)
);
const extra = records
    .filter((record) => !discovered.has(record.source))
    .map((record) => record.source);
if (records.length > 0) {
    const program = createProgram();
    const executedTests = await executedTestSelectors();
    for (const record of records) {
        if (!discovered.has(record.source))
            throw new TypeError(`Record row has no discovered codec class ${record.source}`);
        if (discoveredCodecs.get(record.source) !== record.kind) {
            throw new TypeError(
                `Record ${record.source} kind ${record.kind} does not match its actual RecordCodec kind ${discoveredCodecs.get(record.source)}`
            );
        }
        if (record.durability === "durable") {
            if (typeof record.ownerActor !== "string" || typeof record.store !== "string") {
                throw new TypeError(`Durable record ${record.kind} requires one Actor and store`);
            }
        } else if (
            record.durability !== "value" ||
            record.ownerActor !== null ||
            record.store !== null
        ) {
            throw new TypeError(`Value record ${record.kind} must not claim durable ownership`);
        }
        for (const selector of [record.source, record.codec, record.store].filter(Boolean)) {
            resolveSourceSymbol(program, selector);
        }
        requirePassingTests(record.tests, executedTests, record.kind);
    }
}
await writeCanonicalJson(resolve(reportRoot, "records.json"), {
    edition: "1.0.0",
    stage,
    records,
    missing,
    extra,
    pendingFragments: pendingFragmentNames,
    complete: missing.length === 0 && extra.length === 0 && pendingFragmentNames.length === 0
});
if (
    stage === "final" &&
    (missing.length > 0 || extra.length > 0 || pendingFragmentNames.length > 0)
) {
    throw new TypeError(
        `Final record denominator mismatch; missing=${missing.join(",")} extra=${extra.join(",")} pending=${pendingFragmentNames.join(",")}`
    );
}
console.log(
    `record registry ${missing.length === 0 ? "complete" : "incomplete"}: ${records.length}/${discovered.size} classified`
);

function stageArgument(args) {
    const index = args.indexOf("--stage");
    const stage = index < 0 ? "building" : args[index + 1];
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return stage;
}

async function discoverCodecRecords(root, prefix) {
    const records = [];
    const files = await collectFiles(
        root,
        (path) => /\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path)
    );
    for (const path of files) {
        const source = await readFile(path, "utf8");
        const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        for (const statement of parsed.statements) {
            if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
            const staticCodec = statement.members.some((member) => isStaticCodec(member, parsed));
            const methods = new Set(
                statement.members
                    .filter(
                        (member) =>
                            ts.isMethodDeclaration(member) &&
                            hasModifier(member, ts.SyntaxKind.StaticKeyword)
                    )
                    .map((member) => member.name.getText(parsed))
            );
            if (staticCodec || (methods.has("encode") && methods.has("decode"))) {
                const relativePath = relative(resolve(root, ".."), path).replaceAll("\\", "/");
                const selector = `${prefix}${relativePath}#${statement.name.text}`;
                const kind = codecKind(parsed, statement);
                records.push({ source: selector, kind });
            }
        }
    }
    return records;
}

function codecKind(source, recordClass) {
    const codecMember = recordClass.members.find((member) => isStaticCodec(member, source));
    const codecExpression =
        codecMember !== undefined && ts.isPropertyDeclaration(codecMember)
            ? codecMember.initializer
            : codecMember?.body?.statements.find(ts.isReturnStatement)?.expression;
    if (codecExpression !== undefined) {
        return kindFromExpression(source, codecExpression, new Set());
    }
    const encode = recordClass.members.find(
        (member) =>
            ts.isMethodDeclaration(member) &&
            hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
            member.name.getText(source) === "encode"
    );
    const returned = encode?.body?.statements.find(ts.isReturnStatement)?.expression;
    if (
        returned !== undefined &&
        ts.isCallExpression(returned) &&
        ts.isPropertyAccessExpression(returned.expression) &&
        returned.expression.name.text === "encode"
    ) {
        return kindFromExpression(source, returned.expression.expression, new Set());
    }
    return undefined;
}

function kindFromExpression(source, expression, visited) {
    if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) {
        return kindFromExpression(source, expression.expression, visited);
    }
    if (ts.isNewExpression(expression)) {
        const directKind = expression.arguments?.[0];
        if (directKind !== undefined && ts.isStringLiteral(directKind)) {
            return directKind.text;
        }
        return kindFromCodecClass(source, expression.expression.getText(source), visited);
    }
    if (ts.isIdentifier(expression)) {
        if (visited.has(expression.text)) return undefined;
        visited.add(expression.text);
        const variable = source.statements
            .filter(ts.isVariableStatement)
            .flatMap((statement) => statement.declarationList.declarations)
            .find(
                (declaration) =>
                    ts.isIdentifier(declaration.name) && declaration.name.text === expression.text
            );
        if (variable?.initializer !== undefined) {
            return kindFromExpression(source, variable.initializer, visited);
        }
        return kindFromCodecClass(source, expression.text, visited);
    }
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === "codec") {
        const record = source.statements.find(
            (statement) =>
                ts.isClassDeclaration(statement) &&
                statement.name?.text === expression.expression.getText(source)
        );
        return record === undefined ? undefined : codecKind(source, record);
    }
    return undefined;
}

function kindFromCodecClass(source, className, visited) {
    if (visited.has(className)) return undefined;
    visited.add(className);
    const codecClass = source.statements.find(
        (statement) => ts.isClassDeclaration(statement) && statement.name?.text === className
    );
    const constructor = codecClass?.members.find(ts.isConstructorDeclaration);
    if (constructor === undefined) return undefined;
    for (const statement of constructor.body?.statements ?? []) {
        if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
            continue;
        }
        const call = statement.expression;
        if (call.expression.kind !== ts.SyntaxKind.SuperKeyword) continue;
        const kind = call.arguments[0];
        if (kind !== undefined && ts.isStringLiteral(kind)) return kind.text;
    }
    return undefined;
}

function validateRecordStructure(record) {
    const fields = [
        "symbol",
        "kind",
        "durability",
        "ownerActor",
        "source",
        "codec",
        "store",
        "tests"
    ];
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(fields.sort())) {
        throw new TypeError(
            `Durable record ${record.symbol ?? "<unknown>"} has missing or unknown fields`
        );
    }
    if (
        [record.symbol, record.kind, record.source, record.codec].some(
            (value) => typeof value !== "string" || value.length === 0
        ) ||
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
            (selector) => typeof selector !== "string" || !selector.includes(`[${record.kind}]`)
        )
    ) {
        throw new TypeError(`Record ${record.kind} requires unique kind-bearing ownership tests`);
    }
    if (record.durability === "durable") {
        if (
            typeof record.ownerActor !== "string" ||
            record.ownerActor.length === 0 ||
            typeof record.store !== "string" ||
            record.store.length === 0
        ) {
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

function hasModifier(node, kind) {
    return (
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    );
}

function isStaticCodec(member, source) {
    return (
        (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
        hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        member.name.getText(source) === "codec"
    );
}

function pathArgument(args, name) {
    const index = args.indexOf(name);
    return index < 0 ? undefined : resolve(args[index + 1]);
}
