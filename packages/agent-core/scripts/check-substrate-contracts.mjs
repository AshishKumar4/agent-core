import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isNonEmptyString, packageRoot, parseCanonicalJson } from "./quality/project.mjs";

/**
 * `formal/AgentCore/Substrate` states, for every substrate seam a kernel calls, the laws it
 * relies on and the premises those laws cannot state. `artifacts/substrate-contracts.json`
 * says which evidence discharges each premise. A citation is worth exactly as much as its
 * ability to fail, so this check exists to make it fail:
 *
 * - every premise the Lean discharge table names appears here, with the same channel, and
 *   nothing appears here that Lean does not name — the two files cannot drift apart in
 *   either direction;
 * - a premise discharged by a conformance atom names a row that exists in a fragment listed
 *   in `artifacts/conformance/index.json`, and the status recorded here is the status the
 *   fragment carries today;
 * - a `conformanceAtom` or `liveLane` premise cites a `verified` row, a `rowBelowVerified`
 *   premise cites one that is not verified, and a `liveLane` premise's selectors all come
 *   from the committed deployed-account lane. Promoting or demoting a row therefore breaks
 *   this check rather than silently changing what the Lean docstrings mean;
 * - every cited selector is a selector the cited row actually carries, so a scenario cannot
 *   be paraphrased into evidence;
 * - every `gap` premise says what is owed, and no gap quietly cites an atom as if it were
 *   discharged;
 * - every opcode wire name here is a wire name `Effect.lean` produces.
 *
 * What this check deliberately does not do is decide whether a premise is true. That is a
 * §13 conformance question and a live-lane question, and this file's whole purpose is to
 * keep the Lean claim and the ledger's answer pointing at each other.
 */

const conformanceRoot = resolve(packageRoot, "artifacts/conformance");
const artifactPath = resolve(packageRoot, "artifacts/substrate-contracts.json");
const channels = new Set([
    "conformanceAtom",
    "liveLane",
    "rowBelowVerified",
    "declaredNonClaim",
    "declaredAssumption",
    "gap"
]);
const atomChannels = new Set(["conformanceAtom", "liveLane", "rowBelowVerified"]);
const verifiedChannels = new Set(["conformanceAtom", "liveLane"]);
const owedChannels = new Set(["gap"]);

const failures = check();
for (const failure of failures) process.stderr.write(`check-substrate-contracts: ${failure}\n`);
if (failures.length > 0) {
    process.exitCode = 1;
} else {
    process.stdout.write("check-substrate-contracts: discharge map agrees with the ledger\n");
}

function check() {
    const artifact = parseCanonicalJson(readFileSync(artifactPath, "utf8"), "substrate-contracts");
    const rows = conformanceRows();
    const lean = leanDischarge(artifact);
    const wireNames = leanWireNames(artifact);
    return [
        ...checkPremises(artifact, rows, lean),
        ...checkSeams(artifact, wireNames),
        ...checkFindings(artifact)
    ];
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
                fragment,
                status: requirement.status,
                selectors: new Set(requirement.testSelectors)
            });
        }
    }
    return rows;
}

/**
 * The premise-to-channel table as Lean states it. Read from the source text rather than
 * from a build, because what has to agree is the citation: `| .premise => .channel` is one
 * line in `Premise.discharge` and one entry here, and a reader comparing them should be
 * comparing the same two strings.
 */
function leanDischarge(artifact) {
    const source = readFileSync(
        resolve(packageRoot, artifact.leanRoot, relativeLeanPath(artifact.dischargeSource)),
        "utf8"
    );
    const table = new Map();
    const pattern = /^\s*\|\s*\.([A-Za-z][A-Za-z0-9]*)\s*=>\s*\.([A-Za-z][A-Za-z0-9]*)\s*$/gmu;
    const body = source.slice(source.indexOf("def Premise.discharge"));
    const end = body.indexOf("def Premise.isGap");
    for (const match of (end === -1 ? body : body.slice(0, end)).matchAll(pattern)) {
        table.set(match[1], match[2]);
    }
    return table;
}

/** Every wire name `Opcode.wire` produces. */
function leanWireNames(artifact) {
    const source = readFileSync(
        resolve(packageRoot, artifact.leanRoot, relativeLeanPath(artifact.premiseSource)),
        "utf8"
    );
    const names = new Set();
    for (const match of source.matchAll(/"(host\.[a-z]+\.[a-z]+)"/gu)) names.add(match[1]);
    return names;
}

function relativeLeanPath(declared) {
    const prefix = "formal/";
    return declared.startsWith(prefix) ? declared.slice(prefix.length) : declared;
}

