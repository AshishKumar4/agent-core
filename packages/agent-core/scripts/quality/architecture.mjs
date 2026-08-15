import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import ts from "typescript";
import {
    artifactRoot,
    assertArray,
    assertExactKeys,
    assertObject,
    assertString,
    collectFiles,
    isNonEmptyString,
    packageRoot,
    portable,
    readCanonicalJson,
    repositoryRoot,
    reportRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";
import { vocabularyDeclarationNames } from "./export-registry.mjs";
import { canonicalSpec } from "./spec.mjs";

// Weakening a type is how a wrong program stops being rejected, so every escape is
// bound to an exact symbol and source anchor under a reasoned permit. Product code may
// keep an escape only where the permit names it. Test code carries the narrower ban:
// building a deliberately invalid value needs an assertion, so assertions stay, but
// `any` describes nothing and a suppression proves nothing. `@ts-expect-error` is not
// a suppression — the compiler fails when the line it marks stops erroring, which makes
// it an assertion that something does not typecheck.
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
await checkSpecVocabulary(options.spec, options.exports, options.vocabulary);

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
const report = {
    stage: options.stage,
    files: files.map((path) => portable(relative(options.root, path))),
    issues,
    additions,
    resolved,
    complete: issues.length === 0
};

if (options.writeBaseline) {
    if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
        throw new TypeError(
            "Writing the architecture baseline requires QUALITY_WRITE_BASELINE=1 outside CI"
        );
    }
    await writeCanonicalJson(options.baseline, { edition: "1.0.0", issues });
} else {
    await writeCanonicalJson(resolve(reportRoot, "architecture.json"), report);
    if (additions.length > 0) fail("New architecture violations", additions);
    if (options.stage === "final" && issues.length > 0)
        fail("Final architecture violations", issues);
    console.log(
        `architecture ${report.complete ? "complete" : "incomplete"}: ${issues.length} issue(s), ${resolved.length} resolved`
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
        !isDecodingBoundary(node, source)
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
    const record = (kind, node) => {
        if (!kinds.includes(kind)) return;
        recordWeakEscape(file, kind, {
            symbol: weakSymbolAt(node, parsed),
            source: weakAnchorSource(node, parsed)
        });
    };
    visit(parsed, (node) => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) record("any", node);
        if (node.kind === ts.SyntaxKind.UnknownKeyword && !narrowsExplicitly(node))
            record("unknown", node);
        if (ts.isNonNullExpression(node)) record("non-null", node);
        if (ts.isTypeAssertionExpression(node)) record("assertion", node);
        if (ts.isAsExpression(node) && !isConstAssertion(node)) record("assertion", node);
    });
    const suppression = testFile ? SUPPRESSION : SOURCE_SUPPRESSION;
    suppression.lastIndex = 0;
    for (const match of source.matchAll(suppression)) {
        const offset = match.index ?? 0;
        const start = source.lastIndexOf("\n", offset - 1) + 1;
        const end = source.indexOf("\n", offset);
        recordWeakEscape(file, "suppression", {
            symbol: weakSymbolAtOffset(parsed, offset),
            source: source.slice(start, end === -1 ? source.length : end).trim()
        });
    }
}

function weakSymbolAtOffset(source, offset) {
    let owner = source;
    visit(source, (node) => {
        if (
            node.getFullStart() <= offset &&
            offset <= node.end &&
            node.end - node.pos < owner.end - owner.pos
        ) {
            owner = node;
        }
    });
    return weakSymbolAt(owner, source);
}

function weakSymbolAt(node, source) {
    const names = [];
    let current = node.parent;
    while (current !== undefined) {
        const name = weakDeclarationName(current, source);
        if (name !== undefined) names.unshift(name);
        current = current.parent;
    }
    return names.join(".") || "<module>";
}

