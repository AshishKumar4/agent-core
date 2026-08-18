// Digest-derivation gate: a declaration's canonical bytes behind a durable identity is a
// standing property of this codebase, not a discovery to be written down once per incident.
//
// Four subsystems put a record type's serialised form behind an identity that outlives the
// process. A correct SPEC change to one of those record types forks the identity, and the
// fork is invisible to every test suite for a structural reason: fixtures construct records
// consistently *within* one revision, so identity stability ACROSS a revision boundary is
// not a property any suite can observe. No amount of test discipline reaches it. What can
// reach it is an enumeration that runs on every change and fails when it finds a path
// nobody has accounted for.
//
// What counts as a path. The digested expression must carry a codec-declaring record type's
// own canonical bytes — its static `encode`, or a zero-argument `*Data()` method on an
// instance of it — or a `ContentRef`, which is by construction the digest of canonical bytes
// already written to a content-addressed store. That predicate is directional on purpose. A
// record that merely *carries* a `Digest` field computed from something outside itself
// (`identity.share-offer`'s `secretDigest` over a bearer secret) reaches nothing: no identity
// derives from that record's bytes, and changing its shape forks nothing. The inbound case
// resembles the outbound one on every surface feature and is the likeliest false positive,
// so it is excluded by the predicate rather than by a list.
//
// And the derived value must reach a durable consumer: an identity constructor, or a field
// name this package emits into canonical data. A digest compared against another digest
// derived in the same call is a per-run check whose two sides move together; it cannot fork
// across a revision and it is not reported.
//
// Classification is reviewed rather than inferred, and it takes two bits, not one. Whether a
// mismatch emits a signal — a throw, a refusal, a red test — and whether it has an
// observable consequence — a duplicate dispatch, a double-counted resource — are different
// questions. Every derivation found so far answers the first the same way, so a single flag
// would sort the whole population into one bucket and rank nothing. The pair identifies the
// cell that matters: no signal and no consequence, discoverable only by an audit nobody will
// run.
import { relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { codecClassDeclarations } from "./codec-records.mjs";
import { resolveSourceSymbol, sourceProject } from "./evidence.mjs";
import { loadOwnership, ownersForPath } from "./ownership.mjs";
import {
    artifactRoot,
    assertArray,
    assertBoolean,
    assertExactKeys,
    assertOneOf,
    assertString,
    collectFiles,
    readCanonicalJson,
    reportRoot,
    sha256,
    writeCanonicalJson
} from "./project.mjs";

const ENTRY_KEYS = [
    "accounting",
    "consumer",
    "emitsSignal",
    "hasObservableConsequence",
    "justification",
    "migration",
    "recordType",
    "shapeDigest",
    "shapeSource",
    "site"
];
const ACCOUNTING = ["unaccounted", "accounted-unforked", "accounted-forked"];
// `Digest.sha256` is this package's only canonical hasher. The gate asserts that rather than
// assuming it, because a second static on `Digest` would be a derivation channel this walk
// silently does not look at — the shape of failure a gate must never have.
const HASHER = "Digest.sha256";
const CANONICAL_JSON = new Set(["encodeCanonicalJson", "encodeCanonicalJsonBytes"]);
const CONTENT_ADDRESSED = "ContentRef";
const CONTENT_ADDRESSED_SOURCE = "content-addressed";

const options = parseArguments(process.argv.slice(2));
const project = sourceProject();
const checker = project.checker;

const sourceRoots = [
    { root: resolve(options.packageRoot, "src"), prefix: "" },
    { root: resolve(options.packageRoot, "../agent-core-cloudflare/src"), prefix: "cloudflare/" }
];

assertSingleHasher();

const codecs = (
    await Promise.all(
        sourceRoots.map((source) => codecClassDeclarations(source.root, source.prefix))
    )
).flat();
const codecsByName = new Map();
for (const record of codecs) {
    codecsByName.set(record.name, [...(codecsByName.get(record.name) ?? []), record.selector]);
}
const files = await parsedSourceFiles();
const canonicalFields = collectCanonicalFieldNames();
const canonicalShapes = new Map(
    codecs.map((record) => [record.selector, canonicalShapeOf(record)])
);
const derivations = files.flatMap((file) => derivationsIn(file)).sort(bySite);

const register = await readCanonicalJson(options.register);
assertExactKeys(register, ["edition", "entries"], "Digest derivation register");
if (register.edition !== "1.0.0") throw new TypeError("Unsupported digest derivation edition");
const entries = assertArray(register.entries, "Digest derivation entries").map(validateEntry);

const migrationIds = await knownMigrationIds();
const ownershipPatterns = (await loadOwnership()).patterns;

// Staleness is a hard error, never a finding. A baselined stale row is a row nobody rewrites,
// and a register whose entries no longer name anything real is exactly the vacuous instrument
// this gate exists to prevent elsewhere.
const enumerated = new Map(derivations.map((derivation) => [keyOf(derivation), derivation]));
for (const entry of entries) {
    if (
        entry.recordType !== CONTENT_ADDRESSED_SOURCE &&
        !codecs.some((record) => record.selector === entry.recordType)
    ) {
        throw new TypeError(
            `Digest derivation names a type that no longer declares a codec: ${entry.recordType}`
        );
    }
    resolveSourceSymbol(project, entry.site);
    if (!enumerated.has(keyOf(entry))) {
        throw new TypeError(
            `Digest derivation entry no longer resolves to a derivation: ${keyOf(entry)}`
        );
    }
    const shape = canonicalShapes.get(entry.shapeSource);
    if (shape === undefined) {
        throw new TypeError(
            `Digest derivation shape source declares no codec: ${entry.shapeSource}`
        );
    }
    // The fork tripwire. Enumeration alone catches a new path; it cannot catch the event that
    // actually forks an identity, which is a shape change to a record already on one. A moved
    // shape fails here so the mover accounts for the fork in the same change, rather than a
    // later reader discovering it from a digest that stopped matching.
    if (shape.digest !== entry.shapeDigest) {
        throw new TypeError(
            `Canonical shape of ${entry.shapeSource} moved (${entry.shapeDigest} -> ${shape.digest}); ` +
                `it is behind ${entry.consumer} at ${entry.site}. Fields now: ${shape.fields.join(", ")}`
        );
    }
    if (entry.accounting === "accounted-forked") {
        if (entry.migration === null) {
            throw new TypeError(`Forked digest derivation declares no migration: ${keyOf(entry)}`);
        }
        if (!migrationIds.has(entry.migration)) {
            throw new TypeError(
                `Digest derivation names an unknown migration ${entry.migration}: ${keyOf(entry)}`
            );
        }
    } else if (entry.migration !== null) {
        throw new TypeError(
            `Only a forked digest derivation may name a migration: ${keyOf(entry)}`
        );
    }
}

const accounted = new Map(entries.map((entry) => [keyOf(entry), entry]));
const issues = derivations
    .filter((derivation) => !accounted.has(keyOf(derivation)))
    .map((derivation) => ({
        rule: "DIGEST-DERIVATION-UNREGISTERED",
        file: derivation.file,
        symbol: derivation.site,
        owner: ownerOf(derivation.file),
        message: `${derivation.recordType} reaches ${derivation.consumer} at ${derivation.site} with no register entry`,
        fingerprint: `DIGEST-DERIVATION-UNREGISTERED:${sha256(keyOf(derivation)).slice(0, 16)}`
    }));

const reported = derivations.map((derivation) => {
    const entry = accounted.get(keyOf(derivation));
    return {
        recordType: derivation.recordType,
        site: derivation.site,
        consumer: derivation.consumer,
        expression: derivation.expression,
        owner: ownerOf(derivation.file),
        accounting: entry?.accounting ?? null,
        migration: entry?.migration ?? null,
        emitsSignal: entry?.emitsSignal ?? null,
        hasObservableConsequence: entry?.hasObservableConsequence ?? null,
        registered: entry !== undefined
    };
});
// Worst cell first: an unregistered derivation that emits no signal and has no observable
// consequence is discoverable by nothing except this gate.
reported.sort(
    (left, right) => severity(left) - severity(right) || left.site.localeCompare(right.site)
);

await writeCanonicalJson(resolve(reportRoot, "digest-derivations.json"), {
    edition: "1.0.0",
    stage: options.stage,
    derivations: reported,
    issues,
    complete: issues.length === 0
});
if (issues.length > 0) {
    throw new TypeError(
        `Unaccounted digest derivations:\n${issues.map((issue) => `  ${issue.fingerprint} [${issue.owner}] ${issue.message}`).join("\n")}`
    );
}
console.log(
    `digest derivations complete: ${derivations.length} derivation(s), ${issues.length} unaccounted`
);

function severity(entry) {
    if (!entry.registered) return 0;
    if (entry.emitsSignal === false && entry.hasObservableConsequence === false) return 1;
    if (entry.emitsSignal === false) return 2;
    return 3;
}

function keyOf(value) {
    return `${value.recordType}|${value.site}|${value.consumer}`;
}

function bySite(left, right) {
    return keyOf(left).localeCompare(keyOf(right));
}

function validateEntry(value, index) {
    assertExactKeys(value, ENTRY_KEYS, `Digest derivation entry ${index}`);
    assertString(value.recordType, "Digest derivation record type");
    assertString(value.site, "Digest derivation site");
    assertString(value.consumer, "Digest derivation consumer");
    assertString(value.justification, "Digest derivation justification");
    assertOneOf(value.accounting, ACCOUNTING, "Digest derivation accounting");
    assertBoolean(value.emitsSignal, "Digest derivation signal");
    assertBoolean(value.hasObservableConsequence, "Digest derivation consequence");
    assertString(value.shapeSource, "Digest derivation shape source");
    assertString(value.shapeDigest, "Digest derivation shape digest");
    if (value.migration !== null) assertString(value.migration, "Digest derivation migration");
    if (value.justification.length < 80) {
        throw new TypeError(
            `Digest derivation entry ${index} has no written justification: ${value.site}`
        );
    }
    return value;
}

/**
 * A record type's canonical shape: the property names it declares plus the keys its own
 * canonical-data producers emit, sorted and digested.
 *
 * This is a tripwire and not a proof of the serialised bytes. It cannot see a value's
 * encoding change under an unchanged key, and it fires on a rename that moves no bytes. Both
 * directions are the right cost: a false positive costs one reviewed register line, and the
 * event it does catch — a key appearing or disappearing, which is exactly what presence-typing
 * a field does — is the event that forked two durable identities with no test able to see it.
 */
function canonicalShapeOf(record) {
    const names = new Set();
    const collect = (node) => {
        if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
            names.add(node.name.getText(record.source));
        }
        node.forEachChild(collect);
    };
    for (const member of record.declaration.members) {
        if (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
            names.add(member.name.getText(record.source));
        }
        if (ts.isMethodDeclaration(member) && producerName(member, record.source) !== undefined) {
            if (member.body !== undefined) collect(member.body);
        }
    }
    const fields = [...names].sort();
    return { fields, digest: sha256(fields.join("\u0000")).slice(0, 16) };
}

