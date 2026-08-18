import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import ts from "typescript";
import {
    artifactRoot,
    collectFiles,
    portable,
    readCanonicalJson,
    repositoryRoot,
    reportRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";

// Weakening a type is how a wrong program stops being rejected, so every escape is
// counted per file and reconciled against a reasoned permit. Product code may keep an
// escape only where the permit names it. Test code carries the narrower ban: building a
// deliberately invalid value needs an assertion, so assertions stay, but `any` describes
// nothing and a suppression proves nothing. `@ts-expect-error` is not a suppression —
// the compiler fails when the line it marks stops erroring, which makes it an assertion
// that something does not typecheck.
const WEAK_KINDS = ["any", "assertion", "non-null", "unknown", "suppression"];
const TEST_KINDS = ["any", "suppression"];
const SUPPRESSION = /@ts-(?:ignore|nocheck)\b/gu;
const SOURCE_SUPPRESSION = /@ts-(?:ignore|nocheck|expect-error)\b/gu;

const options = parseArguments(process.argv.slice(2));
const roots =
    options.root === repositoryRoot
        ? [
              resolve(repositoryRoot, "packages/agent-core/src"),
              resolve(repositoryRoot, "packages/agent-core/test"),
              resolve(repositoryRoot, "packages/agent-core-cloudflare/src"),
              resolve(repositoryRoot, "packages/agent-core-cloudflare/test")
          ]
        : [resolve(options.root, "src"), resolve(options.root, "test")];
const files = (await Promise.all(roots.map((root) => collectFiles(root, isTypeScript))))
    .flat()
    .sort();
const issues = [];
/**
 * The rules here fall into two categories, and they need different success conditions.
 *
 * Every other rule is a defect rule: ACQ-ERR, ACQ-ID, ACQ-CODEC, ACQ-IMMUTABLE and
 * ACQ-VOCAB each flag something wrong that has a fix, so their correct target is zero,
 * and the tree has driven all of them there.
 *
 * The rules below are shape rules. They flag a construction that requires review rather
 * than a defect: a composite key, a rendered comparison, a locale-dependent operation.
 * A shape can be sound -- a delimiter is safe when no component can contain it, and some
 * flagged sites are not identities at all but a SemVer rendering, a URL, a SQL fragment
 * -- so a shape rule can never reach zero by fixing code. Demanding zero from one would
 * force either pointless rewrites of persisted key formats or, far worse, someone
 * weakening the rule to make the gate green.
 *
 * So a shape-rule site is resolved by a written proof, and the final stage counts
 * outstanding issues rather than detected ones. Both conditions on `reviewed` below are
 * load-bearing: the rule must be in this set, and its baseline entry must carry a
 * non-empty reason. That is what keeps the exemption path closed to the defect rules --
 * no defect-rule entry carries a reason, so none can return through it.
 */
const reasonedRules = new Set(["ACQ-KEY", "ACQ-RENDER", "ACQ-LOCALE"]);
const localeSensitiveMembers = new Set([
    "localeCompare",
    "toLocaleDateString",
    "toLocaleLowerCase",
    "toLocaleString",
    "toLocaleTimeString",
    "toLocaleUpperCase"
]);
const identifiers = new Map();
const vocabularies = new Map();
const permits = await loadPermits(options.permits);
const observed = new Map();

for (const path of files) {
    const source = await readFile(path, "utf8");
    const file = portable(relative(options.root, path));
    const parsed = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(path)
    );
    const testFile = file.includes("/test/") || file.startsWith("test/");
    checkWeakTypes(parsed, source, file, testFile);
    if (testFile) checkTests(parsed, file);
    else {
        checkSuppressions(source, file);
        const aliases = errorAliases(parsed);
        visit(parsed, (node) => inspectNode(node, parsed, file, aliases));
    }
}

reconcilePermits();

for (const [name, locations] of identifiers) {
    if (locations.length > 1) {
        for (const location of locations)
            issue("ACQ-ID", location.file, name, `Identifier ${name} has multiple declarations`);
    }
}
for (const [values, locations] of vocabularies) {
    if (locations.length > 1 && JSON.parse(values).length > 1) {
        for (const location of locations)
            issue(
                "ACQ-VOCAB",
                location.file,
                location.symbol,
                "Closed string vocabulary is duplicated"
            );
    }
}