function weakDeclarationName(node, source) {
    if (ts.isConstructorDeclaration(node)) return "constructor";
    if (
        (ts.isFunctionDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isPropertyDeclaration(node) ||
            ts.isPropertySignature(node) ||
            ts.isParameter(node) ||
            ts.isVariableDeclaration(node)) &&
        node.name !== undefined
    ) {
        return node.name.getText(source);
    }
    return undefined;
}

function weakAnchorSource(node, source) {
    if (node.kind !== ts.SyntaxKind.AnyKeyword && node.kind !== ts.SyntaxKind.UnknownKeyword) {
        return node.getText(source);
    }
    let current = node;
    while (current.parent !== undefined && ts.isTypeNode(current.parent)) {
        current = current.parent;
    }
    const owner = current.parent;
    if (
        owner !== undefined &&
        (ts.isParameter(owner) ||
            ts.isPropertyDeclaration(owner) ||
            ts.isPropertySignature(owner) ||
            ts.isVariableDeclaration(owner) ||
            ts.isTypeAliasDeclaration(owner))
    ) {
        return owner.getText(source);
    }
    return current.getText(source);
}

function recordWeakEscape(file, kind, anchor) {
    const byKind = observed.get(file) ?? new Map();
    const anchors = byKind.get(kind) ?? new Map();
    const key = JSON.stringify([anchor.symbol, anchor.source]);
    const existing = anchors.get(key);
    anchors.set(key, { ...anchor, count: (existing?.count ?? 0) + 1 });
    byKind.set(kind, anchors);
    observed.set(file, byKind);
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
        const actual = observed.get(permit.file)?.get(permit.kind) ?? new Map();
        for (const anchor of permit.anchors) {
            const key = JSON.stringify([anchor.symbol, anchor.source]);
            const occurrence = actual.get(key);
            actual.delete(key);
            if (occurrence?.count === anchor.count) continue;
            issue(
                "ACQ-TYPE",
                permit.file,
                anchor.symbol,
                `${permit.file} ${permit.kind} permit for ${anchor.symbol} is stale`
            );
        }
        for (const occurrence of actual.values()) {
            issue(
                "ACQ-TYPE",
                permit.file,
                occurrence.symbol,
                `${permit.file} uses an unpermitted ${permit.kind} escape in ${occurrence.symbol}`
            );
        }
        observed.get(permit.file)?.delete(permit.kind);
    }
    for (const [file, byKind] of observed) {
        for (const [kind, anchors] of byKind) {
            for (const occurrence of anchors.values()) {
                issue(
                    "ACQ-TYPE",
                    file,
                    occurrence.symbol,
                    `${file} uses an unpermitted ${kind} escape in ${occurrence.symbol}`
                );
            }
        }
    }
}

