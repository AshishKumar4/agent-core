import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    assertArray,
    assertExactKeys,
    assertOneOf,
    assertString,
    assertUniqueIds,
    assertUniqueStrings,
    isNonEmptyString,
    packageRoot,
    parseCanonicalJson,
    repositoryRoot
} from "./quality/project.mjs";
import { adjunctPackages } from "./quality/workspaces.mjs";

/**
 * `artifacts/service-contracts.json` states, for every external service the runtime
 * speaks to across a trust boundary, the protocol it speaks: a closed operation
 * vocabulary, a closed reply vocabulary in which a service failure is a refused value
 * rather than a throw, the invariants the runtime relies on, and a refusal taxonomy that
 * maps every failure to a stable code. `artifacts/substrate-contracts.json` does the same
 * job for the substrate seams a kernel calls, and this file is its sibling: the services
 * there are platform seams reached through a binding, the services here are protocols
 * spoken to a peer.
 *
 * A citation is worth exactly as much as its ability to fail, so this check exists to
 * make it fail. Everything it compares is read from source rather than restated, because
 * what has to agree is the citation:
 *
 * - a service's operation, reply and refusal vocabularies are the frozen tuples and the
 *   union its own contract body declares, member for member and in the same order, so the
 *   artifact and the suite cannot drift apart in either direction;
 * - every reply vocabulary carries `refused` and `indeterminate`, which is the whole
 *   point of the model: a service failure is a value, and an undeclared throw is not
 *   dressed up as a refusal the service never gave;
 * - every taxonomy code is a member of the code union the row names, read from that
 *   union's own declaration, and every member of every accountable union is either mapped
 *   by some service or listed as outside the taxonomy with a reason — so no failure is
 *   unmapped and no mapping is invented;
 * - every cited adapter, mechanism and suite path exists, and every cited symbol appears
 *   in the file cited for it;
 * - every declared selector is carried by the suite body or runner it names, so a
 *   scenario cannot be paraphrased into evidence;
 * - a premise discharged by a conformance atom names a row an indexed fragment carries,
 *   with the status recorded here, exactly as the substrate check does; a premise
 *   discharged by a contract suite names a selector this artifact declares; a gap says
 *   what is owed;
 * - every service recorded as covered by citation names a seam `substrate-contracts.json`
 *   actually declares, so the "not restated here" list cannot outlive what it points at.
 *
 * What this check deliberately does not do is decide whether an invariant holds. That is
 * the contract suites' question and, where a suite cannot reach it, a premise's.
 */

const conformanceRoot = resolve(packageRoot, "artifacts/conformance");
const substrateArtifact = resolve(packageRoot, "artifacts/substrate-contracts.json");