function ownerOf(file) {
    const repositoryPath = file.startsWith("cloudflare/")
        ? `packages/agent-core-cloudflare/${file.slice("cloudflare/".length)}`
        : `packages/agent-core/${file}`;
    const owners = ownersForPath(repositoryPath, ownershipPatterns);
    return owners.length === 1 ? owners[0] : owners.join("+") || "unowned";
}

async function knownMigrationIds() {
    const root = resolve(options.artifactRoot, "migrations");
    const ids = new Set();
    for (const path of await collectFiles(root, (name) => name.endsWith(".json"))) {
        const fragment = await readCanonicalJson(path);
        for (const migration of fragment.migrations ?? []) ids.add(migration.id);
    }
    return ids;
}

async function parsedSourceFiles() {
    const parsed = [];
    for (const { root, prefix } of sourceRoots) {
        const paths = await collectFiles(
            root,
            (path) => /\.(?:[cm]?ts|tsx)$/.test(path) && !/\.d\.[cm]?ts$/.test(path)
        );
        for (const path of paths) {
            const source = project.program.getSourceFile(path);
            if (source === undefined) {
                throw new TypeError(`Digest derivation walk cannot read ${path}`);
            }
            parsed.push({
                file: `${prefix}${relative(resolve(root, ".."), path).replaceAll("\\", "/")}`,
                source
            });
        }
    }
    return parsed;
}