issues.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
const baseline = await loadBaseline(options.baseline);
const baselineFingerprints = new Set(baseline.issues.map((item) => item.fingerprint));
const currentFingerprints = new Set(issues.map((item) => item.fingerprint));
const additions = issues.filter((item) => !baselineFingerprints.has(item.fingerprint));
const resolved = baseline.issues.filter((item) => !currentFingerprints.has(item.fingerprint));
// ACQ-ERR and its siblings flag debt: each site has a fix, and the tree has driven all
// of them to zero. ACQ-KEY and ACQ-RENDER flag a shape instead, and a shape can be sound
// -- a delimiter is safe when no component can contain it, and several flagged sites are
// not identities at all but a SemVer rendering, a URL, a SQL fragment. Their terminal
// state is therefore a written proof, not an empty list, so a site whose baseline entry
// carries one is reviewed rather than outstanding. New sites still fail outright at every
// stage, and a baseline entry without a reason still fails, so nothing is silenced.
const reviewed = new Set(
    baseline.issues
        .filter((item) => reasonedRules.has(item.rule) && (item.reason ?? "").trim().length > 0)
        .map((item) => item.fingerprint)
);
const outstanding = issues.filter((item) => !reviewed.has(item.fingerprint));
const report = {
    stage: options.stage,
    files: files.map((path) => portable(relative(options.root, path))),
    issues,
    additions,
    resolved,
    outstanding,
    complete: outstanding.length === 0
};

if (options.writeBaseline) {
    if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
        throw new TypeError(
            "Writing the architecture baseline requires QUALITY_WRITE_BASELINE=1 outside CI"
        );
    }
    const reasons = new Map(
        baseline.issues
            .filter((item) => item.reason !== undefined)
            .map((i) => [i.fingerprint, i.reason])
    );
    await writeCanonicalJson(options.baseline, {
        edition: "1.0.0",
        issues: issues.map((item) => {
            const reason = reasons.get(item.fingerprint);
            return reason === undefined ? item : { ...item, reason };
        })
    });
} else {
    await writeCanonicalJson(resolve(reportRoot, "architecture.json"), report);
    if (additions.length > 0) fail("New architecture violations", additions);
    // A composite identity or a rendered comparison is permitted only with the argument
    // for why it is sound written down beside it, so the next reader inherits the proof
    // rather than the assumption.
    const unexplained = baseline.issues.filter(
        (item) =>
            reasonedRules.has(item.rule) &&
            currentFingerprints.has(item.fingerprint) &&
            (item.reason ?? "").trim().length === 0
    );
    if (unexplained.length > 0) fail("Baselined sites missing a written reason", unexplained);
    if (options.stage === "final" && outstanding.length > 0)
        fail("Final architecture violations", outstanding);
    console.log(
        `architecture ${report.complete ? "complete" : "incomplete"}: ${outstanding.length} outstanding, ${reviewed.size} reviewed, ${resolved.length} resolved`
    );
}

