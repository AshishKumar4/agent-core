import { basename, dirname, relative, resolve, sep } from "node:path";
import * as ts from "typescript/unstable/ast";
import { SignatureKind, SymbolFlags } from "typescript/unstable/sync";
import { configuration, hasModifier, openProject, sourceFiles } from "./compiler.mjs";
import {
    artifactRoot,
    assertArray,
    assertExactKeys,
    assertObject,
    assertString,
    collectFiles,
    compareCanonicalText,
    isNonEmptyString,
    packageRoot,
    portable,
    readCanonicalJson,
    reportRoot,
    repositoryRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";
import { vocabularyDeclarationNames } from "./export-registry.mjs";
import { ownersForPath, patternsForOwnership } from "./ownership.mjs";
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
// A record field's declared form, read as text so an inferred boolean initializer and an
// explicit annotation are judged alike: `interceptable = false` and `interceptable:
// boolean` are the same defect written two ways.
const NEGATIVE_FORM = /\b(?:boolean|false)\b/u;
const NULL_FORM = /\bnull\b/u;

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
// Tuple omissions, kept structured beside the issue list because their ledger names the
// codec and the class it fails to seal rather than a fingerprint alone. See `loadCodecOwed`.
const codecOmissions = [];
/**
 * The rules here fall into two categories, and they need different success conditions.
 *
 * Every other rule is a defect rule: ACQ-ERR, ACQ-ID, ACQ-CODEC, ACQ-IMMUTABLE and
 * ACQ-VOCAB each flag something wrong that has a fix, so their correct target is zero.
 * A defect that is not yet fixed is carried as debt, enumerated and never exempted: its
 * ledger entry states what is owed rather than why it stands, it remains outstanding, and
 * the final stage refuses while it is there. Debt lets the building stage move without
 * letting the release claim be made.
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
const recordFields = [];

for (const [path, parsed] of sourceFiles(files)) {
    const source = parsed.text;
    const file = portable(relative(options.root, path));
    const testFile = file.includes("/test/") || file.startsWith("test/");
    checkWeakTypes(parsed, source, file, testFile);
    if (testFile) checkTests(parsed, file);
    else {
        checkSuppressions(source, file);
        const aliases = errorAliases(parsed);
        visit(parsed, (node) => inspectNode(node, parsed, file, aliases));
    }
}

const codecBindings = checkCodecBindings();
reconcilePermits();
const spec = await canonicalSpec(options.spec);
await checkSpecVocabulary(spec, options.exports, options.vocabulary);

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

// ACQ-PRESENCE (SPEC §4.1, C13-FACET-CAPABILITY-ABSENCE): a field a record shape declares
// by presence carries no negative and no null form.
//
// The seeded name set has two halves and needs both. The SPEC half is what the rule's own
// paragraph names, and it is what makes the check survive a full revert: a set derived only
// from declarations that are presence-typed today goes quiet exactly when the last one
// stops being — which is the defect, not its absence. The source half generalises the rule
// to every other field the codebase presence-types, so a capability added after this
// paragraph was written is covered without editing the paragraph. A genuine two-valued
// datum neither half names is untouched.
//
// `null` is refused on every record field regardless of name, because canonical JSON
// distinguishes an omitted key from an explicit null, so a nullable field reintroduces the
// second encoding for one meaning that this rule exists to remove.
const presenceTyped = new Set([
    ...specPresenceFields(spec.source),
    ...recordFields
        .filter(
            (field) =>
                field.optional && !NEGATIVE_FORM.test(field.form) && !NULL_FORM.test(field.form)
        )
        .map((field) => field.name)
]);
for (const field of recordFields) {
    const symbol = `${field.shape}.${field.name}`;
    if (NULL_FORM.test(field.form)) {
        issue(
            "ACQ-PRESENCE",
            field.file,
            symbol,
            `${symbol} declares the nullable form ${field.form}`
        );
    } else if (NEGATIVE_FORM.test(field.form) && presenceTyped.has(field.name)) {
        issue(
            "ACQ-PRESENCE",
            field.file,
            symbol,
            `${symbol} declares the negative form ${field.form} for a presence-declared field`
        );
    }
}

issues.sort((left, right) => compareCanonicalText(left.fingerprint, right.fingerprint));
codecOmissions.sort((left, right) => compareCanonicalText(left.fingerprint, right.fingerprint));
const baseline = await loadBaseline(options.baseline);
const owed = await loadCodecOwed(options.codecOwed);
const baselineFingerprints = new Set(baseline.issues.map((item) => item.fingerprint));
const currentFingerprints = new Set(issues.map((item) => item.fingerprint));
// A tuple omission is ledgered in the owed list and nowhere else. Two ledgers for one
// finding would let a baselined omission outlive the owed list's discharge check, and that
// check is the only thing making the list a ratchet rather than a filter.
const omissions = new Map(codecOmissions.map((item) => [item.fingerprint, item]));
const ledgered = new Set(
    owed.owed.map((entry) => entry.fingerprint).filter((fingerprint) => omissions.has(fingerprint))
);
const discharged = owed.owed.filter((entry) => !omissions.has(entry.fingerprint));
const misledgered = baseline.issues.filter((item) => omissions.has(item.fingerprint));
const additions = issues.filter(
    (item) => !baselineFingerprints.has(item.fingerprint) && !ledgered.has(item.fingerprint)
);
const resolved = baseline.issues.filter((item) => !currentFingerprints.has(item.fingerprint));
// ACQ-ERR and its siblings flag a defect: every site has a fix, so an outstanding one is a
// debt awaiting payment. ACQ-KEY and ACQ-RENDER flag a shape instead, and a shape can be
// sound -- a delimiter is safe when no component can contain it, and several flagged sites
// are not identities at all but a SemVer rendering, a URL, a SQL fragment. Their terminal
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
    codecBindings,
    issues,
    additions,
    owed: [...ledgered].sort(compareCanonicalText),
    discharged,
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
        issues: issues
            .filter((item) => !omissions.has(item.fingerprint))
            .map((item) => {
                const reason = reasons.get(item.fingerprint);
                return reason === undefined ? item : { ...item, reason };
            })
    });
} else if (options.updateOwed) {
    if (process.env.QUALITY_WRITE_BASELINE !== "1" || process.env.CI) {
        throw new TypeError(
            "Writing the codec closure owed list requires QUALITY_WRITE_BASELINE=1 outside CI"
        );
    }
    const patterns = patternsForOwnership(
        await readCanonicalJson(resolve(artifactRoot, "quality/ownership.json"))
    );
    await writeCanonicalJson(options.codecOwed, {
        edition: "1.0.0",
        owed: codecOmissions.map((omission) => owedCodecClosure(omission, patterns))
    });
    console.log(`recorded ${codecOmissions.length} owed codec closure(s)`);
} else {
    await writeCanonicalJson(resolve(reportRoot, "architecture.json"), report);
    if (additions.length > 0) fail("New architecture violations", additions);
    // Paying a debt down means deleting its entry in the same change. A list that keeps an
    // entry whose finding stopped reproducing re-accepts the omission the moment it returns,
    // silently, so a discharged entry fails exactly as a new finding does.
    if (discharged.length > 0)
        fail(
            "Discharged codec closure debt left in the owed list",
            discharged.map((entry) => ({
                fingerprint: entry.fingerprint,
                message: `${entry.codec} no longer omits ${entry.missing}; remove this entry from ${basename(options.codecOwed)}`
            }))
        );
    if (misledgered.length > 0)
        fail("Codec closure debt belongs in the owed list, not the baseline", misledgered);
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
        `architecture ${report.complete ? "complete" : "incomplete"}: ${outstanding.length} outstanding, ${reviewed.size} reviewed, ${ledgered.size} codec closure(s) owed, ${resolved.length} resolved; ${codecBindings.instances} codec instance(s)`
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
        const codecBacked =
            staticCodec || (staticMethods.has("encode") && staticMethods.has("decode"));
        if (codecBacked) {
            const constructor = node.members.find(ts.isConstructorDeclaration);
            if (constructor === undefined || !freezesThis(constructor)) {
                issue("ACQ-IMMUTABLE", file, name, `${name} must freeze constructed instances`);
            }
            collectRecordFields(node, name, source, file);
        }
    }
    // A record's init shape declares the same fields the record does, so a negative form
    // reintroduced there reaches every construction site even while the class stays clean.
    if (ts.isInterfaceDeclaration(node) && /(?:Init|Fields)$/u.test(node.name.text)) {
        collectRecordFields(node, node.name.text, source, file);
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

function checkCodecBindings() {
    const coreSource = resolve(packageRoot, "src");
    const harnessSource = resolve(repositoryRoot, "packages/agent-core-harness/src");
    const targets =
        options.root === repositoryRoot
            ? [
                  {
                      config: resolve(packageRoot, "tsconfig.json"),
                      entryRoots: [coreSource],
                      ownedRoots: [coreSource]
                  },
                  {
                      config: resolve(repositoryRoot, "packages/agent-core-harness/tsconfig.json"),
                      entryRoots: [harnessSource],
                      ownedRoots: [coreSource, harnessSource],
                      // The harness resolves the core package through its workspace name.
                      // Reading its declarations instead would give the checker a second
                      // symbol for every class the tuple rule compares by identity.
                      compilerOptions: {
                          baseUrl: repositoryRoot,
                          paths: { "@agent-core/core/*": ["packages/agent-core/src/*/index.ts"] }
                      }
                  }
              ]
            : [
                  {
                      entryRoots: [resolve(options.root, "src")],
                      ownedRoots: [resolve(options.root, "src")]
                  }
              ];
    const total = {
        behavioralDependencies: 0,
        behavioralSubclasses: 0,
        classBacked: 0,
        concreteSubclasses: 0,
        genericFactories: 0,
        instances: 0,
        interfaceOrPlain: 0,
        moduleLevelInstances: 0,
        runtimeInstances: 0,
        subclasses: 0
    };
    for (const target of targets) {
        const observed = checkCodecTarget(target);
        for (const key of Object.keys(total)) total[key] += observed[key];
    }
    return total;
}

