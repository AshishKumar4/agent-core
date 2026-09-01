import {
    assertArray,
    assertObject,
    assertString,
    compareCanonicalText,
    sha256,
    type JsonObject,
    type JsonValue
} from "./project.mjs";

/**
 * The records of the untrusted-LLM proof repair protocol.
 *
 * A generator that cannot be trusted proposes Lean and controlled-language text to close
 * an obligation. Nothing it writes is believed, and nothing it writes reaches the reviewed
 * tree, until the harness has decided the candidate itself. These records are what that
 * decision is made of and what it leaves behind:
 *
 * - a `ProofObligation` names one thing owed, identified by the digest of the rule unit it
 *   is owed for, so a rule whose text changes reopens its obligation rather than inheriting
 *   a closure proved against text nobody reads any more;
 * - a `ProofRepairCandidate` binds one baseline, one claimed obligation set, and one
 *   artifact set into a single identity, so evidence produced for one candidate cannot be
 *   presented for another and a doctored byte changes the name of the thing being judged;
 * - a `ProofRepairLedger` is the accepted state, and the protocol's only durable record. It
 *   grows and never shrinks: every closed obligation names the candidate that closed it and
 *   the artifacts that closed it, which is what makes a later candidate's regression
 *   detectable rather than a silent loss.
 *
 * A refused candidate writes nothing at all, so there is no refusal log to reconcile with
 * the accepted set, and no second place where the protocol's state could be read.
 */

const DIGEST = /^[0-9a-f]{64}$/u;
const ATOM = /^(?:C13|P11)-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;
const ANCHOR = /^[A-Za-z0-9._/-]+:[1-9][0-9]*$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const VERSION_PART = /^(?:0|[1-9][0-9]*)$/u;

/** The codec version of `ProofRepairLedger`, read exactly as §8.3 reads a record version:
 * an unknown major is refused, a newer minor is refused, and an older minor within the
 * major is tolerated. */
const LEDGER_MAJOR = 1;
const LEDGER_MINOR = 0;

const LEDGER_KIND = "proof.repair.ledger";

export const proofRepairLedgerVersion = `${LEDGER_MAJOR}.${LEDGER_MINOR}`;

/** The Lean suffix every candidate artifact carries, and the build-product directory no
 * artifact may ever name. Both guards exist at admission and at decode, so they live beside
 * the path shape rather than in one caller's head. */
export const PROOF_SOURCE_SUFFIX = ".lean";
export const PROOF_BUILD_DIRECTORY = ".lake";

/**
 * The one definition of which artifacts this protocol may ever name.
 *
 * A candidate is controlled-language Lean source under `SpecCnl/`, and nothing else. Three
 * kinds of path are refused outright: a build product, anything outside the corpus root, and
 * any module the harness itself relies on to produce the evidence that decides the candidate.
 * The last is the load-bearing half: the report that prints the ledger, the corpus that
 * defines the units, the sentences and bridges that say what each rule means, the grammar and
 * lexicon machinery that parse them, the adversarial and hostile corpora that assert what must
 * be refused, and the lakefile that chooses what a command runs are all inputs to the verdict.
 * A candidate that rewrites one of them is a candidate grading its own examination.
 *
 * What is deliberately *not* here is the discharge module. A repair has to be able to write a
 * proof, and `SpecCnl/Proofs.lean` is where discharges live; freezing it would leave a
 * protocol that can refuse everything and close nothing. It is safe to leave writable exactly
 * because the evidence about it is not: `#cnl_assert_shapes` requires each discharge to
 * inhabit its own reviewed proposition, `#print axioms` reports every axiom it leans on, and
 * both of those run out of modules on this list.
 *
 * The set is host-owned and fixed here because it is the same set for every candidate; a
 * per-candidate allowlist would be supplied by the very party it exists to constrain.
 */