function inspectNode(node, source, file, aliases) {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const name = node.name.text;
        if (name.endsWith("Id")) {
            const location = { file, symbol: name };
            const values = identifiers.get(name) ?? [];
            values.push(location);
            identifiers.set(name, values);
            if (basename(file) !== "id.ts")
                issue("ACQ-ID", file, name, `${name} must be declared in id.ts`);
        }
        if (extendsError(node) && name !== "AgentCoreError") {
            issue("ACQ-ERR", file, name, `${name} must extend AgentCoreError, not Error`);
        }
        const staticCodec = node.members.some(
            (member) =>
                ts.isPropertyDeclaration(member) &&
                hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
                member.name.getText(source) === "codec"
        );
        const staticMethods = new Set(
            node.members
                .filter(
                    (member) =>
                        ts.isMethodDeclaration(member) &&
                        hasModifier(member, ts.SyntaxKind.StaticKeyword)
                )
                .map((member) => member.name.getText(source))
        );
        if (staticCodec) {
            for (const method of ["encode", "decode"]) {
                if (!staticMethods.has(method)) {
                    issue("ACQ-CODEC", file, name, `${name} is missing static ${method}`);
                }
            }
        }
        if (staticCodec || (staticMethods.has("encode") && staticMethods.has("decode"))) {
            const constructor = node.members.find(ts.isConstructorDeclaration);
            if (constructor === undefined || !freezesThis(constructor)) {
                issue("ACQ-IMMUTABLE", file, name, `${name} must freeze constructed instances`);
            }
        }
    }
    if (
        ts.isThrowStatement(node) &&
        node.expression !== undefined &&
        (ts.isNewExpression(node.expression) || ts.isCallExpression(node.expression)) &&
        resolveAlias(node.expression.expression.getText(source), aliases) === "Error"
    ) {
        issue("ACQ-ERR", file, symbolAt(node, source), "Bare Error throws are forbidden");
    }
    if (
        ts.isThrowStatement(node) &&
        node.expression !== undefined &&
        ts.isNewExpression(node.expression) &&
        resolveAlias(node.expression.expression.getText(source), aliases) === "TypeError" &&
        !isShapeValidation(node, source)
    ) {
        issue(
            "ACQ-ERR",
            file,
            symbolAt(node, source),
            "Operational failures must use AgentCoreError rather than TypeError"
        );
    }
    if (isRawIdDeclaration(node, source)) {
        issue(
            "ACQ-ID",
            file,
            node.name.getText(source),
            "Public identifier fields must not use string"
        );
    }
    const composite =
        ts.isReturnStatement(node) && node.expression !== undefined
            ? node.expression
            : ts.isVariableDeclaration(node) && node.initializer !== undefined
              ? node.initializer
              : undefined;
    // The motivating defect was a NUL join, so a delimiter-joined array is the same
    // candidate identity as a template literal. The receiver must be syntactically an
    // array -- a literal or a map/filter/sort/slice chain -- so that domain methods that
    // happen to be named `join`, such as WatermarkSet.join, are not mistaken for it.
    if (
        composite !== undefined &&
        ts.isCallExpression(composite) &&
        ts.isPropertyAccessExpression(composite.expression) &&
        composite.expression.name.text === "join" &&
        isArrayExpression(composite.expression.expression) &&
        composite.arguments.length === 1 &&
        ts.isStringLiteral(composite.arguments[0]) &&
        composite.arguments[0].text !== "" &&
        !composite.arguments[0].text.includes("\n") &&
        symbolAt(node, source).startsWith("offset:") === false
    ) {
        issue(
            "ACQ-KEY",
            file,
            symbolAt(node, source),
            "Composite identity built by string concatenation must be injective"
        );
    }
    if (
        composite !== undefined &&
        ts.isTemplateExpression(composite) &&
        composite.templateSpans.length >= 2 &&
        // A module-level constant is built from other module-level constants; no
        // caller-supplied text can reach it, and its position-based fingerprint would
        // move on any edit above it.
        symbolAt(node, source).startsWith("offset:") === false
    ) {
        issue(
            "ACQ-KEY",
            file,
            symbolAt(node, source),
            "Composite identity built by string concatenation must be injective"
        );
    }
    if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
        [node.left, node.right].some(
            (side) =>
                ts.isCallExpression(side) && side.expression.getText(source) === "JSON.stringify"
        )
    ) {
        issue(
            "ACQ-RENDER",
            file,
            symbolAt(node, source),
            "Equality by JSON.stringify depends on key insertion order"
        );
    }
    if (
        ts.isPropertyAccessExpression(node) &&
        localeSensitiveMembers.has(node.name.text) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node
    ) {
        issue(
            "ACQ-LOCALE",
            file,
            symbolAt(node, source),
            `${node.name.text} derives behaviour from the host locale and ICU build`
        );
    }
    if (ts.isTypeAliasDeclaration(node)) {
        const values = literalUnion(node.type);
        if (values.length > 1) {
            const key = JSON.stringify([...values].sort());
            const locations = vocabularies.get(key) ?? [];
            locations.push({ file, symbol: node.name.text });
            vocabularies.set(key, locations);
        }
    }
}

function checkWeakTypes(parsed, source, file, testFile) {
    const kinds = testFile ? TEST_KINDS : WEAK_KINDS;
    const count = (kind) => {
        if (!kinds.includes(kind)) return;
        const counts = observed.get(file) ?? new Map();
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        observed.set(file, counts);
    };
    visit(parsed, (node) => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) count("any");
        if (node.kind === ts.SyntaxKind.UnknownKeyword && !narrowsExplicitly(node))
            count("unknown");
        if (ts.isNonNullExpression(node)) count("non-null");
        if (ts.isTypeAssertionExpression(node)) count("assertion");
        if (ts.isAsExpression(node) && !isConstAssertion(node)) count("assertion");
    });
    const suppression = testFile ? SUPPRESSION : SOURCE_SUPPRESSION;
    suppression.lastIndex = 0;
    for (const _match of source.matchAll(suppression)) count("suppression");
}