/**
 * One project per target, because a symbol is only comparable with symbols the same
 * checker produced and every rule below compares class identity. A target naming a
 * configuration inherits its resolved options; a fixture root names none and gets the
 * settings this package compiles under, since a fixture carries source and nothing else.
 */
function codecProject(target) {
    if (target.config === undefined) {
        return openProject({
            files: files.filter((file) => isWithin(file, target.entryRoots)),
            compilerOptions: {
                module: "esnext",
                moduleResolution: "bundler",
                strict: true,
                target: "es2022"
            }
        });
    }
    return openProject({
        files: configuration(target.config).fileNames,
        extend: target.config,
        compilerOptions: target.compilerOptions ?? {}
    });
}

/** Every non-declaration source of a program that lies under one of `roots`. */
function projectSources(program, roots) {
    return program
        .getSourceFileNames()
        .filter((name) => isWithin(name, roots))
        .map((name) => program.getSourceFile(name))
        .filter((source) => source !== undefined && !source.isDeclarationFile);
}

function checkCodecTarget(target) {
    const { program, checker } = codecProject(target);
    const ownedSources = projectSources(program, target.ownedRoots);
    const sources = projectSources(program, target.entryRoots);
    const recordCodecBases = recordCodecSymbols(ownedSources, checker);
    const structuralCopiers = structuralCopierSymbols(program, checker, target.ownedRoots);
    const nativeBinds = nativeBindSymbols(program, checker);
    const projectDescendants = classDescendants(ownedSources, checker);
    const codecClasses = new Map();
    const entries = [];
    const census = {
        behavioralDependencies: 0,
        behavioralSubclasses: 0,
        classBacked: 0,
        concreteSubclasses: 0,
        genericFactories: 0,
        instances: 0,
        interfaceOrPlain: 0,
        moduleLevelInstances: 0,
        runtimeInstances: 0,
        subclasses: 0
    };

    for (const source of sources) {
        visit(source, (node) => {
            if (!ts.isClassLikeDeclaration(node)) return;
            const codec = classSymbol(node, checker);
            const recordType = recordCodecRecordType(node, checker, recordCodecBases);
            if (recordType === undefined || codec === undefined) return;
            const record = resolvedSymbol(
                recordType.getAliasSymbol() ?? recordType.getSymbol(),
                checker
            );
            if (record === undefined) return;
            census.subclasses += 1;
            const behavioralDependencies = checkCodecBehavioralDependencies(node, source, checker);
            if (behavioralDependencies > 0) {
                census.behavioralSubclasses += 1;
                census.behavioralDependencies += behavioralDependencies;
            }
            if (record.flags & SymbolFlags.TypeParameter) {
                census.genericFactories += 1;
                checkCodecFactory(node, source, checker);
                codecClasses.set(codec, {
                    declaration: node,
                    generic: true,
                    record
                });
                return;
            }
            census.concreteSubclasses += 1;
            const tuple = codecSuperTuple(node);
            if (tuple === undefined) {
                codecIssue(
                    source,
                    codec.name,
                    "RecordCodec subclasses must bind a literal nonempty class tuple"
                );
                return;
            }
            const classes = codecTupleSymbols(tuple, checker);
            if (classes[0] !== record) {
                codecIssue(
                    source,
                    codec.name,
                    "RecordCodec tuple must name its exact concrete record class first"
                );
            }
            const roots = codecPayloadMethods(codec, checker);
            const binding = concreteCodecMethodBinding(roots, record, checker);
            codecClasses.set(codec, { record, declaration: node, classes, generic: false });
            entries.push({
                source,
                scope: node,
                symbol: codec.name,
                classes,
                roots: [...roots, ...binding.roots],
                seedDependencies: binding.dependencies,
                resolvedDynamicCalls: binding.resolvedDynamicCalls,
                record,
                codec
            });
        });
    }

    for (const source of sources) {
        visit(source, (node) => {
            if (!ts.isNewExpression(node)) return;
            const constructed = constructedClassSymbol(node, checker);
            const codecClass = codecClasses.get(constructed);
            if (codecClass === undefined) return;
            census.instances += 1;
            if (isModuleLevelConstruction(node)) census.moduleLevelInstances += 1;
            else census.runtimeInstances += 1;
            const constructionRecord = codecClass.generic
                ? genericCodecRecord(node, checker)
                : codecClass.record;
            if (constructionRecord?.declarations?.some(ts.isClassDeclaration)) {
                census.classBacked += 1;
            } else {
                census.interfaceOrPlain += 1;
            }
            if (!codecClass.generic) {
                checkCodecConstruction(source, node, codecClass.classes);
                return;
            }
            const tuple = node.arguments?.[0];
            if (tuple === undefined || !ts.isArrayLiteralExpression(tuple)) {
                codecIssue(
                    source,
                    symbolAt(node, source),
                    "Generic RecordCodec instances must bind a literal nonempty class tuple"
                );
                return;
            }
            const classes = codecTupleSymbols(tuple, checker);
            const primary = classes[0];
            if (primary === undefined) {
                codecIssue(source, symbolAt(node, source), "Codec class tuple must be nonempty");
                return;
            }
            const inferred = genericCodecRecord(node, checker);
            if (inferred !== primary) {
                codecIssue(
                    source,
                    symbolAt(node, source),
                    "Generic RecordCodec tuple must name its inferred concrete record class first"
                );
            }
            const binding = genericCodecBinding(node, codecClass, primary, checker);
            checkCodecConstruction(source, node, classes);
            entries.push({
                source,
                scope: node,
                symbol: symbolAt(node, source),
                classes,
                roots: binding.roots,
                seedDependencies: binding.dependencies,
                resolvedDynamicCalls: binding.resolvedDynamicCalls,
                record: primary,
                codec: undefined
            });
        });
    }

    // Whether any tuple in the target names a class at all. A debt filed against an omitted
    // class has to say whether anything freezes that class ever, or whether the freeze it
    // appears to have is another codec's construction rather than this codec's seal. Which
    // other codecs those are is not recorded: it is not needed to pay the debt, and pinning
    // it would rewrite this ledger every time an unrelated file shifted a byte offset.
    const sealedSomewhere = new Set(entries.flatMap((entry) => entry.classes));
    for (const entry of entries) {
        const seen = new Set();
        const reached = new Set(entry.seedDependencies ?? []);
        const closure = dependencies(
            entry.roots,
            entry.codec,
            seen,
            entry.resolvedDynamicCalls ?? new Set(),
            entry.record,
            projectDescendants
        );
        for (const dependency of closure.classes) {
            reached.add(dependency);
        }
        for (const unresolved of closure.unresolved) {
            codecIssue(entry.source, entry.symbol, unresolved);
        }
        for (const dependency of reached) {
            if (entry.classes.includes(dependency)) continue;
            const declaration = dependency.declarations.find(ts.isClassDeclaration);
            const omission = codecIssue(
                entry.source,
                entry.symbol,
                `Codec tuple omits reached project class ${dependency.name}`
            );
            codecOmissions.push({
                fingerprint: omission.fingerprint,
                file: omission.file,
                codec: entry.symbol,
                missing: dependency.name,
                missingFile: portable(relative(options.root, declaration.path)),
                risk: sealedSomewhere.has(dependency) ? "load-order" : "unsealed"
            });
        }
    }

    function codecTupleSymbols(tuple, semanticChecker) {
        const classes = [];
        for (const element of tuple.elements) {
            const recordClass = resolvedSymbol(
                semanticChecker.getSymbolAtLocation(element),
                semanticChecker
            );
            const declaration = recordClass?.declarations?.find(ts.isClassDeclaration);
            if (
                recordClass === undefined ||
                declaration === undefined ||
                !isWithin(declaration.path, target.ownedRoots)
            ) {
                codecIssue(
                    tuple.getSourceFile(),
                    symbolAt(tuple, tuple.getSourceFile()),
                    "Codec tuples may contain only explicit project-owned classes"
                );
                continue;
            }
            if (classes.includes(recordClass)) {
                codecIssue(
                    tuple.getSourceFile(),
                    symbolAt(tuple, tuple.getSourceFile()),
                    `Codec tuple duplicates project class ${recordClass.name}`
                );
                continue;
            }
            classes.push(recordClass);
        }
        return classes;
    }

    function codecIssue(source, symbol, message) {
        return issue(
            "ACQ-CODEC",
            portable(relative(options.root, source.fileName)),
            symbol,
            message
        );
    }

    function checkCodecBehavioralDependencies(node, source, semanticChecker) {
        const constructor = node.members.find(ts.isConstructorDeclaration);
        if (constructor?.body === undefined) return 0;
        let dependencies = 0;
        let invalid = !endsWithThisFreeze(constructor);

        for (const parameter of constructor.parameters) {
            if (!ts.isIdentifier(parameter.name)) {
                invalid = true;
                continue;
            }
            const symbol = resolvedSymbol(
                semanticChecker.getSymbolAtLocation(parameter.name),
                semanticChecker
            );
            if (symbol === undefined) continue;
            const parameterProperty = parameter.modifiers?.length > 0;
            const references = [];
            visit(constructor.body, (candidate) => {
                if (
                    ts.isIdentifier(candidate) &&
                    !enclosedBySuperCall(candidate, constructor) &&
                    resolvedSymbol(
                        semanticChecker.getSymbolAtLocation(candidate),
                        semanticChecker
                    ) === symbol
                ) {
                    references.push(candidate);
                }
            });
            if (!parameterProperty && references.length === 0) continue;
            dependencies += 1;
            invalid ||= parameterProperty;
            for (const reference of references) {
                invalid ||= !isPrivateTrustCapture(
                    reference,
                    constructor,
                    semanticChecker,
                    structuralCopiers,
                    nativeBinds
                );
            }
        }

        if (dependencies === 0) return 0;
        if (invalid) {
            codecIssue(
                source,
                node.name?.text ?? "RecordCodec",
                "RecordCodec injected behavior must cross its trust boundary into private state before a final Object.freeze(this)"
            );
        }
        return dependencies;
    }

    function dependencies(roots, codec, seen, resolvedDynamicCalls, record, descendants) {
        return codecDependencies(
            roots,
            codec,
            checker,
            seen,
            (path) => isWithin(path, target.ownedRoots),
            resolvedDynamicCalls,
            record,
            descendants,
            recordCodecBases
        );
    }

    return census;
}