/**
 * The property names this package emits into canonical data. A derived digest stored under
 * one of them is durable; stored under anything else it is a local.
 *
 * Producers are every `*Data`/`encodePayload` body in the source set plus the instance fields
 * of the codec-declaring classes. The walk deliberately spans all files rather than only the
 * ones declaring a codec: several records canonicalise through a module-level function in a
 * file that declares none, and scoping the walk to codec files silently lost a known
 * derivation — the `skeletonDigest` a Slate intent canonicalises through `mutationData`.
 */
function collectCanonicalFieldNames() {
    const names = new Set();
    const collect = (node, source) => {
        if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
            names.add(node.name.getText(source));
        }
        node.forEachChild((child) => collect(child, source));
    };
    for (const record of codecs) {
        for (const member of record.declaration.members) {
            if (ts.isPropertyDeclaration(member)) names.add(member.name.getText(record.source));
        }
    }
    for (const { source } of files) {
        const visit = (node) => {
            if (producerName(node, source) !== undefined && node.body !== undefined) {
                collect(node.body, source);
            }
            node.forEachChild(visit);
        };
        source.forEachChild(visit);
    }
    return names;
}

function producerName(node, source) {
    if (!ts.isMethodDeclaration(node) && !ts.isFunctionDeclaration(node)) return undefined;
    const name = node.name?.getText(source);
    return name !== undefined && /Data$|^encodePayload$/u.test(name) ? name : undefined;
}