export const PROOF_EVIDENCE_MODULES: ReadonlySet<string> = new Set([
    "lakefile.lean",
    "lakefile.toml",
    "lean-toolchain",
    "SpecCnl/Adversarial.lean",
    "SpecCnl/Bridge.lean",
    "SpecCnl/Category.lean",
    "SpecCnl/Corpus.lean",
    "SpecCnl/Divergence.lean",
    "SpecCnl/Elab.lean",
    "SpecCnl/Grammar.lean",
    "SpecCnl/Hostile.lean",
    "SpecCnl/Lexicon.lean",
    "SpecCnl/Parse.lean",
    "SpecCnl/Report.lean",
    "SpecCnl/Sentences.lean"
]);

/**
 * Whether one artifact path is one this protocol may accept.
 *
 * Called at candidate admission, where the candidate's own bytes are named, and at ledger
 * decode, where previously accepted bytes are named again, because a durable record is read
 * back with the same suspicion the fresh proposal got: a ledger that smuggles a `lakefile`
 * would hand the next candidate verifier-controlled text. A path is admitted only when it
 * names a corpus source file that is neither an evidence module nor a build product.
 */
export function acceptedProofArtifact(path: string, owner: string): string {
    assertArtifactPath(path, owner);
    if (path.split("/").includes(PROOF_BUILD_DIRECTORY)) {
        throw new TypeError(`${owner} names a build product: ${path}`);
    }
    if (!path.startsWith("SpecCnl/") || !path.endsWith(PROOF_SOURCE_SUFFIX)) {
        throw new TypeError(`${owner} is not controlled-language corpus source: ${path}`);
    }
    if (PROOF_EVIDENCE_MODULES.has(path)) {
        throw new TypeError(`${owner} produces the evidence that judges it: ${path}`);
    }
    return path;
}

/**
 * A canonical relative path, and the only path shape any part of this protocol accepts.
 *
 * Every segment is ordinary; there is no `.`, no `..`, no empty segment, no leading
 * separator, no drive letter, no backslash, and no Unicode form other than NFC. The
 * containment check that materializes a candidate is a second, independent guard, but a
 * path that cannot express an escape is the guard that cannot be forgotten.
 */
export function assertArtifactPath(path: string, owner: string): string {
    if (path.length === 0) throw new TypeError(`${owner} names no artifact path`);
    if (path !== path.normalize("NFC")) {
        throw new TypeError(`${owner} is not in Unicode normal form: ${JSON.stringify(path)}`);
    }
    for (const segment of path.split("/")) {
        if (!PATH_SEGMENT.test(segment) || segment === "." || segment === "..") {
            throw new TypeError(
                `${owner} is not a canonical relative path: ${JSON.stringify(path)}`
            );
        }
    }
    return path;
}

export function assertDigest(value: string, owner: string): string {
    if (!DIGEST.test(value)) throw new TypeError(`${owner} is not a sha256 digest: ${value}`);
    return value;
}

function assertOrderedUnique(values: readonly string[], owner: string): readonly string[] {
    if (new Set(values).size !== values.length) throw new TypeError(`${owner} repeats an entry`);
    return Object.freeze([...values].sort(compareCanonicalText));
}

function stringsAt(record: JsonObject, field: string, owner: string): readonly string[] {
    return assertArray(record[field], `${owner}.${field}`).map((entry, index) =>
        assertString(entry, `${owner}.${field}[${index}]`)
    );
}

/** Wire records are closed. Ignoring an extra model-controlled key creates a second meaning
 * for the same candidate or ledger record, so the decoder refuses it rather than discarding
 * it silently. */
function requireExactKeys(record: JsonObject, expected: readonly string[], owner: string): void {
    const actual = Object.keys(record).sort(compareCanonicalText);
    const allowed = [...expected].sort(compareCanonicalText);
    if (actual.join(" ") !== allowed.join(" ")) {
        throw new TypeError(`${owner} carries unexpected fields: ${actual.join(", ")}`);
    }
}