function checkPremises(artifact, rows, lean) {
    const failures = [];
    const seen = new Set();
    for (const premise of artifact.premises) {
        const name = premise.premise;
        if (seen.has(name)) failures.push(`premise ${name} appears twice`);
        seen.add(name);
        if (!channels.has(premise.channel)) {
            failures.push(`premise ${name} has unknown channel ${premise.channel}`);
            continue;
        }
        const leanChannel = lean.get(name);
        if (leanChannel === undefined) {
            failures.push(`premise ${name} is not in Lean's Premise.discharge table`);
        } else if (leanChannel !== premise.channel) {
            failures.push(`premise ${name} is ${premise.channel} here and ${leanChannel} in Lean`);
        }
        failures.push(...checkPremiseEvidence(premise, rows));
    }
    for (const [name, channel] of lean) {
        if (!seen.has(name)) {
            failures.push(`Lean names premise ${name} (${channel}) and this artifact does not`);
        }
    }
    return failures;
}

function checkPremiseEvidence(premise, rows) {
    const name = premise.premise;
    const failures = [];
    const atom = premise.atom;
    if (atomChannels.has(premise.channel) && atom === undefined) {
        failures.push(`premise ${name} is ${premise.channel} and names no atom`);
    }
    if (owedChannels.has(premise.channel) && !isNonEmptyString(premise.owed)) {
        failures.push(`premise ${name} is a gap and does not say what is owed`);
    }
    if (atom === undefined) return failures;
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
    if (verifiedChannels.has(premise.channel) && row.status !== "verified") {
        failures.push(`premise ${name} is ${premise.channel} but ${atom} is ${row.status}`);
    }
    if (premise.channel === "rowBelowVerified" && row.status === "verified") {
        failures.push(`premise ${name} is rowBelowVerified but ${atom} is verified`);
    }
    for (const selector of premise.selectors ?? []) {
        if (!row.selectors.has(selector)) {
            failures.push(`premise ${name} cites a selector ${atom} does not carry: ${selector}`);
        }
        if (premise.channel === "liveLane" && !selector.startsWith(liveLanePrefix())) {
            failures.push(`premise ${name} is liveLane but cites a local selector: ${selector}`);
        }
    }
    return failures;
}

function checkSeams(artifact, wireNames) {
    const failures = [];
    const claimed = new Set();
    const witnessSource = readFileSync(
        resolve(packageRoot, artifact.leanRoot, relativeLeanPath(artifact.witnessSource)),
        "utf8"
    );
    for (const seam of artifact.seams) {
        for (const wire of seam.opcodes) {
            if (!wireNames.has(wire)) {
                failures.push(`seam ${seam.seam} names ${wire}, which Opcode.wire does not`);
            }
            if (claimed.has(wire)) failures.push(`opcode ${wire} is claimed by two seams`);
            claimed.add(wire);
        }
        for (const entry of seam.lawEvidence) {
            if (
                !isNonEmptyString(entry.law) ||
                !isNonEmptyString(entry.verdict) ||
                !isNonEmptyString(entry.code)
            ) {
                failures.push(`seam ${seam.seam} has a law entry without law, verdict and code`);
            }
        }
        failures.push(...checkWitness(seam, witnessSource));
    }
    for (const wire of wireNames) {
        if (!claimed.has(wire)) failures.push(`opcode ${wire} is in Lean and in no seam here`);
    }
    return failures;
}

/**
 * A claimed satisfiability witness has to exist, and an owed one has to say what it owes.
 * A law set with no witness could be contradictory and every theorem resting on it vacuous,
 * so this is the one status that must not be improvable by editing prose.
 */
function checkWitness(seam, witnessSource) {
    const failures = [];
    if (seam.witness === "owed") {
        if (!isNonEmptyString(seam.owed)) {
            failures.push(`seam ${seam.seam} owes a witness and does not say what is missing`);
        }
        return failures;
    }
    if (!isNonEmptyString(seam.witness)) {
        failures.push(`seam ${seam.seam} records no witness status`);
        return failures;
    }
    const declaration = seam.witness.split(".").at(-1);
    if (!witnessSource.includes(`theorem ${declaration}`)) {
        failures.push(`seam ${seam.seam} claims witness ${seam.witness}, absent from Witness.lean`);
    }
    return failures;
}

function checkFindings(artifact) {
    const failures = [];
    const seen = new Set();
    for (const finding of artifact.findings) {
        if (seen.has(finding.id)) failures.push(`finding ${finding.id} appears twice`);
        seen.add(finding.id);
        if (!isNonEmptyString(finding.statement) || !isNonEmptyString(finding.code)) {
            failures.push(`finding ${finding.id} needs a statement and the code it is about`);
        }
    }
    return failures;
}

function liveLanePrefix() {
    return "cloudflare/test/live/";
}