function enclosedBySuperCall(node, constructor) {
    for (let current = node; current !== constructor; current = current.parent) {
        if (
            ts.isCallExpression(current) &&
            current.expression.kind === ts.SyntaxKind.SuperKeyword
        ) {
            return true;
        }
    }
    return false;
}

function isPrivateTrustCapture(node, constructor, checker, structuralCopiers, nativeBinds) {
    let crossedBoundary = false;
    for (let current = node.parent; current !== constructor; current = current.parent) {
        if (ts.isCallExpression(current)) {
            const called = calledSymbol(current, checker);
            if (structuralCopiers.has(called)) crossedBoundary = true;
            if (
                nativeBinds.has(called) &&
                current.arguments.length === 1 &&
                current.arguments[0].kind === ts.SyntaxKind.Identifier &&
                current.arguments[0].getText() === "undefined"
            ) {
                crossedBoundary = true;
            }
        }
        if (
            ts.isBinaryExpression(current) &&
            current.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            return (
                crossedBoundary &&
                ts.isPropertyAccessExpression(current.left) &&
                current.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
                ts.isPrivateIdentifier(current.left.name)
            );
        }
    }
    return false;
}

function endsWithThisFreeze(constructor) {
    const statement = constructor.body.statements.at(-1);
    if (statement === undefined || !ts.isExpressionStatement(statement)) return false;
    const node = statement.expression;
    return (
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText() === "Object" &&
        node.expression.name.text === "freeze" &&
        node.arguments[0].kind === ts.SyntaxKind.ThisKeyword
    );
}

function recordCodecSymbols(sources, checker) {
    const symbols = new Set();
    for (const source of sources) {
        visit(source, (node) => {
            if (!ts.isClassLikeDeclaration(node) || node.name?.text !== "RecordCodec") return;
            const symbol = classSymbol(node, checker);
            if (symbol !== undefined) symbols.add(symbol);
        });
    }
    return symbols;
}

/**
 * The base types of a class type. An instantiated generic arrives as a type reference and
 * reports no bases of its own — they belong to the generic it instantiates — so the walk
 * reads through the target. Asking the reference directly stops the chain one link short,
 * which is a codec whose record this rule then never sees.
 */
function baseTypesOf(checker, type) {
    return checker.getBaseTypes(type.isTypeReference() ? (type.getTarget() ?? type) : type) ?? [];
}