/**
 * One thing owed by the corpus: the SPEC rule unit, named by the digest of its exact prose,
 * and the conformance atoms that rule anchors.
 */
export class ProofObligation {
    public readonly unit: string;
    public readonly atoms: readonly string[];
    public readonly anchor: string;

    public constructor(unit: string, atoms: readonly string[], anchor: string) {
        this.unit = assertDigest(unit, "An obligation unit");
        if (atoms.length === 0) throw new TypeError("An obligation names no conformance atom");
        for (const atom of atoms) {
            if (!ATOM.test(atom)) throw new TypeError(`An obligation atom is not an atom: ${atom}`);
        }
        if (!ANCHOR.test(anchor)) {
            throw new TypeError(`An obligation anchor names no rule location: ${anchor}`);
        }
        this.atoms = assertOrderedUnique(atoms, "An obligation atom set");
        this.anchor = anchor;
        Object.freeze(this);
    }

    public equals(other: ProofObligation): boolean {
        return (
            this.unit === other.unit &&
            this.anchor === other.anchor &&
            this.atoms.length === other.atoms.length &&
            this.atoms.every((atom, index) => atom === other.atoms[index])
        );
    }

    /**
     * The one rendering every obligation-bearing feedback shares. The unit digest is part of
     * it because it is part of equality and the only rule-unit identity: two obligations can
     * carry the same atoms and anchor while binding different rule prose, and feedback that
     * renders them identically points a generator at the wrong requirement.
     */
    public describe(): string {
        return `${this.atoms.join(" ")} [${this.unit}] at ${this.anchor}`;
    }

    public toData(): JsonObject {
        return { anchor: this.anchor, atoms: this.atoms, unit: this.unit };
    }

    public static fromData(value: JsonValue | undefined, owner: string): ProofObligation {
        const record = assertObject(value, owner);
        requireExactKeys(record, ["anchor", "atoms", "unit"], owner);
        return new ProofObligation(
            assertString(record["unit"], `${owner}.unit`),
            stringsAt(record, "atoms", owner),
            assertString(record["anchor"], `${owner}.anchor`)
        );
    }
}

function obligationUnits(obligations: readonly ProofObligation[]): ReadonlySet<string> {
    return new Set(obligations.map((obligation) => obligation.unit));
}

function assertObligationSet(
    obligations: readonly ProofObligation[],
    owner: string
): readonly ProofObligation[] {
    if (obligations.length === 0) throw new TypeError(`${owner} is empty`);
    if (obligationUnits(obligations).size !== obligations.length) {
        throw new TypeError(`${owner} repeats a rule unit`);
    }
    return Object.freeze(
        [...obligations].sort((left, right) => compareCanonicalText(left.unit, right.unit))
    );
}

/**
 * The trusted obligation set for one repair attempt. The model may restate this set in its
 * candidate identity, but it cannot decide what the set is: the protocol compares the two
 * before candidate text reaches the isolation. Acceptance therefore means this host-owned set
 * has zero open obligations, not merely that a model omitted the obligations it did not close.
 */
export class ProofRepairObjective {
    public readonly obligations: readonly ProofObligation[];

    public constructor(obligations: readonly ProofObligation[]) {
        this.obligations = assertObligationSet(obligations, "A proof repair objective");
        Object.freeze(this);
    }

    public missing(candidate: ProofRepairCandidate): readonly ProofObligation[] {
        return this.obligations.filter(
            (required) => !candidate.obligations.some((claimed) => claimed.equals(required))
        );
    }

    public unexpected(candidate: ProofRepairCandidate): readonly ProofObligation[] {
        return candidate.obligations.filter(
            (claimed) => !this.obligations.some((required) => required.equals(claimed))
        );
    }
}

/**
 * The bytes an identity or an evidence binding is taken over: one path, and the digest of the
 * content at it. Proposed text, accepted text, and a verifier's measurement all bind bytes
 * this way, which is what lets one of them be compared against another at all.
 */