function derivationsIn({ file, source }) {
    const found = [];
    const visit = (node) => {
        if (ts.isCallExpression(node) && node.expression.getText(source) === HASHER) {
            const argument = node.arguments[0];
            const digested = unwrapCanonicalJson(argument, source);
            if (digested !== undefined) {
                const recordType = byteSource(digested, source);
                if (recordType !== undefined) {
                    const consumer = durableConsumer(node, source);
                    if (consumer !== undefined) {
                        found.push({
                            file,
                            recordType,
                            consumer,
                            site: enclosingSelector(node, source, file),
                            expression: node.getText(source).replaceAll(/\s+/gu, " ")
                        });
                    }
                }
            }
        }
        node.forEachChild(visit);
    };
    source.forEachChild(visit);
    return found;
}

function unwrapCanonicalJson(argument, source) {
    if (argument === undefined) return undefined;
    return ts.isCallExpression(argument) && CANONICAL_JSON.has(argument.expression.getText(source))
        ? argument.arguments[0]
        : argument;
}

/**
 * Which record type's canonical bytes the digested expression carries, or undefined when it
 * carries none. A `ContentRef` is reported as the content-addressed store rather than as a
 * type: its bytes are a record's, but which record is a fact about the write that produced
 * the reference and the register names it.
 */
function byteSource(expression, source) {
    let record;
    let contentRef = false;
    const visit = (node) => {
        if (record !== undefined) return;
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            const receiver = node.expression.expression;
            if (method === "encode") {
                const owner = ts.isPropertyAccessExpression(receiver)
                    ? receiver.expression
                    : receiver;
                record ??= codecSelector(typeNameOf(owner, source).replace(/^typeof\s+/u, ""));
            } else if (method.endsWith("Data") && node.arguments.length === 0) {
                const declared = typeNameOf(receiver, source);
                record ??= codecSelector(
                    declared === "this" ? enclosingClassName(node, source) : declared
                );
            }
        }
        if (
            (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
            typeNameOf(node, source) === CONTENT_ADDRESSED
        ) {
            contentRef = true;
        }
        node.forEachChild(visit);
    };
    visit(expression);
    return record ?? (contentRef ? CONTENT_ADDRESSED_SOURCE : undefined);
}

function codecSelector(name) {
    const matches = name === undefined ? undefined : codecsByName.get(name);
    return matches === undefined ? undefined : matches[0];
}

function typeNameOf(node, source) {
    if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
    try {
        return checker
            .typeToString(checker.getTypeAtLocation(node))
            .replace(/\s*\|\s*undefined$/u, "")
            .trim();
    } catch {
        return node.getText(source);
    }
}

function enclosingClassName(node, source) {
    let current = node;
    while (current.parent !== undefined) {
        current = current.parent;
        if (ts.isClassDeclaration(current)) return current.name?.getText(source);
    }
    return undefined;
}

/**
 * What the derived digest becomes. An identity constructor anywhere above the derivation wins
 * over a field name, because the object literal a digest is placed into on the way into an id
 * is a step in the derivation rather than a resting place.
 */