function recordCodecRecordType(node, checker, recordCodecBases) {
    const symbol = classSymbol(node, checker);
    if (symbol === undefined || recordCodecBases.has(symbol)) return undefined;
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    const seen = new Set();
    const pending = [...baseTypesOf(checker, declared)];
    let reachesRecordCodec = false;
    while (pending.length > 0) {
        const candidate = pending.pop();
        if (candidate === undefined || seen.has(candidate)) continue;
        seen.add(candidate);
        const base = resolvedSymbol(candidate.getAliasSymbol() ?? candidate.getSymbol(), checker);
        if (base !== undefined && recordCodecBases.has(base)) {
            reachesRecordCodec = true;
            break;
        }
        pending.push(...baseTypesOf(checker, candidate));
    }
    if (!reachesRecordCodec) return undefined;
    const encoder = checker.getPropertyOfType(declared, "encodePayload");
    if (encoder === undefined) return undefined;
    // Through the checker, not through `signature.parameters`: a signature hands back
    // detached parameter symbols the checker refuses as handles.
    const signature = checker.getSignaturesOfType(
        checker.getTypeOfSymbolAtLocation(encoder, node),
        SignatureKind.Call
    )[0];
    return signature === undefined ? undefined : checker.getParameterType(signature, 0);
}

function structuralCopierSymbols(program, checker, ownedRoots) {
    const symbols = new Set();
    for (const source of programSources(program)) {
        if (
            source.isDeclarationFile ||
            !isWithin(source.fileName, ownedRoots) ||
            !portable(source.fileName).endsWith("/src/invocations/codec.ts")
        ) {
            continue;
        }
        const module = checker.getSymbolAtLocation(source);
        for (const exported of module === undefined ? [] : checker.getExportsOfModule(module)) {
            if (exported.name === "copyStructuralCodec") {
                const symbol = resolvedSymbol(exported, checker);
                if (symbol !== undefined) symbols.add(symbol);
            }
        }
    }
    return symbols;
}

function nativeBindSymbols(program, checker) {
    const symbols = new Set();
    for (const source of programSources(program)) {
        if (!program.isSourceFileDefaultLibrary(source)) continue;
        visit(source, (node) => {
            if (
                (ts.isMethodSignatureDeclaration(node) || ts.isMethodDeclaration(node)) &&
                node.name?.getText(source) === "bind"
            ) {
                const symbol = resolvedSymbol(checker.getSymbolAtLocation(node.name), checker);
                if (symbol !== undefined) symbols.add(symbol);
            }
        });
    }
    return symbols;
}

function calledSymbol(call, checker) {
    const expression = call.expression;
    return resolvedSymbol(
        checker.getSymbolAtLocation(
            ts.isPropertyAccessExpression(expression) ? expression.name : expression
        ),
        checker
    );
}

/**
 * The class a construction names. The instance type is what resolves it: `new Renamed()`
 * and `new Codecs.Renamed()` both produce the type the class declares, while the
 * constructed expression's own symbol stops at the binding that renamed it. Reading the
 * construct signature's declaration instead is not available here — a signature's
 * declaration is a detached node the checker will not accept back.
 */
function constructedClassSymbol(node, checker) {
    const instance = checker.getTypeAtLocation(node);
    return resolvedSymbol(instance.getAliasSymbol() ?? instance.getSymbol(), checker);
}

function codecPayloadMethods(codec, checker) {
    const declared = checker.getDeclaredTypeOfSymbol(codec);
    const roots = [];
    for (const name of ["encodePayload", "decodePayload"]) {
        for (const declaration of declarationsOf(checker.getPropertyOfType(declared, name))) {
            if (ts.isMethodDeclaration(declaration)) roots.push(declaration);
        }
    }
    return roots;
}

function classDescendants(sources, checker) {
    const direct = new Map();
    for (const source of sources) {
        visit(source, (node) => {
            if (!ts.isClassLikeDeclaration(node)) return;
            const derived = classSymbol(node, checker);
            if (derived === undefined) return;
            for (const clause of node.heritageClauses ?? []) {
                if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
                for (const type of clause.types) {
                    const base = resolvedSymbol(
                        checker.getSymbolAtLocation(type.expression),
                        checker
                    );
                    if (base === undefined) continue;
                    const entries = direct.get(base) ?? [];
                    entries.push({ declaration: node, symbol: derived });
                    direct.set(base, entries);
                }
            }
        });
    }
    return (base) => {
        const result = [];
        const seen = new Set();
        const pending = [...(direct.get(base) ?? [])];
        while (pending.length > 0) {
            const candidate = pending.pop();
            if (candidate === undefined || seen.has(candidate.symbol)) continue;
            seen.add(candidate.symbol);
            result.push(candidate);
            pending.push(...(direct.get(candidate.symbol) ?? []));
        }
        return result.sort((left, right) => {
            const byFile = compareCanonicalText(
                left.declaration.getSourceFile().fileName,
                right.declaration.getSourceFile().fileName
            );
            return byFile === 0 ? left.declaration.pos - right.declaration.pos : byFile;
        });
    };
}

function isModuleLevelConstruction(node) {
    for (let current = node.parent; current !== undefined; current = current.parent) {
        if (ts.isFunctionLikeDeclaration(current) || ts.isClassStaticBlockDeclaration(current))
            return false;
        if (ts.isSourceFile(current)) return true;
    }
    return false;
}

function codecSuperTuple(node) {
    const constructor = node.members.find(ts.isConstructorDeclaration);
    const call = constructor?.body?.statements
        .filter(ts.isExpressionStatement)
        .map((statement) => statement.expression)
        .find(
            (expression) =>
                ts.isCallExpression(expression) &&
                expression.expression.kind === ts.SyntaxKind.SuperKeyword
        );
    const tuple = call !== undefined && ts.isCallExpression(call) ? call.arguments[0] : undefined;
    return tuple !== undefined && ts.isArrayLiteralExpression(tuple) ? tuple : undefined;
}

function checkCodecFactory(node, source, checker) {
    const constructor = node.members.find(ts.isConstructorDeclaration);
    const firstParameter = constructor?.parameters[0];
    const call = constructor?.body?.statements
        .filter(ts.isExpressionStatement)
        .map((statement) => statement.expression)
        .find(
            (expression) =>
                ts.isCallExpression(expression) &&
                expression.expression.kind === ts.SyntaxKind.SuperKeyword
        );
    if (
        firstParameter === undefined ||
        !ts.isIdentifier(firstParameter.name) ||
        call === undefined ||
        !ts.isCallExpression(call) ||
        resolvedSymbol(checker.getSymbolAtLocation(call.arguments[0]), checker) !==
            resolvedSymbol(checker.getSymbolAtLocation(firstParameter.name), checker)
    ) {
        issue(
            "ACQ-CODEC",
            portable(relative(options.root, source.fileName)),
            node.name?.text ?? "RecordCodec factory",
            "Generic RecordCodec factories must require and forward their class tuple"
        );
    }
}

function checkCodecConstruction(source, node, classes) {
    let deferred = false;
    for (let current = node.parent; current !== undefined; current = current.parent) {
        if (ts.isFunctionLikeDeclaration(current)) {
            deferred = true;
            break;
        }
        if (ts.isSourceFile(current)) break;
    }
    if (!deferred) {
        for (const recordClass of classes) {
            const declaration = declarationsOf(recordClass).find(ts.isClassDeclaration);
            if (
                declaration !== undefined &&
                declaration.getSourceFile() === source &&
                node.getStart(source) < declaration.getEnd()
            ) {
                issue(
                    "ACQ-CODEC",
                    portable(relative(options.root, source.fileName)),
                    symbolAt(node, source),
                    `Codec construction must follow complete initialization of ${recordClass.name}`
                );
            }
        }
    }
    for (let current = node.parent; current !== undefined; current = current.parent) {
        if (
            ts.isPropertyDeclaration(current) &&
            hasModifier(current, ts.SyntaxKind.StaticKeyword)
        ) {
            issue(
                "ACQ-CODEC",
                portable(relative(options.root, source.fileName)),
                symbolAt(node, source),
                "Codec construction is forbidden inside static field initialization"
            );
            break;
        }
        if (ts.isSourceFile(current)) break;
    }
}