export interface ProofArtifactBytes {
    readonly path: string;
    readonly digest: string;
}

/** The text that can be overlaid into an isolated proof tree. Accepted content lives in the
 * versioned ledger; proposed content lives only in one candidate until acceptance. */
export interface ProofArtifactContent {
    readonly path: string;
    readonly text: string;
}

/**
 * One file a candidate proposes, with the untrusted text verbatim.
 *
 * The digest is derived here rather than accepted from the proposal, so the text and the
 * name of the text cannot disagree, and so a candidate identity taken over digests is a
 * statement about the bytes this process actually holds.
 */
export class ProposedArtifact implements ProofArtifactContent, ProofArtifactBytes {
    public readonly path: string;
    public readonly text: string;
    public readonly digest: string;

    public constructor(path: string, text: string) {
        this.path = acceptedProofArtifact(path, "A proposed artifact path");
        if (text.length === 0) throw new TypeError(`A proposed artifact carries no text: ${path}`);
        this.text = text;
        this.digest = sha256(text);
        Object.freeze(this);
    }

    /** The candidate identity binds the digest, not a second embedded copy of the text. */
    public identityData(): JsonObject {
        return { digest: this.digest, path: this.path };
    }

    /** The raw proposal carries only text and path. The harness computes its digest; a model
     * never supplies a hash the protocol might accidentally trust. */
    public toData(): JsonObject {
        return { path: this.path, text: this.text };
    }

    public static fromData(value: JsonValue | undefined, owner: string): ProposedArtifact {
        const record = assertObject(value, owner);
        requireExactKeys(record, ["path", "text"], owner);
        return new ProposedArtifact(
            assertString(record["path"], `${owner}.path`),
            assertString(record["text"], `${owner}.text`)
        );
    }
}

/**
 * An accepted artifact. Its text belongs in the ledger itself, not in a second directory or
 * log: the ledger is the single durable aggregate the store owns, and this is the exact text
 * the next isolated candidate overlays before it is judged.
 */
export class AcceptedArtifact implements ProofArtifactContent, ProofArtifactBytes {
    public readonly path: string;
    public readonly text: string;
    public readonly digest: string;

    public constructor(path: string, text: string) {
        this.path = acceptedProofArtifact(path, "An accepted artifact path");
        if (text.length === 0) throw new TypeError(`An accepted artifact carries no text: ${path}`);
        this.text = text;
        this.digest = sha256(text);
        Object.freeze(this);
    }

    public toData(): JsonObject {
        return { digest: this.digest, path: this.path, text: this.text };
    }

    public static fromData(value: JsonValue | undefined, owner: string): AcceptedArtifact {
        const record = assertObject(value, owner);
        requireExactKeys(record, ["digest", "path", "text"], owner);
        const artifact = new AcceptedArtifact(
            assertString(record["path"], `${owner}.path`),
            assertString(record["text"], `${owner}.text`)
        );
        if (assertString(record["digest"], `${owner}.digest`) !== artifact.digest) {
            throw new TypeError(`${owner}.digest does not describe its own text`);
        }
        return artifact;
    }
}

/** The verifier's measurement of bytes it read. It intentionally has no text: evidence only
 * needs to bind the bytes, while the accepted ledger is the one durable owner of content. */
export class ProofArtifactDigest implements ProofArtifactBytes {
    public readonly path: string;
    public readonly digest: string;

    public constructor(path: string, digest: string) {
        this.path = acceptedProofArtifact(path, "A measured artifact path");
        this.digest = assertDigest(digest, "A measured artifact digest");
        Object.freeze(this);
    }
}

/**
 * A closed obligation, with the candidate that closed it and the artifact set it was closed
 * by. The artifact set is the whole accepted set of that candidate rather than a narrower
 * attribution the protocol cannot derive: over-attributing means a later candidate that
 * rewrites any of those files must re-close this obligation, which is the safe direction.
 */