function isConstAssertion(node) {
    return (
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === "const"
    );
}

// `unknown` is the correct type for a value whose shape is not yet proven, but only
// where the declaration proves it is about to be proven: the subject of a type
// predicate or assertion signature is narrowed by the validator that declares it.
function narrowsExplicitly(node) {
    const parameter = node.parent;
    if (parameter === undefined || !ts.isParameter(parameter)) return false;
    if (!ts.isIdentifier(parameter.name)) return false;
    const owner = parameter.parent;
    const predicate = owner?.type;
    return (
        predicate !== undefined &&
        ts.isTypePredicateNode(predicate) &&
        ts.isIdentifier(predicate.parameterName) &&
        predicate.parameterName.text === parameter.name.text
    );
}

function reconcilePermits() {
    for (const permit of permits.permits) {
        const actual = observed.get(permit.file)?.get(permit.kind) ?? 0;
        observed.get(permit.file)?.delete(permit.kind);
        if (actual === permit.count) continue;
        issue(
            "ACQ-TYPE",
            permit.file,
            permit.kind,
            actual > permit.count
                ? `${permit.file} uses ${actual} ${permit.kind} escapes where ${permit.count} are permitted`
                : `${permit.file} uses ${actual} ${permit.kind} escapes; the permit for ${permit.count} is stale`
        );
    }
    for (const [file, counts] of observed) {
        for (const [kind, actual] of counts) {
            issue("ACQ-TYPE", file, kind, `${file} uses ${actual} unpermitted ${kind} escape(s)`);
        }
    }
}

function checkSuppressions(source, file) {
    const pattern = /(?:istanbul|c8|v8|node):?\s*ignore|coverage\s+ignore/giu;
    for (const match of source.matchAll(pattern)) {
        issue(
            "ACQ-COVERAGE",
            file,
            `offset:${match.index}`,
            "Coverage suppression pragma is forbidden"
        );
    }
}

function checkTests(source, file) {
    visit(source, (node) => {
        if (!ts.isCallExpression(node)) return;
        const access = node.expression;
        const owner =
            ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)
                ? access.expression.getText(source)
                : "";
        const modifier = ts.isPropertyAccessExpression(access)
            ? access.name.text
            : ts.isElementAccessExpression(access) && ts.isStringLiteral(access.argumentExpression)
              ? access.argumentExpression.text
              : "";
        if (
            ["describe", "it", "test"].includes(owner) &&
            ["only", "skip", "todo", "skipIf", "runIf"].includes(modifier)
        ) {
            issue(
                "ACQ-TEST",
                file,
                `offset:${node.pos}`,
                "Focused, skipped, or conditional test is forbidden"
            );
        }
    });
}

function errorAliases(source) {
    const aliases = new Map([
        ["Error", "Error"],
        ["TypeError", "TypeError"],
        ["AgentCoreError", "AgentCoreError"]
    ]);
    let changed = true;
    while (changed) {
        changed = false;
        visit(source, (node) => {
            if (
                !ts.isVariableDeclaration(node) ||
                !ts.isIdentifier(node.name) ||
                node.initializer === undefined ||
                !ts.isIdentifier(node.initializer)
            )
                return;
            const target = aliases.get(node.initializer.text);
            if (target !== undefined && aliases.get(node.name.text) !== target) {
                aliases.set(node.name.text, target);
                changed = true;
            }
        });
    }
    return aliases;
}

function resolveAlias(name, aliases) {
    return aliases.get(name) ?? name;
}

function issue(rule, file, symbol, message) {
    const base = `${rule}:${file}:${symbol}:${sha256(message).slice(0, 12)}`;
    const ordinal =
        issues.filter(
            (item) => item.fingerprint === base || item.fingerprint.startsWith(`${base}:`)
        ).length + 1;
    const fingerprint = ordinal === 1 ? base : `${base}:${ordinal}`;
    issues.push({ rule, file, symbol, message, fingerprint });
}

function extendsError(node) {
    return (
        node.heritageClauses?.some(
            (clause) =>
                clause.token === ts.SyntaxKind.ExtendsKeyword &&
                clause.types.some((type) => type.expression.getText() === "Error")
        ) === true
    );
}