const directions = ["inbound", "outbound", "bidirectional"];
const verdicts = [
    "honored",
    "honored-with-scope",
    "honored-by-configuration",
    "unverified",
    "untestable-at-this-seam",
    "unimplemented",
    // A claim the contract disproved. Without it a refuted invariant has to be filed as
    // "unverified", which reads as "nobody looked" — the opposite of what happened, and
    // the one misreading that would let a known-false claim sit in an artifact unread.
    "refuted"
];
const implementationKinds = ["reference", "adapter"];
const premiseKinds = ["safety", "progress"];
const channels = [
    "contractSuite",
    "conformanceAtom",
    "liveLane",
    "rowBelowVerified",
    "declaredNonClaim",
    "declaredAssumption",
    "gap"
];
const atomChannels = ["conformanceAtom", "liveLane", "rowBelowVerified"];
const verifiedChannels = ["conformanceAtom", "liveLane"];
const REQUIRED_REPLIES = Object.freeze(["refused", "indeterminate"]);
const SELECTOR_PATTERN = /^(?:[a-z][a-z0-9-]*\/)?test\/[^#]+\.test\.ts#./u;
/**
 * Which package a selector's lane prefix names, taken from the quality registry rather
 * than restated: `cloudflare/test/...` is a selector into the Cloudflare package because
 * that workspace's id is `cloudflare`, and an unprefixed selector is the kernel's. A
 * workspace renamed there stops resolving here, which is the point.
 */
const LANES = new Map([
    ["", "packages/agent-core"],
    ...adjunctPackages().map((workspace) => [workspace.id, workspace.directory])
]);

const options = parseArguments(process.argv.slice(2));
const failures = check(options.artifact);
if (failures.length > 0) {
    throw new TypeError(
        `check-service-contracts found ${failures.length} disagreement(s):\n${failures
            .map((failure) => `  ${failure}`)
            .join("\n")}`
    );
}
process.stdout.write(
    "check-service-contracts: every service protocol agrees with its source and its suite\n"
);

function check(artifactPath) {
    const artifact = parseCanonicalJson(readFileSync(artifactPath, "utf8"), "service-contracts");
    assertExactKeys(
        artifact,
        ["citedElsewhere", "codeUnions", "edition", "findings", "owner", "premises", "services"],
        "service-contracts.json"
    );
    if (artifact.edition !== "1.0.0") return ["service contract edition is unsupported"];
    assertArray(artifact.services, "services");
    assertArray(artifact.codeUnions, "codeUnions");
    assertArray(artifact.premises, "premises");
    assertArray(artifact.citedElsewhere, "citedElsewhere");
    assertArray(artifact.findings, "findings");
    assertUniqueIds(artifact.services, (service) => service.service, "services");
    assertUniqueIds(artifact.codeUnions, (union) => union.union, "codeUnions");
    assertUniqueIds(artifact.premises, (premise) => premise.premise, "premises");
    assertUniqueIds(artifact.findings, (finding) => finding.id, "findings");

    const unions = readCodeUnions(artifact);
    const mapped = new Map(artifact.codeUnions.map((union) => [union.union, new Set()]));
    const selectors = new Set();
    // Every suite body and runner in the artifact. A case title is written in the body
    // that declares it and the implementation name in the runner that passes it, so any
    // title citation anywhere in this artifact is checked against all of them.
    const suiteTexts = artifact.services
        .flatMap((service) => [
            service.suite?.body,
            ...(service.suite?.implementations ?? []).map((entry) => entry.runner)
        ])
        .map((path) => (isNonEmptyString(path) ? sourceText(path) : undefined))
        .filter((text) => text !== undefined);
    const failures = [];
    for (const service of artifact.services) {
        failures.push(...checkService(service, unions, mapped, selectors, suiteTexts));
    }
    failures.push(...checkUnionCompleteness(artifact, unions, mapped, suiteTexts));
    failures.push(...checkPremises(artifact, selectors));
    failures.push(...checkCitedElsewhere(artifact));
    failures.push(...checkFindings(artifact));
    return failures;
}

/**
 * Every accountable code union, read from its own declaration. A union is read from the
 * source text for the same reason the substrate check reads Lean's discharge table from
 * source: the thing that has to agree is the citation, and a reader comparing the artifact
 * to the code should be comparing the same two strings.
 */
function readCodeUnions(artifact) {
    const unions = new Map();
    for (const union of artifact.codeUnions) {
        assertExactKeys(
            union,
            ["outsideServiceTaxonomy", "selectors", "source", "statement", "union"],
            "codeUnions entry"
        );
        assertString(union.union, "codeUnions union");
        assertString(union.source, "codeUnions source");
        unions.set(union.union, unionMembers(union.source, union.union));
    }
    return unions;
}

/**
 * One exported declaration's own text: the header line plus every line indented under
 * it. A declaration cannot be sliced at the first `;` because an object type literal
 * spells `{ readonly kind: "answered"; readonly output: ContentRef }` and would end the
 * slice inside its first variant — which is exactly how a reader of this file would have
 * concluded that a five-case reply vocabulary had one case.
 */
function declarationText(source, header) {
    const text = sourceText(source);
    if (text === undefined) return undefined;
    const start = text.indexOf(header);
    if (start === -1) return undefined;
    const lines = text.slice(start).split("\n");
    const body = [lines[0]];
    for (const line of lines.slice(1)) {
        if (line.trim() !== "" && !/^\s/u.test(line)) break;
        body.push(line);
    }
    return body.join("\n");
}

/**
 * The string literals of one exported union declaration. `Extract<Parent, "a" | "b">` and
 * a plain `"a" | "b"` read the same way, which is what lets the Cloudflare operational
 * subset be an accountable union of its own.
 */
function unionMembers(source, name) {
    const body = declarationText(source, `export type ${name} =`);
    if (body === undefined) return undefined;
    return new Set([...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
}

/** The string literals of one exported frozen tuple, in the order the source lists them. */
function frozenTuple(source, name) {
    const text = sourceText(source);
    if (text === undefined) return undefined;
    const start = text.indexOf(`export const ${name} = Object.freeze([`);
    if (start === -1) return undefined;
    const end = text.indexOf("] as const)", start);
    if (end === -1) return undefined;
    return [...text.slice(start, end).matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/** The `kind` discriminants of one exported reply union, in source order. */
function replyKinds(source, name) {
    const body = declarationText(source, `export type ${name} =`);
    if (body === undefined) return undefined;
    return [...body.matchAll(/kind:\s*"([^"]+)"/gu)].map((match) => match[1]);
}

function sourceText(relative) {
    const path = resolve(repositoryRoot, relative);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function checkService(service, unions, mapped, selectors, suiteTexts) {
    const failures = [];
    assertExactKeys(
        service,
        [
            "adapters",
            "boundary",
            "direction",
            "failureSource",
            "invariants",
            "operationSource",
            "operations",
            "premises",
            "refusalSource",
            "refusals",
            "replies",
            "replySource",
            "service",
            "suite",
            "taxonomy",
            "transport"
        ],
        "services entry"
    );
    const name = assertString(service.service, "service");
    assertOneOf(service.direction, directions, `service ${name} direction`);
    for (const field of ["boundary", "transport"]) {
        if (!isNonEmptyString(service[field])) failures.push(`service ${name} states no ${field}`);
    }
    failures.push(...checkVocabularies(service, name));
    failures.push(...checkCitations(service, name));
    failures.push(...checkTaxonomy(service, name, unions, mapped));
    failures.push(...checkInvariants(service, name, suiteTexts));
    failures.push(...checkSuite(service, name, selectors, suiteTexts));
    return failures;
}

/**
 * The three vocabularies, against the tuples and the union the suite declares. Order is
 * compared as well as membership: the suite iterates its own tuple to prove the taxonomy
 * total, so an artifact listing the same codes in another order is describing a different
 * iteration than the one that ran.
 */
function checkVocabularies(service, name) {
    const failures = [];
    const declared = [
        { field: "operations", source: service.operationSource, read: frozenTuple },
        { field: "refusals", source: service.refusalSource, read: frozenTuple },
        { field: "replies", source: service.replySource, read: replyKinds }
    ];
    for (const { field, source, read } of declared) {
        assertArray(service[field], `service ${name} ${field}`);
        assertUniqueStrings(service[field], `service ${name} ${field}`);
        const [path, symbol] = splitCitation(source);
        if (symbol === undefined) {
            failures.push(`service ${name} ${field} names no path#symbol source`);
            continue;
        }
        const members = read(path, symbol);
        if (members === undefined) {
            failures.push(`service ${name} cites ${source} for its ${field}, which is not there`);
            continue;
        }
        const listed = service[field].join(", ");
        const actual = members.join(", ");
        if (listed !== actual) {
            failures.push(
                `service ${name} lists ${field} [${listed}] and ${symbol} declares [${actual}]`
            );
        }
    }
    for (const required of REQUIRED_REPLIES) {
        if (!service.replies.includes(required)) {
            failures.push(
                `service ${name} declares no ${required} reply, so a service failure is not a value`
            );
        }
    }
    return failures;
}

/** Every adapter citation resolves to a file that carries the symbol named for it. */
function checkCitations(service, name) {
    const failures = [];
    assertArray(service.adapters, `service ${name} adapters`);
    if (service.adapters.length === 0) {
        failures.push(`service ${name} cites no adapter and no absence`);
    }
    for (const adapter of service.adapters) {
        assertString(adapter, `service ${name} adapter`);
        if (adapter === "absent") continue;
        const [path, symbol] = splitCitation(adapter);
        const text = sourceText(path);
        if (text === undefined) {
            failures.push(`service ${name} cites adapter file ${path}, which does not exist`);
        } else if (symbol !== undefined && !text.includes(symbol)) {
            failures.push(`service ${name} cites adapter ${adapter}, absent from ${path}`);
        }
    }
    return failures;
}

function checkTaxonomy(service, name, unions, mapped) {
    const failures = [];
    assertArray(service.taxonomy, `service ${name} taxonomy`);
    const rows = new Map();
    const codes = new Set();
    for (const row of service.taxonomy) {
        assertExactKeys(
            row,
            ["code", "failure", "mechanism", "replies", "statement", "union"],
            "taxonomy row"
        );
        const failure = assertString(row.failure, `service ${name} taxonomy failure`);
        const code = assertString(row.code, `service ${name} taxonomy code`);
        const union = assertString(row.union, `service ${name} taxonomy union`);
        if (!isNonEmptyString(row.statement) || !isNonEmptyString(row.mechanism)) {
            failures.push(`service ${name} has a taxonomy row without a statement and a mechanism`);
        }
        // A code can be answerable as more than one reply — a policy refusal reached
        // before the request left is a different promise from the same refusal reached
        // after a redirect hop — so the row lists every kind it can arrive as, and every
        // one of them has to be a kind the service declares.
        assertUniqueStrings(row.replies, `service ${name} taxonomy ${failure} replies`);
        for (const reply of row.replies) {
            if (!service.replies.includes(reply)) {
                failures.push(
                    `service ${name} maps ${failure} to reply ${reply}, which it never declares`
                );
            }
        }
        const members = unions.get(union);
        if (members === undefined) {
            failures.push(
                `service ${name} maps ${failure} to code union ${union}, which is not declared`
            );
        } else if (!members.has(code)) {
            // The load-bearing direction: a code the artifact claims is stable but whose
            // own declaration does not carry it.
            failures.push(
                `service ${name} maps ${code}, which its declared code union does not carry`
            );
        } else {
            mapped.get(union).add(code);
            codes.add(code);
        }
        if (rows.has(failure)) failures.push(`service ${name} maps ${failure} twice`);
        rows.set(failure, row);
        failures.push(...checkMechanism(service, name, row.mechanism));
    }
    // A code can carry several mechanisms, so the taxonomy is keyed by the way of failing
    // rather than by the code: without that, "every code is reachable" is all the totality
    // case could claim, and "every declared way of failing reaches a code" — which is the
    // claim that actually closes the taxonomy — would be unstated.
    const [path, symbol] = splitCitation(service.failureSource);
    const declared = symbol === undefined ? undefined : frozenTuple(path, symbol);
    if (declared === undefined) {
        failures.push(`service ${name} cites ${service.failureSource} for its failures, absent`);
    } else {
        const listed = [...rows.keys()].join(", ");
        const actual = declared.join(", ");
        if (listed !== actual) {
            failures.push(
                `service ${name} maps failures [${listed}] and ${symbol} declares [${actual}]`
            );
        }
    }
    for (const code of service.refusals) {
        if (!codes.has(code)) {
            failures.push(
                `service ${name} refuses with ${code} and its taxonomy leaves it unmapped`
            );
        }
    }
    return failures;
}

/**
 * A mechanism's first token is the citation and the rest is prose, because a mechanism
 * that cannot say why in words is a line number pretending to be an explanation. The
 * citation is `path`, `path:lines` or `path#Symbol`, and a named symbol has to be one the
 * file actually spells — a symbol citation survives a refactor that shifts lines, which
 * is why it is the form this artifact prefers, and it is only worth preferring if it is
 * checked.
 */
function checkMechanism(service, name, mechanism) {
    const citation = String(mechanism)
        .split(/\s/u)[0]
        .replace(/[,.;]+$/u, "");
    const [addressed, symbol] = splitCitation(citation);
    const path = addressed.split(":")[0];
    const text = sourceText(path);
    if (text === undefined) {
        return [`service ${name} cites mechanism file ${path}, which does not exist`];
    }
    if (symbol === undefined) return [];
    // `Class.member` is checked part by part: the two are separate declarations in the
    // source and a member that moved to another class should not read as still cited.
    const missing = symbol.split(".").filter((part) => !text.includes(part));
    if (missing.length === 0) return [];
    return [`service ${name} cites mechanism ${citation}, absent from ${path}`];
}

function checkInvariants(service, name, suiteTexts) {
    const failures = [];
    assertArray(service.invariants, `service ${name} invariants`);
    if (service.invariants.length === 0) {
        failures.push(`service ${name} relies on no invariant, which no protocol does`);
    }
    for (const invariant of service.invariants) {
        assertExactKeys(
            invariant,
            ["code", "invariant", "scope", "selectors", "verdict"],
            `service ${name} invariant`
        );
        assertOneOf(invariant.verdict, verdicts, `service ${name} invariant verdict`);
        if (!isNonEmptyString(invariant.invariant) || !isNonEmptyString(invariant.code)) {
            failures.push(
                `service ${name} has an invariant without a name and the code it is about`
            );
            continue;
        }
        // A scoped or unmet verdict is a claim about what is missing, so it has to say
        // what. A bare "honored-with-scope" is the shape of a gap that reads as a pass.
        if (invariant.verdict !== "honored" && !isNonEmptyString(invariant.scope)) {
            failures.push(
                `service ${name} records invariant ${invariant.invariant} as ${invariant.verdict} without a scope`
            );
        }
        assertArray(invariant.selectors, `service ${name} invariant selectors`);
        // An invariant is either observed or argued. A row that cites no case and states
        // no scope is neither: it is a claim about the runtime with nothing behind it.
        if (invariant.selectors.length === 0 && !isNonEmptyString(invariant.scope)) {
            failures.push(
                `service ${name} states invariant ${invariant.invariant} with neither a case nor a scope`
            );
        }
        failures.push(...checkMechanism(service, name, invariant.code));
        failures.push(...checkTitleCitations(`service ${name}`, invariant.selectors, suiteTexts));
    }
    return failures;
}

/**
 * A selector has to be spelled by the code that produces it: the case title as a quoted
 * string literal, and the `describe` chain above it either as a literal or as the
 * template a runner's implementation name flows into.
 *
 * The quotes are what make this worth checking. A word-by-word comparison would accept a
 * paraphrase made of the same words, and an unquoted substring match would accept a title
 * that exists only in a comment describing a case nobody wrote — which is the shape a
 * fabricated citation takes. Whether the case then passed is the `tests` node's question,
 * and this node runs after it, so a cited case that went red has already reddened the run
 * before this check reads its title.
 */
function checkTitleCitations(owner, selectors, suiteTexts, runnerTexts = suiteTexts) {
    const failures = [];
    for (const selector of selectors) {
        const separator = selector.indexOf("#");
        const file = separator === -1 ? undefined : laneRelative(selector.slice(0, separator));
        const text = file === undefined ? undefined : sourceText(file);
        if (text === undefined) {
            failures.push(
                `${owner} cites selector ${selector} in no readable test lane: ${selector}`
            );
            continue;
        }
        const title = selector.slice(separator + 1);
        const texts = [text, ...suiteTexts];
        const cased = suffixes(title).find((candidate) =>
            texts.some((candidateText) => candidateText.includes(`"${candidate}"`))
        );
        if (cased === undefined) {
            failures.push(`${owner} cites a case no suite text spells: ${title}`);
            continue;
        }
        const head = title.slice(0, title.length - cased.length).trim();
        if (head === "" || texts.some((candidateText) => candidateText.includes(head))) continue;
        // A parameterised `describe`: `${implementation} <prose>`. The prose tail is
        // whichever suffix a suite text writes into its own template; whatever precedes it
        // is the implementation name the runner passes, and the runner has to spell it.
        const prose = suffixes(head).find((candidate) =>
            texts.some((candidateText) => candidateText.includes(candidate))
        );
        if (prose === undefined) {
            failures.push(`${owner} cites a describe title no suite text spells: ${head}`);
            continue;
        }
        const implementation = head.slice(0, head.length - prose.length).trim();
        if (!runnerTexts.some((candidateText) => candidateText.includes(`"${implementation}"`))) {
            failures.push(
                `${owner} cites implementation ${JSON.stringify(implementation)}, which no runner passes`
            );
        }
    }
    return failures;
}

function checkSuite(service, name, selectors, suiteTexts) {
    const failures = [];
    const suite = service.suite;
    assertExactKeys(suite, ["body", "implementations", "selectors"], `service ${name} suite`);
    const body = sourceText(assertString(suite.body, `service ${name} suite body`));
    if (body === undefined) {
        failures.push(`service ${name} cites suite body ${suite.body}, which does not exist`);
    }
    assertArray(suite.implementations, `service ${name} suite implementations`);
    assertUniqueIds(
        suite.implementations,
        (implementation) => implementation.name,
        `service ${name} suite implementations`
    );
    const kinds = new Set();
    for (const implementation of suite.implementations) {
        assertExactKeys(
            implementation,
            ["kind", "lane", "name", "runner"],
            `service ${name} implementation`
        );
        assertOneOf(
            implementation.kind,
            implementationKinds,
            `service ${name} implementation kind`
        );
        kinds.add(implementation.kind);
        const runner = sourceText(implementation.runner);
        if (runner === undefined) {
            failures.push(
                `service ${name} cites runner ${implementation.runner}, which does not exist`
            );
        } else if (!runner.includes(`"${implementation.name}"`)) {
            failures.push(
                `service ${name} names implementation ${JSON.stringify(implementation.name)}, which ${implementation.runner} does not pass`
            );
        }
    }
    if (!kinds.has("reference")) {
        failures.push(`service ${name} runs its contract against no reference implementation`);
    }
    // A service whose adapter is absent has nothing else to run the contract against, and
    // says so in its adapter list; every other service owes a run against the real one,
    // because a contract only a reference satisfies certifies nothing that ships.
    if (!kinds.has("adapter") && !service.adapters.includes("absent")) {
        failures.push(`service ${name} runs its contract against no real adapter`);
    }
    assertArray(suite.selectors, `service ${name} suite selectors`);
    assertUniqueStrings(suite.selectors, `service ${name} suite selectors`);
    if (suite.selectors.length === 0) {
        failures.push(`service ${name} declares a contract suite and cites no case it runs`);
    }
    const runnerTexts = suite.implementations
        .map((implementation) => sourceText(implementation.runner))
        .filter((text) => text !== undefined);
    const shaped = [];
    for (const selector of suite.selectors) {
        selectors.add(selector);
        if (!SELECTOR_PATTERN.test(selector)) {
            failures.push(`service ${name} cites a malformed selector: ${selector}`);
            continue;
        }
        // One shape for every service, so a reader comparing two contracts is comparing
        // the same thing and the implementation name is always the leading fragment.
        if (!selector.includes(" service contract ")) {
            failures.push(
                `service ${name} cites a selector outside the contract shape ` +
                    `"<implementation> <service> service contract <case>": ${selector}`
            );
            continue;
        }
        shaped.push(selector);
    }
    failures.push(...checkTitleCitations(`service ${name}`, shaped, suiteTexts, runnerTexts));
    // An implementation is only running the contract if some case ran under its name.
    // Without this, a listed implementation is a claim with nothing behind it: every
    // selector could belong to one of them and the artifact would still read as two.
    for (const implementation of suite.implementations) {
        const under = `#${implementation.name} `;
        if (!suite.selectors.some((selector) => selector.includes(under))) {
            failures.push(
                `service ${name} lists implementation ${JSON.stringify(implementation.name)} and cites no case that ran under it`
            );
        }
    }
    return failures;
}

/** Every suffix of a title, longest first, at word boundaries. */
function suffixes(title) {
    const words = title.split(" ");
    return words.map((_word, index) => words.slice(index).join(" ")).filter((part) => part !== "");
}

/** A selector's path, resolved through the lane prefix the quality registry declares. */
function laneRelative(path) {
    const lane = path.startsWith("test/") ? "" : path.slice(0, path.indexOf("/"));
    const directory = LANES.get(lane);
    if (directory === undefined) return undefined;
    return `${directory}/${lane === "" ? path : path.slice(lane.length + 1)}`;
}

/**
 * Both directions over every accountable union: a code no service maps has to say why it
 * is outside the taxonomy, and a code listed as outside must not also be mapped. This is
 * what "the taxonomy is complete with no unmapped failure" means as a check rather than
 * as a claim.
 */
function checkUnionCompleteness(artifact, unions, mapped, suiteTexts) {
    const failures = [];
    for (const union of artifact.codeUnions) {
        const members = unions.get(union.union);
        if (members === undefined) {
            failures.push(`code union ${union.union} is not declared in ${union.source}`);
            continue;
        }
        if (!isNonEmptyString(union.statement)) {
            failures.push(`code union ${union.union} states no reason for being accountable`);
        }
        assertArray(union.outsideServiceTaxonomy, `${union.union} outsideServiceTaxonomy`);
        const excused = new Map();
        for (const entry of union.outsideServiceTaxonomy) {
            assertExactKeys(
                entry,
                ["code", "reason"],
                `${union.union} outsideServiceTaxonomy entry`
            );
            if (!members.has(entry.code)) {
                failures.push(
                    `code union ${union.union} excuses ${entry.code}, which it does not carry`
                );
            }
            if (!isNonEmptyString(entry.reason)) {
                failures.push(`code union ${union.union} excuses ${entry.code} with no reason`);
            }
            excused.set(entry.code, entry.reason);
        }
        const claimed = mapped.get(union.union);
        for (const code of [...members].sort()) {
            if (claimed.has(code) && excused.has(code)) {
                failures.push(
                    `code ${code} is both mapped by a service and excused from ${union.union}`
                );
            }
            if (!claimed.has(code) && !excused.has(code)) {
                failures.push(
                    `code union ${union.union} carries ${code} and no service taxonomy maps it`
                );
            }
        }
        // The partition this entry states is itself a claim a test can pin, so the entry
        // cites the case that pins it.
        assertUniqueStrings(union.selectors, `${union.union} selectors`);
        if (union.selectors.length === 0) {
            failures.push(`code union ${union.union} states a partition no case pins`);
        }
        failures.push(
            ...checkTitleCitations(`code union ${union.union}`, union.selectors, suiteTexts)
        );
    }
    return failures;
}

function checkPremises(artifact, selectors) {
    const failures = [];
    const rows = conformanceRows();
    const named = new Set(artifact.premises.map((premise) => premise.premise));
    for (const service of artifact.services) {
        assertArray(service.premises, `service ${service.service} premises`);
        for (const premise of service.premises) {
            if (!named.has(premise)) {
                failures.push(
                    `service ${service.service} rests on premise ${premise}, which is not declared`
                );
            }
        }
    }
    const claimed = new Set(artifact.services.flatMap((service) => service.premises));
    for (const premise of artifact.premises) {
        // Every field, every premise, with `null` where a channel does not use one. An
        // omitted key reads as an absent obligation; an explicit null reads as a stated
        // one, and only the second can be checked.
        assertExactKeys(
            premise,
            [
                "atom",
                "atomStatus",
                "channel",
                "declaration",
                "kind",
                "owed",
                "premise",
                "selectors"
            ],
            "premises entry"
        );
        const name = assertString(premise.premise, "premise");
        assertOneOf(premise.kind, premiseKinds, `premise ${name} kind`);
        assertOneOf(premise.channel, channels, `premise ${name} channel`);
        if (!claimed.has(name)) {
            failures.push(`premise ${name} is declared and no service rests on it`);
        }
        if (premise.channel === "gap" && !isNonEmptyString(premise.owed)) {
            failures.push(`premise ${name} is a gap and does not say what is owed`);
        }
        if (
            (premise.channel === "declaredNonClaim" || premise.channel === "declaredAssumption") &&
            !isNonEmptyString(premise.declaration)
        ) {
            failures.push(`premise ${name} is ${premise.channel} and cites no declaration`);
        }
        if (premise.channel === "contractSuite") {
            failures.push(...checkSuitePremise(premise, name, selectors));
            continue;
        }
        if (atomChannels.includes(premise.channel)) {
            failures.push(...checkAtomPremise(premise, name, rows));
        }
    }
    return failures;
}

function checkSuitePremise(premise, name, selectors) {
    const failures = [];
    const cited = premise.selectors ?? [];
    if (cited.length === 0) {
        failures.push(`premise ${name} is discharged by a contract suite and cites no case`);
    }
    for (const selector of cited) {
        if (!selectors.has(selector)) {
            failures.push(`premise ${name} cites ${selector}, which no service suite declares`);
        }
    }
    return failures;
}

/** The substrate check's own rule, applied to this artifact's atom citations. */
function checkAtomPremise(premise, name, rows) {
    const failures = [];
    const atom = premise.atom;
    if (!isNonEmptyString(atom)) {
        failures.push(`premise ${name} is ${premise.channel} and names no atom`);
        return failures;
    }
    const row = rows.get(atom);
    if (row === undefined) {
        failures.push(`premise ${name} cites ${atom}, which no indexed fragment carries`);
        return failures;
    }
    if (premise.atomStatus !== row.status) {
        failures.push(
            `premise ${name} records ${atom} as ${premise.atomStatus}; the ledger says ${row.status}`
        );
    }
    if (verifiedChannels.includes(premise.channel) && row.status !== "verified") {
        failures.push(`premise ${name} is ${premise.channel} but ${atom} is ${row.status}`);
    }
    if (premise.channel === "rowBelowVerified" && row.status === "verified") {
        failures.push(`premise ${name} is rowBelowVerified but ${atom} is verified`);
    }
    for (const selector of premise.selectors ?? []) {
        if (!row.selectors.has(selector)) {
            failures.push(`premise ${name} cites a selector ${atom} does not carry: ${selector}`);
        }
    }
    return failures;
}

/** Every requirement row in every fragment the conformance index lists. */
function conformanceRows() {
    const index = parseCanonicalJson(
        readFileSync(resolve(conformanceRoot, "index.json"), "utf8"),
        "conformance index"
    );
    const rows = new Map();
    for (const fragment of index.fragments) {
        const parsed = parseCanonicalJson(
            readFileSync(resolve(conformanceRoot, fragment), "utf8"),
            fragment
        );
        for (const requirement of parsed.requirements) {
            rows.set(requirement.id, {
                status: requirement.status,
                selectors: new Set(requirement.testSelectors)
            });
        }
    }
    return rows;
}

/**
 * The services this artifact deliberately does not restate. Each one names a seam the
 * substrate contracts declare, so the two artifacts partition the boundary rather than
 * overlapping on it, and deleting or renaming a seam there breaks the citation here.
 */
function checkCitedElsewhere(artifact) {
    const failures = [];
    const substrate = parseCanonicalJson(
        readFileSync(substrateArtifact, "utf8"),
        "substrate-contracts"
    );
    const seams = new Set(substrate.seams.map((seam) => seam.seam));
    const premises = new Set(substrate.premises.map((premise) => premise.premise));
    for (const cited of artifact.citedElsewhere) {
        assertExactKeys(
            cited,
            ["coveredBy", "premises", "seam", "service", "statement"],
            "citedElsewhere entry"
        );
        const name = assertString(cited.service, "citedElsewhere service");
        if (!isNonEmptyString(cited.statement)) {
            failures.push(
                `cited service ${name} states no reason for being cited rather than restated`
            );
        }
        if (cited.seam !== null && !seams.has(cited.seam)) {
            failures.push(
                `cited service ${name} names substrate seam ${cited.seam}, which does not exist`
            );
        }
        assertArray(cited.premises, `cited service ${name} premises`);
        for (const premise of cited.premises) {
            if (!premises.has(premise)) {
                failures.push(
                    `cited service ${name} cites substrate premise ${premise}, which does not exist`
                );
            }
        }
    }
    return failures;
}

function checkFindings(artifact) {
    const failures = [];
    const services = new Set(artifact.services.map((service) => service.service));
    for (const finding of artifact.findings) {
        assertExactKeys(
            finding,
            ["code", "id", "modelled", "service", "severity", "statement"],
            "findings entry"
        );
        const id = assertString(finding.id, "finding id");
        if (!isNonEmptyString(finding.statement) || !isNonEmptyString(finding.code)) {
            failures.push(`finding ${id} needs a statement and the code it is about`);
        }
        if (!services.has(finding.service)) {
            failures.push(
                `finding ${id} is about service ${finding.service}, which is not declared`
            );
        }
    }
    return failures;
}

function splitCitation(value) {
    const citation = String(value);
    const separator = citation.indexOf("#");
    return separator === -1
        ? [citation, undefined]
        : [citation.slice(0, separator), citation.slice(separator + 1)];
}

function parseArguments(args) {
    let artifact = resolve(packageRoot, "artifacts/service-contracts.json");
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument !== "--artifact") throw new TypeError(`Unknown argument ${argument}`);
        index += 1;
        const value = args[index];
        if (value === undefined) throw new TypeError("--artifact requires a value");
        artifact = resolve(value);
    }
    return { artifact };
}