export class ClosedObligation {
    public readonly obligation: ProofObligation;
    public readonly candidate: string;
    public readonly artifacts: readonly string[];

    public constructor(
        obligation: ProofObligation,
        candidate: string,
        artifacts: readonly string[]
    ) {
        this.obligation = obligation;
        this.candidate = assertDigest(candidate, "A closed obligation candidate");
        if (artifacts.length === 0) {
            throw new TypeError("A closed obligation names no closing artifact");
        }
        for (const path of artifacts) acceptedProofArtifact(path, "A closing artifact path");
        this.artifacts = assertOrderedUnique(artifacts, "A closing artifact set");
        Object.freeze(this);
    }

    public toData(): JsonObject {
        return {
            artifacts: this.artifacts,
            candidate: this.candidate,
            obligation: this.obligation.toData()
        };
    }

    public static fromData(value: JsonValue | undefined, owner: string): ClosedObligation {
        const record = assertObject(value, owner);
        requireExactKeys(record, ["artifacts", "candidate", "obligation"], owner);
        return new ClosedObligation(
            ProofObligation.fromData(record["obligation"], `${owner}.obligation`),
            assertString(record["candidate"], `${owner}.candidate`),
            stringsAt(record, "artifacts", owner)
        );
    }
}

/**
 * One proposal, named by what it would change.
 *
 * The identity covers the baseline it was produced against, the obligations it claims, and
 * the digest of every artifact. That is the whole input to the decision, so two candidates
 * with the same identity are the same question, and any answer recorded for one identity
 * says nothing about another.
 */
export class ProofRepairCandidate {
    public readonly baseline: string;
    public readonly obligations: readonly ProofObligation[];
    public readonly artifacts: readonly ProposedArtifact[];
    public readonly identity: string;

    public constructor(
        baseline: string,
        obligations: readonly ProofObligation[],
        artifacts: readonly ProposedArtifact[]
    ) {
        this.baseline = assertDigest(baseline, "A candidate baseline");
        this.obligations = assertObligationSet(obligations, "A candidate obligation set");
        if (artifacts.length === 0) throw new TypeError("A candidate proposes no artifact");
        const paths = artifacts.map((artifact) => artifact.path);
        if (new Set(paths).size !== paths.length) {
            throw new TypeError("A candidate proposes one artifact path twice");
        }
        this.artifacts = Object.freeze(
            [...artifacts].sort((left, right) => compareCanonicalText(left.path, right.path))
        );
        this.identity = sha256(JSON.stringify(this.identityData()));
        Object.freeze(this);
    }

    /** The complete transport form. Unlike the identity payload, it carries source text so a
     * raw candidate can round-trip through `fromData` without a parallel proposal format. */
    public toData(): JsonObject {
        return {
            artifacts: this.artifacts.map((artifact) => artifact.toData()),
            baseline: this.baseline,
            obligations: this.obligations.map((obligation) => obligation.toData())
        };
    }

    /** The artifact paths this candidate proposes, in the candidate's own canonical order.
     * Ownership, isolation, attribution, and closure attribution all ask the candidate what
     * it names rather than each deriving the set from the artifact list again. */
    public paths(): readonly string[] {
        return this.artifacts.map((artifact) => artifact.path);
    }

    private identityData(): JsonObject {
        return {
            artifacts: this.artifacts.map((artifact) => artifact.identityData()),
            baseline: this.baseline,
            obligations: this.obligations.map((obligation) => obligation.toData())
        };
    }

    public static fromData(value: JsonValue | undefined, owner: string): ProofRepairCandidate {
        const record = assertObject(value, owner);
        requireExactKeys(record, ["artifacts", "baseline", "obligations"], owner);
        return new ProofRepairCandidate(
            assertString(record["baseline"], `${owner}.baseline`),
            assertArray(record["obligations"], `${owner}.obligations`).map((entry, index) =>
                ProofObligation.fromData(entry, `${owner}.obligations[${index}]`)
            ),
            assertArray(record["artifacts"], `${owner}.artifacts`).map((entry, index) =>
                ProposedArtifact.fromData(entry, `${owner}.artifacts[${index}]`)
            )
        );
    }
}