function hasModifier(node, kind) {
    return (
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
    );
}

function freezesThis(constructor) {
    let found = false;
    visit(constructor, (node) => {
        if (!ts.isCallExpression(node) || node.arguments.length !== 1) return;
        if (!ts.isPropertyAccessExpression(node.expression)) return;
        if (
            node.expression.expression.getText() === "Object" &&
            node.expression.name.text === "freeze" &&
            node.arguments[0].kind === ts.SyntaxKind.ThisKeyword
        )
            found = true;
    });
    return found;
}

function isArrayExpression(node) {
    if (ts.isArrayLiteralExpression(node)) return true;
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    return ["filter", "map", "slice", "sort"].includes(node.expression.name.text);
}

function isRawIdDeclaration(node, source) {
    if (!ts.isPropertyDeclaration(node) && !ts.isPropertySignature(node) && !ts.isParameter(node))
        return false;
    if (node.name === undefined || node.type === undefined) return false;
    return (
        /(?:Id|Ids)$/.test(node.name.getText(source)) &&
        node.type.kind === ts.SyntaxKind.StringKeyword
    );
}

function literalUnion(type) {
    if (!ts.isUnionTypeNode(type)) return [];
    const values = [];
    for (const member of type.types) {
        if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) return [];
        values.push(member.literal.text);
    }
    return values;
}

function symbolAt(node, source) {
    let current = node.parent;
    while (current !== undefined) {
        if (
            (ts.isFunctionDeclaration(current) ||
                ts.isMethodDeclaration(current) ||
                ts.isClassDeclaration(current)) &&
            current.name !== undefined
        )
            return current.name.getText(source);
        current = current.parent;
    }
    return `offset:${node.pos}`;
}

function isShapeValidation(node, source) {
    let current = node.parent;
    while (current !== undefined) {
        if (ts.isConstructorDeclaration(current)) return true;
        if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
            const name = current.name?.getText(source) ?? "";
            return /^(?:assert|canonical|check|copy|decode|encode|ensure|fromData|is|parse|read|require|validate|valid)/.test(
                name
            );
        }
        current = current.parent;
    }
    return false;
}

function visit(node, inspect) {
    inspect(node);
    node.forEachChild((child) => visit(child, inspect));
}

function isTypeScript(path) {
    return /\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

function scriptKind(path) {
    return path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

async function loadBaseline(path) {
    try {
        return await readCanonicalJson(path);
    } catch (error) {
        if (error?.code === "ENOENT") return { edition: "1.0.0", issues: [] };
        throw error;
    }
}

async function loadPermits(path) {
    let document;
    try {
        document = await readCanonicalJson(path);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        return { edition: "1.0.0", permits: [] };
    }
    const seen = new Set();
    for (const permit of document.permits) {
        const key = `${permit.file}:${permit.kind}`;
        if (seen.has(key)) throw new TypeError(`Duplicate weak-type permit ${key}`);
        seen.add(key);
        if (!WEAK_KINDS.includes(permit.kind)) {
            throw new TypeError(`Weak-type permit ${key} names an unknown escape kind`);
        }
        if (!Number.isSafeInteger(permit.count) || permit.count < 1) {
            throw new TypeError(`Weak-type permit ${key} must record a positive count`);
        }
        if (typeof permit.reason !== "string" || permit.reason.trim().length < 24) {
            throw new TypeError(`Weak-type permit ${key} must record why the escape stands`);
        }
    }
    return document;
}

function fail(title, values) {
    throw new TypeError(
        `${title}:\n${values.map((item) => `  ${item.fingerprint} ${item.message}`).join("\n")}`
    );
}

function parseArguments(args) {
    let stage = "building";
    let root = repositoryRoot;
    let baseline = resolve(artifactRoot, "quality/architecture-baseline.json");
    let permits = resolve(artifactRoot, "quality/weak-type-permits.json");
    let writeBaseline = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--root") root = resolve(required(args, ++index, argument));
        else if (argument === "--baseline") baseline = resolve(required(args, ++index, argument));
        else if (argument === "--permits") permits = resolve(required(args, ++index, argument));
        else if (argument === "--write-baseline") writeBaseline = true;
        else throw new TypeError(`Unknown architecture argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return { stage, root, baseline, permits, writeBaseline };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