function codecDependencies(
    roots,
    codec,
    checker,
    seen,
    isOwnedSource,
    resolvedDynamicCalls,
    record,
    descendants,
    recordCodecBases
) {
    const dependencies = new Set();
    const unresolved = new Set();

    function projectClass(symbol) {
        const resolved = resolvedSymbol(symbol, checker);
        const declaration = declarationsOf(resolved).find(ts.isClassDeclaration);
        return declaration !== undefined && isOwnedSource(declaration.getSourceFile().fileName)
            ? { declaration, symbol: resolved }
            : undefined;
    }

    function inspectClass(recordClass, bindings = new Map()) {
        const key = `${recordClass.getSourceFile().fileName}:${recordClass.pos}:${bindingKey(bindings)}`;
        if (seen.has(key)) return;
        seen.add(key);

        for (const clause of recordClass.heritageClauses ?? []) {
            if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
            for (const type of clause.types) {
                const inherited = projectClass(checker.getSymbolAtLocation(type.expression));
                if (inherited === undefined || inherited.symbol === codec) continue;
                dependencies.add(inherited.symbol);
                inspectClass(inherited.declaration);
            }
        }

        for (const member of recordClass.members) {
            if (ts.isConstructorDeclaration(member)) inspectCallable(member, bindings);
            if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
                inspectTree(member.initializer, member.initializer, bindings);
            }
            if (ts.isClassStaticBlockDeclaration(member)) {
                inspectTree(member.body, member.body, bindings);
            }
        }
    }

    function inspectCallable(callable, bindings = new Map()) {
        const key = `${callable.getSourceFile().fileName}:${callable.pos}:${bindingKey(bindings)}`;
        if (seen.has(key)) return;
        seen.add(key);

        if (callable.body !== undefined) inspectTree(callable.body, callable.body, bindings);
    }

    function inspectDescendants(base) {
        for (const descendant of descendants(base)) {
            dependencies.add(descendant.symbol);
            inspectClass(descendant.declaration);
        }
    }

    function inspectTree(root, node, bindings) {
        if (
            node !== root &&
            (ts.isFunctionLikeDeclaration(node) || ts.isClassLikeDeclaration(node))
        )
            return;
        if (ts.isPropertyAccessExpression(node)) {
            const member = resolvedSymbol(checker.getSymbolAtLocation(node.name), checker);
            const declarations = declarationsOf(member);
            if (
                declarations.some(isMutableClassMember) &&
                !declarations.every((declaration) =>
                    isBoundCodecOperation(declaration, checker, recordCodecBases)
                )
            ) {
                const receiverType = checker.getTypeAtLocation(node.expression);
                const receiver = resolvedSymbol(
                    receiverType.getAliasSymbol() ?? receiverType.getSymbol(),
                    checker
                );
                const receiverClass = projectClass(receiver);
                if (receiverClass !== undefined && receiverClass.symbol !== codec) {
                    dependencies.add(receiverClass.symbol);
                    if (
                        resolvedSymbol(checker.getSymbolAtLocation(node.expression), checker) !==
                        receiverClass.symbol
                    ) {
                        for (const descendant of descendants(receiverClass.symbol)) {
                            const overrides = descendant.declaration.members.filter(
                                (member) =>
                                    isMutableClassMember(member) &&
                                    !hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
                                    member.name?.getText() === node.name.getText()
                            );
                            for (const override of overrides) {
                                dependencies.add(descendant.symbol);
                                if (
                                    ts.isMethodDeclaration(override) ||
                                    ts.isGetAccessorDeclaration(override) ||
                                    ts.isSetAccessorDeclaration(override)
                                ) {
                                    inspectCallable(override, bindings);
                                }
                            }
                        }
                    }
                }
            }
            for (const declaration of declarations) {
                if (
                    isMutableClassMember(declaration) &&
                    ts.isClassDeclaration(declaration.parent) &&
                    declaration.parent.name !== undefined &&
                    isOwnedSource(declaration.getSourceFile().fileName) &&
                    !isBoundCodecOperation(declaration, checker, recordCodecBases)
                ) {
                    const owner = resolvedSymbol(
                        checker.getSymbolAtLocation(declaration.parent.name),
                        checker
                    );
                    if (owner !== undefined && owner !== codec) dependencies.add(owner);
                }
                if (ts.isGetAccessorDeclaration(declaration))
                    inspectCallable(declaration, bindings);
            }
        }
        if (ts.isCallExpression(node)) {
            if (valueIsThrown(node)) {
                node.forEachChild((child) => inspectTree(root, child, bindings));
                return;
            }
            if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
                node.forEachChild((child) => inspectTree(root, child, bindings));
                return;
            }
            const called = resolvedSymbol(
                checker.getSymbolAtLocation(
                    ts.isPropertyAccessExpression(node.expression)
                        ? node.expression.name
                        : node.expression
                ),
                checker
            );
            let resolved = false;
            for (const declaration of declarationsOf(called)) {
                if (
                    ts.isFunctionDeclaration(declaration) ||
                    ts.isMethodDeclaration(declaration) ||
                    ts.isGetAccessorDeclaration(declaration) ||
                    ts.isSetAccessorDeclaration(declaration)
                ) {
                    if (isBoundCodecOperation(declaration, checker, recordCodecBases)) {
                        resolved = true;
                        continue;
                    }
                    inspectCallable(
                        declaration,
                        callBindings(declaration, node.arguments, bindings)
                    );
                    resolved =
                        declaration.body !== undefined ||
                        ts.isClassDeclaration(declaration.parent) ||
                        resolved;
                }
            }
            const target = resolveTarget(node.expression, bindings);
            for (const callable of target.callables) {
                inspectCallable(callable, callBindings(callable, node.arguments, bindings));
                resolved = true;
            }
            for (const argument of node.arguments) {
                const callback = resolveTarget(argument, bindings);
                for (const callable of callback.callables) {
                    inspectCallable(callable, bindings);
                }
            }
            if (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression)) {
                inspectCallable(
                    node.expression,
                    callBindings(node.expression, node.arguments, bindings)
                );
                resolved = true;
            }
            if (called !== undefined && resolvedDynamicCalls.has(called)) resolved = true;
            if (
                !resolved &&
                !ts.isPropertyAccessExpression(node.expression) &&
                dynamicTargetIsProjectOwned(node.expression, called)
            ) {
                unresolved.add(
                    `Codec dependency analysis cannot resolve dynamic call ${node.expression.getText()}`
                );
            }
        }
        if (ts.isNewExpression(node)) {
            if (valueIsThrown(node)) {
                node.forEachChild((child) => inspectTree(root, child, bindings));
                return;
            }
            const target = resolveTarget(node.expression, bindings);
            let resolved = false;
            for (const constructed of target.classes) {
                if (constructed.symbol !== codec) {
                    dependencies.add(constructed.symbol);
                    const constructor = constructed.declaration.members.find(
                        ts.isConstructorDeclaration
                    );
                    inspectClass(
                        constructed.declaration,
                        constructor === undefined
                            ? new Map()
                            : callBindings(constructor, node.arguments ?? [], bindings)
                    );
                    resolved = true;
                }
            }
            if (!resolved && dynamicTargetIsProjectOwned(node.expression, undefined)) {
                unresolved.add(
                    `Codec dependency analysis cannot resolve dynamic construction ${node.expression.getText()}`
                );
            }
        }
        node.forEachChild((child) => inspectTree(root, child, bindings));
    }

    const recordClass = projectClass(record);
    if (recordClass !== undefined) {
        inspectClass(recordClass.declaration);
        inspectDescendants(recordClass.symbol);
    }
    for (const root of roots) inspectCallable(root);
    return { classes: dependencies, unresolved };

    // Only the declaring file matters here, which a declaration handle already carries;
    // resolving each one to a node would cost a round trip to answer the same question.
    function dynamicTargetIsProjectOwned(expression, symbol) {
        const declarations = symbol?.declarations ?? [];
        if (declarations.length > 0) {
            return declarations.some((declaration) => isOwnedSource(declaration.path));
        }
        if (
            ts.isIdentifier(expression) ||
            ts.isPropertyAccessExpression(expression) ||
            ts.isElementAccessExpression(expression)
        ) {
            const type = checker.getTypeAtLocation(expression);
            const typeSymbol = resolvedSymbol(type.getAliasSymbol() ?? type.getSymbol(), checker);
            const typeDeclarations = typeSymbol?.declarations ?? [];
            if (typeDeclarations.length > 0) {
                return typeDeclarations.some((declaration) => isOwnedSource(declaration.path));
            }
        }
        return !ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression);
    }

    function resolveTarget(expression, bindings, resolving = new Set()) {
        const target = { callables: [], classes: [] };
        if (isValueWrapper(expression)) {
            return resolveTarget(expression.expression, bindings, resolving);
        }
        if (ts.isPropertyAccessExpression(expression)) {
            const member = resolveObjectMembers(expression.expression, bindings, resolving).get(
                expression.name.text
            );
            if (member !== undefined) mergeTarget(target, member);
        }
        if (ts.isCallExpression(expression)) {
            const callees = resolveTarget(expression.expression, bindings, resolving);
            for (const callable of callees.callables) {
                const returnedBindings = callBindings(callable, expression.arguments, bindings);
                visitCallableReturns(callable, (returned) => {
                    mergeTarget(target, resolveTarget(returned, returnedBindings, resolving));
                });
            }
            return target;
        }
        if (ts.isElementAccessExpression(expression)) {
            const members = resolveObjectMembers(expression.expression, bindings, resolving);
            const selected =
                ts.isStringLiteral(expression.argumentExpression) ||
                ts.isNumericLiteral(expression.argumentExpression)
                    ? [members.get(expression.argumentExpression.text)]
                    : [...members.values()];
            for (const member of selected) {
                if (member !== undefined) mergeTarget(target, member);
            }
            return target;
        }
        if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
            target.callables.push(expression);
            return target;
        }
        const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
        const symbol = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
        if (symbol === undefined || resolving.has(symbol)) return target;
        const bound = bindings.get(symbol);
        if (bound !== undefined) return bound;
        const recordClass = projectClass(symbol);
        if (recordClass !== undefined) target.classes.push(recordClass);
        resolving.add(symbol);
        for (const declaration of declarationsOf(symbol)) {
            if (
                (ts.isFunctionDeclaration(declaration) ||
                    ts.isMethodDeclaration(declaration) ||
                    ts.isGetAccessorDeclaration(declaration)) &&
                declaration.body !== undefined
            ) {
                target.callables.push(declaration);
            }
            if (
                ((ts.isVariableDeclaration(declaration) && isConstVariable(declaration)) ||
                    ts.isPropertyDeclaration(declaration)) &&
                declaration.initializer !== undefined
            ) {
                mergeTarget(target, resolveTarget(declaration.initializer, bindings, resolving));
            }
        }
        resolving.delete(symbol);
        return target;
    }

    function resolveObjectMembers(expression, bindings, resolving) {
        if (isValueWrapper(expression)) {
            return resolveObjectMembers(expression.expression, bindings, resolving);
        }
        if (
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression) &&
            expression.expression.expression.getText() === "Object" &&
            expression.expression.name.text === "freeze" &&
            expression.arguments[0] !== undefined
        ) {
            return resolveObjectMembers(expression.arguments[0], bindings, resolving);
        }
        if (ts.isCallExpression(expression)) {
            const members = new Map();
            const callees = resolveTarget(expression.expression, bindings, resolving);
            for (const callable of callees.callables) {
                const returnedBindings = callBindings(callable, expression.arguments, bindings);
                visitCallableReturns(callable, (returned) => {
                    mergeMembers(
                        members,
                        resolveObjectMembers(returned, returnedBindings, resolving)
                    );
                });
            }
            return members;
        }
        if (ts.isObjectLiteralExpression(expression)) {
            const members = new Map();
            for (const property of expression.properties) {
                if (ts.isPropertyAssignment(property)) {
                    members.set(
                        property.name.getText().replaceAll(/^['"]|['"]$/gu, ""),
                        resolveTarget(property.initializer, bindings, resolving)
                    );
                } else if (ts.isShorthandPropertyAssignment(property)) {
                    members.set(
                        property.name.text,
                        resolveTarget(property.name, bindings, resolving)
                    );
                } else if (ts.isMethodDeclaration(property)) {
                    members.set(property.name.getText(), {
                        callables: [property],
                        classes: []
                    });
                }
            }
            return members;
        }
        const symbol = resolvedSymbol(checker.getSymbolAtLocation(expression), checker);
        if (symbol === undefined || resolving.has(symbol)) return new Map();
        resolving.add(symbol);
        for (const declaration of declarationsOf(symbol)) {
            if (
                (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) &&
                declaration.initializer !== undefined
            ) {
                const members = resolveObjectMembers(declaration.initializer, bindings, resolving);
                resolving.delete(symbol);
                return members;
            }
        }
        resolving.delete(symbol);
        return new Map();
    }

    function mergeMembers(target, addition) {
        for (const [name, member] of addition) {
            const existing = target.get(name);
            if (existing === undefined) target.set(name, member);
            else mergeTarget(existing, member);
        }
    }

    function visitCallableReturns(callable, inspectReturn) {
        if (callable.body === undefined) return;
        const inspect = (node) => {
            if (
                node !== callable.body &&
                (ts.isFunctionLikeDeclaration(node) || ts.isClassLikeDeclaration(node))
            )
                return;
            if (ts.isReturnStatement(node) && node.expression !== undefined) {
                inspectReturn(node.expression);
                return;
            }
            node.forEachChild(inspect);
        };
        inspect(callable.body);
    }

    function isConstVariable(declaration) {
        return (
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0
        );
    }

    function callBindings(callable, arguments_, outer) {
        const bindings = new Map(outer);
        for (const [index, parameter] of callable.parameters.entries()) {
            const argument = arguments_[index];
            if (argument === undefined) continue;
            const symbol = resolvedSymbol(checker.getSymbolAtLocation(parameter.name), checker);
            if (symbol === undefined) continue;
            bindings.set(symbol, resolveTarget(argument, outer));
        }
        return bindings;
    }

    function mergeTarget(target, addition) {
        for (const callable of addition.callables) {
            if (!target.callables.includes(callable)) target.callables.push(callable);
        }
        for (const recordClass of addition.classes) {
            if (!target.classes.some((candidate) => candidate.symbol === recordClass.symbol)) {
                target.classes.push(recordClass);
            }
        }
    }

    function bindingKey(bindings) {
        return [...bindings.entries()]
            .map(([symbol, target]) => {
                const callables = target.callables
                    .map((callable) => `${callable.getSourceFile().fileName}:${callable.pos}`)
                    .sort();
                const classes = target.classes
                    .map(
                        (recordClass) =>
                            `${recordClass.declaration.getSourceFile().fileName}:${recordClass.declaration.pos}`
                    )
                    .sort();
                return `${symbol.name}:${callables.join(",")}:${classes.join(",")}`;
            })
            .sort()
            .join(";");
    }
}