/**
 * The accepted state: what is closed, by whom, and over which bytes.
 *
 * `digest` is the baseline a candidate binds itself to. Any acceptance moves it, so a
 * candidate produced against an earlier state is detectably stale rather than silently
 * applied to a tree it never saw.
 */
export class ProofRepairLedger {
    public readonly candidate: string | undefined;
    public readonly closed: readonly ClosedObligation[];
    public readonly artifacts: readonly AcceptedArtifact[];
    public readonly digest: string;

    public constructor(
        candidate: string | undefined,
        closed: readonly ClosedObligation[],
        artifacts: readonly AcceptedArtifact[]
    ) {
        if (candidate !== undefined) assertDigest(candidate, "A ledger candidate");
        const units = closed.map((entry) => entry.obligation.unit);
        if (new Set(units).size !== units.length) {
            throw new TypeError("A ledger closes one rule unit twice");
        }
        const paths = artifacts.map((artifact) => artifact.path);
        if (new Set(paths).size !== paths.length) {
            throw new TypeError("A ledger accepts one artifact path twice");
        }
        if (candidate === undefined && (closed.length !== 0 || artifacts.length !== 0)) {
            throw new TypeError("A genesis ledger cannot carry accepted state");
        }
        if (candidate !== undefined && (closed.length === 0 || artifacts.length === 0)) {
            throw new TypeError("An accepted ledger needs both closures and artifacts");
        }
        // A closure names the bytes it was closed by, so the ledger must actually carry them.
        // A decoded record whose closure points at an artifact the ledger does not accept is
        // a closure attributed to text this state cannot produce, which is exactly how a
        // doctored ledger would claim a proof over content nobody can inspect.
        for (const entry of closed) {
            for (const path of entry.artifacts) {
                if (paths.includes(path)) continue;
                throw new TypeError(
                    `A ledger closes ${entry.obligation.describe()} over ${path}, ` +
                        "which it does not accept"
                );
            }
        }
        this.candidate = candidate;
        this.closed = Object.freeze(
            [...closed].sort((left, right) =>
                compareCanonicalText(left.obligation.unit, right.obligation.unit)
            )
        );
        this.artifacts = Object.freeze(
            [...artifacts].sort((left, right) => compareCanonicalText(left.path, right.path))
        );
        this.digest = sha256(JSON.stringify(encodeLedger(this)));
        Object.freeze(this);
    }

    public static get genesis(): ProofRepairLedger {
        return genesisLedger;
    }

    public closedUnits(): ReadonlySet<string> {
        return new Set(this.closed.map((entry) => entry.obligation.unit));
    }

    public obligations(): readonly ProofObligation[] {
        return this.closed.map((entry) => entry.obligation);
    }

    /**
     * The closed obligations a run no longer proves exactly. A matching unit digest alone is
     * insufficient evidence: the atom and anchor are part of the obligation this ledger
     * recorded, so a report that substitutes either has regressed it rather than preserved it.
     */
    public regressed(proved: readonly ProofObligation[]): readonly ClosedObligation[] {
        return this.closed.filter(
            (entry) => !proved.some((obligation) => obligation.equals(entry.obligation))
        );
    }

    /** The accepted artifacts a candidate would replace with different bytes. Rewriting one is
     * a repair, and a repair is progress even when it closes nothing new. */
    public rewritten(artifacts: readonly ProposedArtifact[]): readonly AcceptedArtifact[] {
        return this.artifacts.filter((accepted) =>
            artifacts.some(
                (artifact) => artifact.path === accepted.path && artifact.digest !== accepted.digest
            )
        );
    }