// A public export is how the implementation speaks to a SPEC reader, so every word in an
// exported type's name must be a word the SPEC uses. Two failure classes are deliberately
// different kinds of rule. A foreign term is a defect: Appendix A translates the
// industry's word into this spec's own ("tool" is an Operation), so a name carrying one
// always has a correct name available, the finding is never reviewable, and the count
// must stay zero. A word the SPEC simply does not contain is a shape needing review:
// implementation machinery legitimately earns nouns beneath the SPEC's altitude (Init,
// Options, preflight), so such a word stands only while spec-vocabulary.json records a
// written reason for it, and a reviewed word that falls out of use or gets adopted by
// the SPEC is flagged as stale rather than silently retained. The declaration registry
// identifies type nouns directly; identifier capitalization never stands in for kind.
async function checkSpecVocabulary(specFile, exportsFile, vocabularyFile) {
    const registryPath = portable(relative(options.root, exportsFile));
    const vocabularyPath = portable(relative(options.root, vocabularyFile));
    const { visibleBlocks } = await canonicalSpec(specFile);
    const registry = await readCanonicalJson(exportsFile);
    const vocabulary = await readCanonicalJson(vocabularyFile);
    const { foreign, reviewed } = validateSpecVocabulary(vocabulary);
    const specWords = new Set();
    for (const block of visibleBlocks) {
        for (const word of block.rendered.match(/[A-Za-z][A-Za-z0-9]*/gu) ?? []) {
            specWords.add(word.toLowerCase());
            for (const token of nameTokens(word)) specWords.add(token.toLowerCase());
        }
    }
    const containsWord = (token) =>
        singularForms(token).some(
            (candidate) =>
                specWords.has(candidate) ||
                specWords.has(`${candidate}s`) ||
                specWords.has(`${candidate}es`) ||
                (candidate.endsWith("y") && specWords.has(`${candidate.slice(0, -1)}ies`))
        );
    const symbols = vocabularyDeclarationNames(registry);
    const usedReviews = new Set();
    for (const symbol of [...symbols].sort()) {
        const flagged = new Set();
        for (const token of nameTokens(symbol)) {
            const word = token.toLowerCase();
            if (flagged.has(word)) continue;
            flagged.add(word);
            const foreignWord = singularForms(word).find((candidate) => foreign.has(candidate));
            const translation = foreignWord === undefined ? undefined : foreign.get(foreignWord);
            if (translation !== undefined) {
                issue(
                    "ACQ-SPEC-VOCAB",
                    registryPath,
                    symbol,
                    `${symbol} uses the foreign term "${foreignWord}"; the SPEC's word is ${translation} (SPEC.md Appendix A)`
                );
                continue;
            }
            if (containsWord(word)) continue;
            const reviewedWord = singularForms(word).find((candidate) => reviewed.has(candidate));
            if (reviewedWord !== undefined) {
                usedReviews.add(reviewedWord);
                continue;
            }
            issue(
                "ACQ-SPEC-VOCAB",
                registryPath,
                symbol,
                `${symbol} introduces vocabulary the SPEC does not contain: "${word}"`
            );
        }
    }
    for (const word of reviewed.keys()) {
        if (containsWord(word)) {
            issue(
                "ACQ-SPEC-VOCAB",
                vocabularyPath,
                word,
                `Reviewed vocabulary "${word}" now appears in the SPEC; the entry is redundant`
            );
        } else if (!usedReviews.has(word)) {
            issue(
                "ACQ-SPEC-VOCAB",
                vocabularyPath,
                word,
                `Reviewed vocabulary "${word}" is no longer used by any public export`
            );
        }
    }
}

function singularForms(word) {
    const forms = [word];
    if (word.endsWith("ies") && word.length > 3) forms.push(`${word.slice(0, -3)}y`);
    if (/(?:ches|shes|ses|xes|zes)$/u.test(word)) forms.push(word.slice(0, -2));
    if (word.endsWith("s") && !/(?:ss|us|is)$/u.test(word)) forms.push(word.slice(0, -1));
    return [...new Set(forms)];
}

function validateSpecVocabulary(document) {
    if (
        document.edition !== "1.0.0" ||
        !Array.isArray(document.foreign) ||
        !Array.isArray(document.reviewed)
    ) {
        throw new TypeError("Spec vocabulary artifact is malformed");
    }
    const foreign = new Map();
    for (const entry of document.foreign) {
        if (!isNonEmptyString(entry.word) || !/^[a-z][a-z0-9]*$/u.test(entry.word)) {
            throw new TypeError("Foreign vocabulary entries must record a lowercase word");
        }
        if (!isNonEmptyString(entry.specTerm)) {
            throw new TypeError(`Foreign vocabulary "${entry.word}" must name the SPEC's term`);
        }
        if (foreign.has(entry.word)) {
            throw new TypeError(`Foreign vocabulary records "${entry.word}" twice`);
        }
        foreign.set(entry.word, entry.specTerm);
    }
    const reviewed = new Map();
    for (const entry of document.reviewed) {
        if (!isNonEmptyString(entry.word) || !/^[a-z][a-z0-9]*$/u.test(entry.word)) {
            throw new TypeError("Reviewed vocabulary entries must record a lowercase word");
        }
        if (!isNonEmptyString(entry.reason) || entry.reason.trim().length < 24) {
            throw new TypeError(
                `Reviewed vocabulary "${entry.word}" must record why the word stands`
            );
        }
        if (reviewed.has(entry.word) || foreign.has(entry.word)) {
            throw new TypeError(
                `Reviewed vocabulary "${entry.word}" is duplicated or shadows a foreign term`
            );
        }
        reviewed.set(entry.word, entry.reason);
    }
    return { foreign, reviewed };
}