function valueIsThrown(node) {
    let current = node;
    while (
        ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertion(current.parent)
    ) {
        current = current.parent;
    }
    return ts.isThrowStatement(current.parent);
}

function isMutableClassMember(declaration) {
    return (
        ts.isMethodDeclaration(declaration) ||
        ts.isGetAccessorDeclaration(declaration) ||
        ts.isSetAccessorDeclaration(declaration) ||
        (ts.isPropertyDeclaration(declaration) &&
            hasModifier(declaration, ts.SyntaxKind.StaticKeyword))
    );
}

function isBoundCodecOperation(declaration, checker, recordCodecBases) {
    return (
        ts.isMethodDeclaration(declaration) &&
        ts.isClassLikeDeclaration(declaration.parent) &&
        recordCodecBases.has(classSymbol(declaration.parent, checker)) &&
        ts.isIdentifier(declaration.name) &&
        (declaration.name.text === "encode" || declaration.name.text === "decode")
    );
}

function genericCodecRecord(node, checker) {
    const instance = checker.getTypeAtLocation(node);
    const record = checker.getTypeArguments(instance)[0];
    return resolvedSymbol(record?.getAliasSymbol() ?? record?.getSymbol(), checker);
}

function genericCodecBinding(node, codecClass, record, checker) {
    const roots = [];
    const dependencies = new Set();
    const resolvedDynamicCalls = new Set();
    const payloadMethods = codecClass.declaration.members.filter(
        (member) =>
            ts.isMethodDeclaration(member) &&
            ts.isIdentifier(member.name) &&
            (member.name.text === "encodePayload" || member.name.text === "decodePayload")
    );
    roots.push(...payloadMethods);
    const constructor = codecClass.declaration.members.find(ts.isConstructorDeclaration);
    for (const [index, argument] of (node.arguments ?? []).entries()) {
        const argumentRoots = codecArgumentRoots(argument, checker);
        roots.push(...argumentRoots);
        const parameter = constructor?.parameters[index];
        if (parameter !== undefined && argumentRoots.length > 0) {
            const parameterSymbol = resolvedSymbol(
                checker.getSymbolAtLocation(parameter.name),
                checker
            );
            if (parameterSymbol !== undefined) resolvedDynamicCalls.add(parameterSymbol);
        }
        for (const declaration of argumentRoots) {
            const owner = classSymbol(declaration.parent, checker);
            if (owner !== undefined) dependencies.add(owner);
        }
    }
    for (const name of genericRecordMemberNames(payloadMethods, codecClass.record, checker)) {
        const genericMember = checker.getPropertyOfType(
            checker.getDeclaredTypeOfSymbol(codecClass.record),
            name
        );
        if (genericMember !== undefined) resolvedDynamicCalls.add(genericMember);
        const member = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(record), name);
        for (const declaration of declarationsOf(member)) {
            if (!ts.isMethodDeclaration(declaration) && !ts.isGetAccessorDeclaration(declaration)) {
                continue;
            }
            roots.push(declaration);
            const owner = classSymbol(declaration.parent, checker);
            if (owner !== undefined) dependencies.add(owner);
        }
    }
    return { dependencies, resolvedDynamicCalls, roots };
}