function durableConsumer(node, source) {
    let current = node;
    let field;
    while (current.parent !== undefined) {
        const parent = current.parent;
        if (ts.isNewExpression(parent)) {
            const name = parent.expression.getText(source);
            if (name.endsWith("Id")) return `identity:${name}`;
        }
        if (field === undefined && ts.isPropertyAssignment(parent)) {
            field = parent.name.getText(source);
        }
        if (
            field === undefined &&
            ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(parent.left)
        ) {
            field = parent.left.name.text;
        }
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            const identity = identityFromVariable(parent, source);
            if (identity !== undefined) return identity;
        }
        if (ts.isSourceFile(parent)) break;
        current = parent;
    }
    return field !== undefined && canonicalFields.has(field) ? `field:${field}` : undefined;
}

/** An id minted from a local the derivation initialised, within the declaration that holds both. */
function identityFromVariable(declaration, source) {
    const name = declaration.name.getText(source);
    let scope = declaration;
    while (scope.parent !== undefined && !ts.isSourceFile(scope.parent) && !isBodied(scope)) {
        scope = scope.parent;
    }
    let identity;
    const visit = (node) => {
        if (identity === undefined && ts.isNewExpression(node)) {
            const constructed = node.expression.getText(source);
            if (constructed.endsWith("Id") && mentions(node, name)) {
                identity = `identity:${constructed}`;
            }
        }
        node.forEachChild(visit);
    };
    visit(scope);
    return identity;
}

function isBodied(node) {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isGetAccessorDeclaration(node)
    );
}

function mentions(node, name) {
    let found = false;
    const visit = (child) => {
        if (ts.isIdentifier(child) && child.text === name) found = true;
        child.forEachChild(visit);
    };
    visit(node);
    return found;
}

/** The `path#Declaration[.member]` selector `resolveSourceSymbol` reads, for the enclosing code. */
function enclosingSelector(node, source, file) {
    let current = node;
    let member;
    while (current.parent !== undefined && !ts.isSourceFile(current.parent)) {
        const parent = current.parent;
        if (
            member === undefined &&
            (ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent)) &&
            ts.isClassDeclaration(parent.parent)
        ) {
            member = parent.name?.getText(source);
        }
        current = parent;
    }
    if (ts.isClassDeclaration(current)) {
        const name = current.name?.getText(source);
        return member === undefined ? `${file}#${name}` : `${file}#${name}.${member}`;
    }
    if (ts.isFunctionDeclaration(current)) return `${file}#${current.name?.getText(source)}`;
    if (ts.isVariableStatement(current)) {
        const declared = current.declarationList.declarations[0]?.name.getText(source);
        return `${file}#${declared}`;
    }
    throw new TypeError(`Digest derivation is not inside a nameable declaration in ${file}`);
}

/**
 * `Digest` exposing exactly one static hasher is what makes one callee text a complete walk.
 * A second one would be a derivation channel with no reader, so it fails here rather than
 * being silently unexamined.
 */
function assertSingleHasher() {
    const path = resolve(options.packageRoot, "src/core/digest.ts");
    const source = project.program.getSourceFile(path);
    if (source === undefined) throw new TypeError("Digest declaration is unreadable");
    const digest = source.statements.find(
        (statement) =>
            ts.isClassDeclaration(statement) && statement.name?.getText(source) === "Digest"
    );
    if (digest === undefined) throw new TypeError("Digest class is not declared where expected");
    const statics = digest.members
        .filter(
            (member) =>
                ts.isMethodDeclaration(member) &&
                member.modifiers?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
                ) === true
        )
        .map((member) => member.name.getText(source));
    if (statics.length !== 1 || statics[0] !== "sha256") {
        throw new TypeError(
            `Digest declares hashers this gate does not walk: ${statics.join(", ")}`
        );
    }
}

function parseArguments(args) {
    let stage = "building";
    let selectedArtifactRoot = artifactRoot;
    let packageRoot = process.cwd();
    let register;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--stage") stage = required(args, ++index, argument);
        else if (argument === "--artifact-root")
            selectedArtifactRoot = resolve(required(args, ++index, argument));
        else if (argument === "--package-root")
            packageRoot = resolve(required(args, ++index, argument));
        else if (argument === "--register") register = resolve(required(args, ++index, argument));
        else throw new TypeError(`Unknown digest-derivations argument ${argument}`);
    }
    if (stage !== "building" && stage !== "final") throw new TypeError(`Unknown stage ${stage}`);
    return {
        stage,
        artifactRoot: selectedArtifactRoot,
        packageRoot,
        register: register ?? resolve(selectedArtifactRoot, "quality/digest-derivations.json")
    };
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}