    /**
     * The accepted state after one candidate. Monotone by construction and asserted so: a
     * unit this ledger closes is still closed afterwards, whether the candidate re-proved it
     * or left it alone.
     */
    public accept(
        candidate: ProofRepairCandidate,
        closed: readonly ProofObligation[]
    ): ProofRepairLedger {
        const entries = new Map(this.closed.map((entry) => [entry.obligation.unit, entry]));
        for (const obligation of closed) {
            entries.set(
                obligation.unit,
                new ClosedObligation(obligation, candidate.identity, candidate.paths())
            );
        }
        const artifacts = new Map(this.artifacts.map((artifact) => [artifact.path, artifact]));
        for (const artifact of candidate.artifacts) {
            artifacts.set(artifact.path, new AcceptedArtifact(artifact.path, artifact.text));
        }
        const next = new ProofRepairLedger(
            candidate.identity,
            [...entries.values()],
            [...artifacts.values()]
        );
        const advanced = next.closedUnits();
        for (const unit of this.closedUnits()) {
            if (!advanced.has(unit)) {
                throw new TypeError(`Accepting ${candidate.identity} would drop closed ${unit}`);
            }
        }
        return next;
    }
}

const genesisLedger = new ProofRepairLedger(undefined, [], []);

function encodeLedger(ledger: ProofRepairLedger): JsonObject {
    const artifacts = ledger.artifacts.map((artifact) => artifact.toData());
    const closed = ledger.closed.map((entry) => entry.toData());
    if (ledger.candidate === undefined) {
        return { artifacts, closed, kind: LEDGER_KIND, version: proofRepairLedgerVersion };
    }
    return {
        artifacts,
        candidate: ledger.candidate,
        closed,
        kind: LEDGER_KIND,
        version: proofRepairLedgerVersion
    };
}

/**
 * The ledger's one codec (§8.3). Encoding is canonical — keys sorted, entries ordered by
 * their own identity — because the encoded bytes are what the baseline digest is taken over.
 */
export class ProofRepairLedgerCodec {
    public static encode(ledger: ProofRepairLedger): JsonObject {
        return encodeLedger(ledger);
    }

    public static decode(value: JsonValue | undefined, owner: string): ProofRepairLedger {
        const record = assertObject(value, owner);
        if (assertString(record["kind"], `${owner}.kind`) !== LEDGER_KIND) {
            throw new TypeError(`${owner}.kind is not ${LEDGER_KIND}`);
        }
        assertLedgerVersion(assertString(record["version"], `${owner}.version`), owner);
        const candidate = record["candidate"];
        const expected =
            candidate === undefined
                ? ["artifacts", "closed", "kind", "version"]
                : ["artifacts", "candidate", "closed", "kind", "version"];
        requireExactKeys(record, expected, owner);
        return new ProofRepairLedger(
            candidate === undefined ? undefined : assertString(candidate, `${owner}.candidate`),
            assertArray(record["closed"], `${owner}.closed`).map((entry, index) =>
                ClosedObligation.fromData(entry, `${owner}.closed[${index}]`)
            ),
            assertArray(record["artifacts"], `${owner}.artifacts`).map((entry, index) =>
                AcceptedArtifact.fromData(entry, `${owner}.artifacts[${index}]`)
            )
        );
    }
}

function assertLedgerVersion(declared: string, owner: string): void {
    const parts = declared.split(".");
    const major = parts[0];
    const minor = parts[1];
    if (
        parts.length !== 2 ||
        major === undefined ||
        minor === undefined ||
        !VERSION_PART.test(major) ||
        !VERSION_PART.test(minor)
    ) {
        throw new TypeError(`${owner}.version is not a record version: ${declared}`);
    }
    if (Number.parseInt(major, 10) !== LEDGER_MAJOR) {
        throw new TypeError(`${owner}.version declares unknown major ${major}`);
    }
    if (Number.parseInt(minor, 10) > LEDGER_MINOR) {
        throw new TypeError(`${owner}.version declares newer minor ${minor}`);
    }
}