function concreteCodecMethodBinding(roots, record, checker) {
    const dependencies = new Set();
    const resolvedDynamicCalls = new Set();
    const boundRoots = [];
    for (const root of roots) {
        const parameter = root.parameters[0];
        if (parameter?.type === undefined) continue;
        const generic = resolvedSymbol(
            checker.getTypeFromTypeNode(parameter.type).getSymbol(),
            checker
        );
        if (generic === undefined || !(generic.flags & SymbolFlags.TypeParameter)) continue;
        for (const name of genericRecordMemberNames(roots, generic, checker)) {
            const genericMember = checker.getPropertyOfType(
                checker.getDeclaredTypeOfSymbol(generic),
                name
            );
            if (genericMember !== undefined) resolvedDynamicCalls.add(genericMember);
            const member = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(record), name);
            for (const declaration of declarationsOf(member)) {
                if (
                    !ts.isMethodDeclaration(declaration) &&
                    !ts.isGetAccessorDeclaration(declaration)
                ) {
                    continue;
                }
                boundRoots.push(declaration);
                const owner = classSymbol(declaration.parent, checker);
                if (owner !== undefined) dependencies.add(owner);
            }
        }
    }
    return { dependencies, resolvedDynamicCalls, roots: boundRoots };
}

function codecArgumentRoots(argument, checker) {
    if (codecCallable(argument)) return [argument];
    const location = ts.isPropertyAccessExpression(argument) ? argument.name : argument;
    const member = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
    return declarationsOf(member).filter(
        (declaration) =>
            (ts.isFunctionDeclaration(declaration) ||
                ts.isMethodDeclaration(declaration) ||
                ts.isGetAccessorDeclaration(declaration)) &&
            declaration.body !== undefined
    );
}

function genericRecordMemberNames(roots, record, checker) {
    const names = new Set();
    for (const root of roots) {
        visit(root, (node) => {
            if (!ts.isPropertyAccessExpression(node)) return;
            const receiver = checker.getTypeAtLocation(node.expression);
            if (
                resolvedSymbol(receiver.getAliasSymbol() ?? receiver.getSymbol(), checker) ===
                record
            ) {
                names.add(node.name.text);
            }
        });
    }
    return names;
}

function classSymbol(node, checker) {
    if (!ts.isClassLikeDeclaration(node)) return undefined;
    if (node.name !== undefined) {
        return resolvedSymbol(checker.getSymbolAtLocation(node.name), checker);
    }
    const type = checker.getTypeAtLocation(node);
    return resolvedSymbol(type.getAliasSymbol() ?? type.getSymbol(), checker);
}

/**
 * Whether an expression only wraps the value its operand already is. Grouping and the
 * three type-only forms carry no runtime step, so a resolution that stopped at one would
 * report a dispatch table it can see through as unresolvable — a false unresolved target,
 * which this gate must fail on and therefore must not manufacture.
 */
function isValueWrapper(node) {
    return (
        ts.isParenthesizedExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertion(node)
    );
}

function codecCallable(node) {
    return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function resolvedSymbol(symbol, checker) {
    return symbol !== undefined && symbol.flags & SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
}

/**
 * The live nodes a symbol declares. TypeScript 7 reports declarations as handles carrying
 * a kind and a path and nothing else, so a rule that reads a body, a parent or a position
 * resolves them; a rule that only asks where a declaration lives reads `path` directly.
 */
function declarationsOf(symbol) {
    return (symbol?.declarations ?? [])
        .map((handle) => handle.resolve())
        .filter((node) => node !== undefined);
}

/** Every source of a program the session can materialize, including its default library. */
function programSources(program) {
    return program
        .getSourceFileNames()
        .map((name) => program.getSourceFile(name))
        .filter((source) => source !== undefined);
}

function isWithin(path, roots) {
    return roots.some((root) => {
        const local = relative(root, path);
        return local === "" || (local !== ".." && !local.startsWith(`..${sep}`));
    });
}

/**
 * Every field one record shape declares: its own properties and the constructor parameter
 * properties that are equally part of the record. `declaredForm` reads the annotation when
 * there is one and the boolean literal initializer when there is not, because the negative
 * encoding this rule removes was written without an annotation.
 */
function collectRecordFields(node, shape, source, file) {
    const fields = [];
    for (const member of node.members) {
        if (
            (ts.isPropertyDeclaration(member) || ts.isPropertySignatureDeclaration(member)) &&
            !hasModifier(member, ts.SyntaxKind.StaticKeyword)
        ) {
            fields.push(member);
        } else if (ts.isConstructorDeclaration(member)) {
            for (const parameter of member.parameters) {
                if (
                    hasModifier(parameter, ts.SyntaxKind.PublicKeyword) ||
                    hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword)
                ) {
                    fields.push(parameter);
                }
            }
        }
    }
    for (const field of fields) {
        const form = declaredForm(field, source);
        if (form === undefined || field.name === undefined) continue;
        recordFields.push({
            file,
            shape,
            name: field.name.getText(source),
            form,
            // A default is not a presence declaration: a field with an initializer always
            // carries a value, so it may seed nothing. The initializer is read only by
            // `declaredForm`, to see the un-annotated `= false` this rule removes — reusing
            // it here would let one flag answer "may this be absent" and "does this have a
            // default" with one value, which is the collapse the rule itself is about.
            optional: field.questionToken !== undefined || /\bundefined\b/u.test(form)
        });
    }
}