function nameTokens(name) {
    return name.match(/[A-Z]{2,}(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/gu) ?? [];
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

function isDecodingBoundary(node, source) {
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
        return { edition: "2.0.0", permits: [] };
    }
    assertExactKeys(document, ["edition", "permits"], "Weak-type permit document");
    if (document.edition !== "2.0.0") {
        throw new TypeError("Weak-type permit document must use edition 2.0.0");
    }
    assertArray(document.permits, "Weak-type permits");
    const seen = new Set();
    for (const permit of document.permits) {
        assertObject(permit, "Weak-type permit");
        assertExactKeys(permit, ["file", "kind", "anchors", "reason"], "Weak-type permit");
        assertString(permit.file, "Weak-type permit file");
        assertString(permit.kind, "Weak-type permit kind");
        const key = `${permit.file}:${permit.kind}`;
        if (seen.has(key)) throw new TypeError(`Duplicate weak-type permit ${key}`);
        seen.add(key);
        if (!WEAK_KINDS.includes(permit.kind)) {
            throw new TypeError(`Weak-type permit ${key} names an unknown escape kind`);
        }
        if (!isNonEmptyString(permit.reason) || permit.reason.trim().length < 24) {
            throw new TypeError(`Weak-type permit ${key} must record why the escape stands`);
        }
        assertArray(permit.anchors, `Weak-type permit ${key} anchors`);
        if (permit.anchors.length === 0) {
            throw new TypeError(`Weak-type permit ${key} must name at least one exact anchor`);
        }
        const anchors = new Set();
        for (const anchor of permit.anchors) {
            assertObject(anchor, `Weak-type permit ${key} anchor`);
            assertExactKeys(
                anchor,
                ["symbol", "source", "count"],
                `Weak-type permit ${key} anchor`
            );
            assertString(anchor.symbol, `Weak-type permit ${key} anchor symbol`);
            assertString(anchor.source, `Weak-type permit ${key} anchor source`);
            if (!Number.isSafeInteger(anchor.count) || anchor.count < 1) {
                throw new TypeError(`Weak-type permit ${key} anchor must record a positive count`);
            }
            const anchorKey = JSON.stringify([anchor.symbol, anchor.source]);
            if (anchors.has(anchorKey)) {
                throw new TypeError(`Weak-type permit ${key} duplicates an exact anchor`);
            }
            anchors.add(anchorKey);
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
    let spec = resolve(packageRoot, "SPEC.md");
    let exportsFile = resolve(artifactRoot, "quality/exports.json");
    let vocabulary = resolve(artifactRoot, "quality/spec-vocabulary.json");
    let writeBaseline = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--root") root = resolve(required(args, ++index, argument));
        else if (argument === "--baseline") baseline = resolve(required(args, ++index, argument));
        else if (argument === "--permits") permits = resolve(required(args, ++index, argument));
        else if (argument === "--spec") spec = resolve(required(args, ++index, argument));
        else if (argument === "--exports") exportsFile = resolve(required(args, ++index, argument));
        else if (argument === "--vocabulary")
            vocabulary = resolve(required(args, ++index, argument));
        else if (argument === "--write-baseline") writeBaseline = true;
        else throw new TypeError(`Unknown architecture argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return {
        stage,
        root,
        baseline,
        permits,
        spec,
        exports: exportsFile,
        vocabulary,
        writeBaseline
    };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