function declaredForm(field, source) {
    if (field.type !== undefined) return field.type.getText(source);
    if (field.initializer === undefined) return undefined;
    if (field.initializer.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (field.initializer.kind === ts.SyntaxKind.FalseKeyword) return "false";
    return undefined;
}

/**
 * The field names SPEC §4.1's presence rule names, read from the paragraph that maps to
 * C13-FACET-CAPABILITY-ABSENCE. An empty extraction is a failure rather than a quiet pass:
 * a rule whose anchor stopped resolving would report a clean run over a set it no longer
 * seeds, which is the shape of a checker a refactor turned into a no-op.
 */
function specPresenceFields(source) {
    const label = "**C13-FACET-CAPABILITY-ABSENCE**";
    const anchor = source.indexOf(label);
    if (anchor < 0) throw new TypeError(`SPEC states no ${label} anchor for ACQ-PRESENCE`);
    const start = source.lastIndexOf("\n\n", anchor);
    const paragraph = source.slice(start < 0 ? 0 : start, anchor);
    const names = new Set([...paragraph.matchAll(/`([a-z][A-Za-z0-9]*)`/gu)].map(([, id]) => id));
    if (names.size === 0) {
        throw new TypeError(`SPEC ${label} paragraph names no presence-declared field`);
    }
    return names;
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
        if (ts.isTypeAssertion(node)) record("assertion", node);
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
            ts.isPropertySignatureDeclaration(node) ||
            ts.isParameterDeclaration(node) ||
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
        (ts.isParameterDeclaration(owner) ||
            ts.isPropertyDeclaration(owner) ||
            ts.isPropertySignatureDeclaration(owner) ||
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
    if (parameter === undefined || !ts.isParameterDeclaration(parameter)) return false;
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
async function checkSpecVocabulary({ visibleBlocks }, exportsFile, vocabularyFile) {
    const registryPath = portable(relative(options.root, exportsFile));
    const vocabularyPath = portable(relative(options.root, vocabularyFile));
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
    // `+es` only pluralizes a word already ending in a sibilant. Applying it to every word
    // makes an unrelated longer word discharge a reviewed entry: `plan` + `es` matched the
    // SPEC's `planes` (as in the authority plane), which is not a plural of `plan`.
    const sibilant = (candidate) => /(?:s|x|z|ch|sh)$/u.test(candidate);
    const containsWord = (token) =>
        singularForms(token).some(
            (candidate) =>
                specWords.has(candidate) ||
                specWords.has(`${candidate}s`) ||
                (sibilant(candidate) && specWords.has(`${candidate}es`)) ||
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
    const recorded = { rule, file, symbol, message, fingerprint };
    issues.push(recorded);
    return recorded;
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
    if (
        !ts.isPropertyDeclaration(node) &&
        !ts.isPropertySignatureDeclaration(node) &&
        !ts.isParameterDeclaration(node)
    )
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

async function loadBaseline(path) {
    try {
        return await readCanonicalJson(path);
    } catch (error) {
        if (error?.code === "ENOENT") return { edition: "1.0.0", issues: [] };
        throw error;
    }
}

/**
 * The owed codec closures: an enumeration of debts, never a set of exemptions. `RecordCodec`
 * freezes the prototype and the constructor of exactly the classes its tuple names, so a
 * class the codec constructs while decoding but does not name keeps both writable. The
 * counterfactual therefore runs toward the tamper succeeding, which is why no entry may
 * carry a reason for standing: there is nothing true to write there. A debt is discharged by
 * naming the class in the tuple and deleting the entry, and by nothing else.
 */
async function loadCodecOwed(path) {
    let document;
    try {
        document = await readCanonicalJson(path);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        return { edition: "1.0.0", owed: [] };
    }
    assertExactKeys(document, ["edition", "owed"], "Codec closure owed document");
    if (document.edition !== "1.0.0") {
        throw new TypeError("Codec closure owed document must use edition 1.0.0");
    }
    assertArray(document.owed, "Codec closure debts");
    const seen = new Set();
    for (const entry of document.owed) {
        assertObject(entry, "Codec closure debt");
        assertExactKeys(
            entry,
            [
                "fingerprint",
                "file",
                "codec",
                "missing",
                "missingFile",
                "risk",
                "owner",
                "counterfactual"
            ],
            "Codec closure debt"
        );
        for (const key of [
            "fingerprint",
            "file",
            "codec",
            "missing",
            "missingFile",
            "risk",
            "owner"
        ]) {
            assertString(entry[key], `Codec closure debt ${key}`);
        }
        if (entry.risk !== "unsealed" && entry.risk !== "load-order") {
            throw new TypeError(
                `Codec closure debt ${entry.fingerprint} states an unknown risk ${entry.risk}`
            );
        }
        if (seen.has(entry.fingerprint)) {
            throw new TypeError(`Duplicate codec closure debt ${entry.fingerprint}`);
        }
        seen.add(entry.fingerprint);
        // The entry has to be about the site its fingerprint identifies, and its evidence has
        // to be about the class it is filed against, so neither can be transplanted from
        // another debt and left to suppress a finding it does not describe.
        if (!entry.fingerprint.startsWith(`ACQ-CODEC:${entry.file}:${entry.codec}:`)) {
            throw new TypeError(
                `Codec closure debt ${entry.fingerprint} does not name the site it suppresses`
            );
        }
        if (
            !isNonEmptyString(entry.counterfactual) ||
            !entry.counterfactual.includes(entry.missing)
        ) {
            throw new TypeError(
                `Codec closure debt ${entry.fingerprint} must state the counterfactual for ${entry.missing}`
            );
        }
    }
    return document;
}

function owedCodecClosure(omission, patterns) {
    const { fingerprint, file, codec, missing, missingFile, risk } = omission;
    return {
        fingerprint,
        file,
        codec,
        missing,
        missingFile,
        risk,
        owner: ownersForPath(file, patterns).join("/"),
        // The apparently harmless case is a class some other codec's tuple names, and it is
        // the `TextId` hazard rather than a seal: the freeze is a side effect of when that
        // other codec happens to be constructed, so this codec's module imported on its own
        // decodes through a writable class.
        counterfactual:
            risk === "unsealed"
                ? `No codec tuple names ${missing} anywhere, so nothing ever freezes it: Object.defineProperty(${missing}.prototype, …) succeeds and ${codec} still decodes through it`
                : `${codec}'s own seal does not cover ${missing}: ${missing} is frozen only once some other codec that does name it is constructed, so what protects it is that module's load order rather than this tuple`
    };
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
    let updateOwed = false;
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
        else if (argument === "--update-owed") updateOwed = true;
        else throw new TypeError(`Unknown architecture argument ${argument}`);
    }
    if (writeBaseline && updateOwed) {
        throw new TypeError("Write the architecture baseline and the owed list one at a time");
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return {
        stage,
        root,
        baseline,
        // The owed list accompanies the baseline it divides the ledger with, so it is found
        // beside it rather than named twice on the command line -- and a fixture root, which
        // names its own baseline and carries no owed list, gets an empty one.
        codecOwed: resolve(dirname(baseline), "architecture-codec-owed.json"),
        permits,
        spec,
        exports: exportsFile,
        vocabulary,
        writeBaseline,
        updateOwed
    };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
