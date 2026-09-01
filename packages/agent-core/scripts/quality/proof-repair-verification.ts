import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
    assertArray,
    assertObject,
    assertString,
    compareCanonicalText,
    parseCanonicalJson,
    sha256,
    type JsonObject,
    type JsonValue
} from "./project.mjs";
import {
    assertDigest,
    PROOF_EVIDENCE_MODULES,
    ProofArtifactDigest,
    ProofObligation,
    type ProofRepairCandidate
} from "./proof-repair-record.js";
import {
    assertProofDeclaration,
    ProofArtifactSpan,
    ProofFinding,
    ProofRepairLocus,
    ProofRepairRefusal,
    type ProofArtifactOwners
} from "./proof-repair-refusal.js";

/**
 * The authority to accept one proof repair.
 *
 * There is no object for it. Every earlier shape had one — a capability a report carried, a
 * capability a caller could hold — and each of those is something reflectable off an exported
 * value: a field to read, a prototype to clone, a constructor to reach. Authority here is a
 * row in a module-local map keyed by the exact report instance this module built, holding the
 * frozen verdict and one mutable flag. A caller can hold the report; it cannot hold, copy or
 * re-present the authority, because the authority is not in the report.
 *
 * `reportGrant` closes the other half: the report constructor demands it, so no caller can
 * build a report at all, and therefore no caller can put a row in the map.
 */
const reportGrant = Symbol("proof.repair.report");

/**
 * Verifying one isolated candidate, and reading Lean's answer.
 *
 * The generator never supplies the verdict. It supplies text; the harness elaborates that
 * text inside the candidate's own isolation and reads the kernel's report. Everything below
 * is therefore about turning one Lean run into *facts*, and nothing below applies policy:
 * which axioms are reviewed, which obligations were owed, and whether the run is enough to
 * accept are decisions the protocol makes over these facts.
 *
 * The classification of a diagnostic is grounded in the messages the controlled-language
 * corpus and Lean actually emit, not in guesses about wording:
 *
 * - `refused: '<sentence>' has N readings: <a> | <b>` — `SpecCnl.Parse.compile`, so a
 *   sentence with more than one reading is an **intent ambiguity** and the two rendered
 *   readings are its minimal counterexample;
 * - `controlled-language declaration shapes refused: <key>: <name> has type <a>, not <b>` —
 *   `#cnl_assert_shapes`, so a declaration that elaborated with a different type than the
 *   bridge claims is a **model** defect, named by declaration;
 * - every other Lean error, including an unsolved goal and every other `refused:` reason, is
 *   a **compile** defect at an exact span. An error nobody classified stays a compile defect
 *   rather than becoming a pass.
 *
 * Both commands are read, and the two print the same message differently. Lean's own driver
 * writes `<file>:<line>:<col>: error[(<kind>)]: <message>` and prints an information message
 * with no position at all, which is why the ledger line and the axiom designations are read
 * as bare lines. Lake re-serializes the same message as `error: <file>:<line>:<col>:
 * <message>` with the kind dropped and the level moved to the front, and adds its own
 * `<level>: ` and progress lines around it. A reader that knew only one of the two forms
 * would report a candidate that does not elaborate as a run that reached no verdict, because
 * every compile diagnostic arrives through `lake build`.
 *
 * A declaration that elaborated but is not a proof is not visible in the diagnostics at all;
 * it is visible in `#print axioms`, which is why the axiom designations are reported as facts
 * and judged by the protocol.
 */

/** Lean's own driver: position first, optional error kind in parentheses. */
const DIAGNOSTIC =
    /^([^:\s][^:]*):(\d+):(\d+)(?:-\d+:\d+)?: (error|warning|information)(?:\([^)]*\))?: ?(.*)$/u;

/** Lake's log entry for the same message: level first, position inside the message. */
const LAKE_DIAGNOSTIC =
    /^(error|warning|info|trace): ([^:\s][^:]*):(\d+):(\d+)(?:-\d+:\d+)?: ?(.*)$/u;

/**
 * A line that starts something other than a message continuation.
 *
 * Two producers write lines of their own between Lean's messages. Lake writes another log
 * entry, a build progress line, or its failure summary. The report itself writes the axiom
 * designations and the ledger line as information messages, which Lean's driver prints with
 * no position at all. Both halves are needed: without the lake half a diagnostic absorbs the
 * build summary, and without the report half it absorbs the evidence the protocol judges.
 */
const CONTINUATION_BOUNDARY =
    /^(?:(?:error|warning|info|trace): |[\u2714\u2716\u2139\u26a0\u23f5] |Some |cnl-ledger |'[A-Za-z_][A-Za-z0-9_.]*' (?:depends on axioms: \[|does not depend on any axioms$))/u;

const AMBIGUOUS = /^refused: '(.+)' has (\d+) readings: (.+)$/su;
const SHAPES = /declaration shapes refused: (.+)$/su;
const SHAPE_DECLARATION = /([A-Za-z_][A-Za-z0-9_.]*) has type /u;
const NO_AXIOMS = /^'([A-Za-z_][A-Za-z0-9_.]*)' does not depend on any axioms$/u;
const AXIOM_LIST = /^'([A-Za-z_][A-Za-z0-9_.]*)' depends on axioms: \[(.*)\]$/u;
const LEDGER_LINE = "cnl-ledger ";

/** The default wall-clock budget one Lean command gets before it is killed. */
const COMMAND_BUDGET_MS = 10 * 60_000;

/**
 * The containment this verifier provides, and the containment the host still owes.
 *
 * Named rather than assumed, because the difference decides what a repair loop may be fed.
 * What the harness enforces: candidate text is elaborated only inside a disposable directory
 * outside the repository, with a scrubbed environment, under a wall-clock kill that takes the
 * whole process tree, and its bytes are re-measured after the run. What the harness does not
 * enforce: the child runs as the same operating-system user, so filesystem permissions are
 * not a boundary against it. Until the host supplies the sandbox named here, this protocol
 * may be pointed at model output that is merely untrusted, not at output that is adversarial.
 */
export const proofVerifierSandboxPremise = Object.freeze({
    name: "same-user-process-isolation",
    enforced: Object.freeze([
        "candidate text is elaborated only inside a disposable directory outside the repository",
        "the child environment is scrubbed to HOME, PATH, LANG, LC_ALL and TMPDIR",
        "a wall-clock budget, enforced by timeout(1), kills the whole process group",
        "candidate bytes are re-measured after both commands return"
    ]),
    requires: "timeout(1) on PATH, which supervises each command in its own process group",
    hostOwes:
        "run the repair loop as a user whose filesystem and network reach stops at the " +
        "isolation, because a process with the harness user's uid can reach the reviewed " +
        "tree and the ledger no matter what this module does"
});

export type ProofDiagnosticSeverity = "error" | "warning" | "information";

/** One Lean diagnostic, with the artifact path exactly as Lean printed it. */
export class ProofDiagnostic {
    public readonly artifact: string;
    public readonly span: ProofArtifactSpan;
    public readonly severity: ProofDiagnosticSeverity;
    public readonly message: string;

    public constructor(
        artifact: string,
        span: ProofArtifactSpan,
        severity: ProofDiagnosticSeverity,
        message: string
    ) {
        if (artifact.length === 0) throw new TypeError("A diagnostic names no artifact");
        this.artifact = artifact;
        this.span = span;
        this.severity = severity;
        this.message = message;
        Object.freeze(this);
    }
}

/** One declaration and the exact kernel axioms the report said it depends on. */
export class DeclarationAxioms {
    public readonly declaration: string;
    public readonly axioms: readonly string[];

    public constructor(declaration: string, axioms: readonly string[]) {
        this.declaration = assertProofDeclaration(declaration, "A designation declaration");
        if (new Set(axioms).size !== axioms.length) {
            throw new TypeError(`${declaration} lists one axiom twice`);
        }
        for (const axiom of axioms) assertProofDeclaration(axiom, `${declaration} axiom`);
        this.axioms = Object.freeze([...axioms].sort(compareCanonicalText));
        Object.freeze(this);
    }
}

/** What the verifier is asked about: one candidate, and the isolation its text was written
 * into. The verifier reads only that directory, and never the reviewed tree. */
export interface ProofCandidateSubject {
    readonly candidate: ProofRepairCandidate;
    readonly root: string;
}

/**
 * The verdict one completed run reached: the only thing a decision may read, and a view with
 * no authority on it.
 *
 * A report object is a name for a run, not evidence about one. Reading fields off the object a
 * caller hands over decides nothing, because a `Proxy` can re-answer any method reached through
 * the prototype and a subclass can shadow anything not frozen. The decision therefore looks up
 * the row this module registered for that exact instance and reads the frozen snapshot in it.
 *
 * The view deliberately carries no `redeem`: spending authority is a module function over the
 * row, so there is nothing on any exported value that a caller could call twice, forward, or
 * hand to something else.
 */
export interface ProofVerdictView {
    readonly candidate: string;
    readonly artifacts: readonly ProofArtifactDigest[];
    readonly findings: readonly ProofFinding[];
    readonly closed: readonly ProofObligation[];
    readonly designations: readonly DeclarationAxioms[];

    /** Whether the run proved this exact obligation, including its rule anchor and atoms. */
    proves(obligation: ProofObligation): boolean;

    /** Whether this run is evidence about exactly the candidate and bytes it is presented
     * for. Nothing in it is read until this holds. */
    describes(candidate: ProofRepairCandidate): boolean;
}

/** The module-local implementation. Frozen, built from the verifier's own arguments, and
 * unreachable except through the row this module registers. */
class Verdict implements ProofVerdictView {
    public readonly candidate: string;
    public readonly artifacts: readonly ProofArtifactDigest[];
    public readonly findings: readonly ProofFinding[];
    public readonly closed: readonly ProofObligation[];
    public readonly designations: readonly DeclarationAxioms[];

    public constructor(
        candidate: string,
        artifacts: readonly ProofArtifactDigest[],
        findings: readonly ProofFinding[],
        closed: readonly ProofObligation[],
        designations: readonly DeclarationAxioms[]
    ) {
        this.candidate = candidate;
        this.artifacts = Object.freeze([...artifacts]);
        this.findings = Object.freeze([...findings]);
        this.closed = Object.freeze([...closed]);
        this.designations = Object.freeze([...designations]);
        Object.freeze(this);
    }

    public proves(obligation: ProofObligation): boolean {
        return this.closed.some((proved) => proved.equals(obligation));
    }

    public describes(candidate: ProofRepairCandidate): boolean {
        if (this.candidate !== candidate.identity) return false;
        if (this.artifacts.length !== candidate.artifacts.length) return false;
        return candidate.artifacts.every((artifact) =>
            this.artifacts.some(
                (read) => read.path === artifact.path && read.digest === artifact.digest
            )
        );
    }
}

/** One row: the frozen verdict, and whether its one acceptance has been spent. */
interface RegisteredVerdict {
    readonly verdict: Verdict;
    spent: boolean;
}

/** The runs this module completed, keyed by the exact report instance that names each one. */
const verdicts = new WeakMap<ProofVerificationReport, RegisteredVerdict>();

/** The verdict a report names, or nothing when this module never produced it. Reading is not
 * spending: a caller may look, and looking authorizes nothing. */
export function proofVerdictOf(report: ProofVerificationReport): ProofVerdictView | undefined {
    return verdicts.get(report)?.verdict;
}

/**
 * Validates and spends one run's authority, returning the verdict the decision may read.
 *
 * This is the whole acceptance gate. A report this module never produced has no row and is
 * refused; a row already spent is refused, so one completed run cannot be replayed into two
 * acceptances; and the verdict handed back is the frozen snapshot rather than anything the
 * caller's object says about itself.
 */
export function redeemProofVerdict(report: ProofVerificationReport): ProofVerdictView {
    const registered = verdicts.get(report);
    if (registered === undefined) {
        throw new TypeError("A proof repair acceptance needs a verdict this verifier reached");
    }
    if (registered.spent) {
        throw new TypeError("A proof repair verdict was already redeemed");
    }
    registered.spent = true;
    return registered.verdict;
}

/**
 * One verifier run, bound to the candidate it ran for and to the exact bytes it read.
 *
 * Both bindings are what make substituted evidence detectable: a report naming another
 * candidate, or naming the right candidate over different digests, describes a question that
 * was not asked here, and the protocol treats it as no evidence at all.
 *
 * The constructor demands this module's own symbol, so a caller cannot build one: an assembled
 * report is not merely unauthorized, it is unconstructable. The public fields exist for
 * feedback and diagnostics; the verdict the decision reads is the row this constructor
 * registers, built from its arguments rather than from `this`.
 */
export class ProofVerificationReport {
    public readonly candidate: string;
    public readonly artifacts: readonly ProofArtifactDigest[];
    public readonly findings: readonly ProofFinding[];
    public readonly closed: readonly ProofObligation[];
    public readonly designations: readonly DeclarationAxioms[];

    public constructor(
        token: symbol,
        candidate: string,
        artifacts: readonly ProofArtifactDigest[],
        findings: readonly ProofFinding[],
        closed: readonly ProofObligation[],
        designations: readonly DeclarationAxioms[]
    ) {
        if (token !== reportGrant) {
            throw new TypeError("A verification report cannot be constructed by a caller");
        }
        const paths = artifacts.map((artifact) => artifact.path);
        if (new Set(paths).size !== paths.length) {
            throw new TypeError("A report reads one artifact path twice");
        }
        const units = closed.map((obligation) => obligation.unit);
        if (new Set(units).size !== units.length) {
            throw new TypeError("A report proves one rule unit twice");
        }
        const declarations = designations.map((designation) => designation.declaration);
        if (new Set(declarations).size !== declarations.length) {
            throw new TypeError("A report designates one declaration twice");
        }
        this.candidate = assertDigest(candidate, "A verification report candidate");
        this.artifacts = Object.freeze([...artifacts]);
        this.findings = Object.freeze([...findings]);
        this.closed = Object.freeze([...closed]);
        this.designations = Object.freeze([...designations]);
        Object.freeze(this);
        verdicts.set(this, {
            verdict: new Verdict(this.candidate, artifacts, findings, closed, designations),
            spent: false
        });
    }
}

export abstract class ProofCandidateVerification {
    /** The report, or the refusal that says why there is none. A verifier that cannot decide
     * returns an unattributed `runtime` refusal rather than an empty report, because an empty
     * report reads as "nothing was wrong". */
    public abstract verify(
        subject: ProofCandidateSubject
    ): ProofVerificationReport | ProofRepairRefusal;

    /**
     * Every declaration the reviewed corpus registers for the axiom report.
     *
     * The protocol requires this rather than reading a count off the report, because the
     * completeness of the designation set is exactly what an omitted `#print axioms` line
     * would hide. A verifier that could not name its audited set would be one that decides
     * for itself what "complete" means.
     */
    public abstract auditedNames(): readonly string[];
}

/**
 * The artifact a Lean declaration lives in, resolved against the candidate's own set by the
 * module convention: the longest prefix of the name that is one of its files. A declaration
 * no candidate artifact carries belongs to the base tree, and returns nothing rather than
 * being attributed to text this candidate did not write.
 */
export function leanArtifact(declaration: string, paths: readonly string[]): string | undefined {
    const parts = declaration.split(".");
    for (let end = parts.length; end > 0; end -= 1) {
        const module = `${parts.slice(0, end).join("/")}.lean`;
        if (paths.includes(module)) return module;
    }
    return undefined;
}

/** The source module that owns a controlled-language declaration when the declaration is
 * audited but the current candidate did not edit that module. A candidate can alter a shared
 * definition and make a proof in another module depend on an axiom, so policy must inspect
 * the whole audited designation set rather than only declarations in changed files. */
export function declarationArtifact(declaration: string): string | undefined {
    const parts = declaration.split(".");
    const namespace = parts[0];
    const module = parts[1];
    if (namespace !== "SpecCnl" || module === undefined) return undefined;
    return `${namespace}/${module}.lean`;
}

/** One command, kept whole so a refusal can name exactly what did not answer. */
export class ProofCommand {
    public readonly command: string;
    public readonly args: readonly string[];

    public constructor(command: string, args: readonly string[]) {
        if (command.length === 0) throw new TypeError("A command names no program");
        this.command = command;
        this.args = Object.freeze([...args]);
        Object.freeze(this);
    }

    public static parse(words: readonly string[]): ProofCommand {
        const program = words[0];
        if (program === undefined) throw new TypeError("A command is empty");
        return new ProofCommand(program, words.slice(1));
    }

    public render(): string {
        return [this.command, ...this.args].join(" ");
    }
}

export interface ProofCommandOutcome {
    readonly status: number | undefined;
    readonly output: string;
}

export abstract class ProofCommandRunner {
    public abstract run(command: ProofCommand, cwd: string): ProofCommandOutcome;
}

/** The supervisor that bounds one candidate run, and the codes it reports. `timeout` runs the
 * command in its own process group and signals that group when the budget expires, which is
 * how the whole tree dies rather than only the process this runner started. */
const COMMAND_SUPERVISOR = "timeout";
const SUPERVISOR_GRACE = "--kill-after=5s";
const SUPERVISOR_EXPIRED = 124;
const SUPERVISOR_KILLED = 137;

/**
 * The one place untrusted text is executed.
 *
 * Every property here is containment, not hygiene. The working directory is the disposable
 * isolation and nothing else is passed. The environment is scrubbed to what a toolchain
 * needs, so a candidate cannot read a host secret and print it into its own feedback. Output
 * is captured rather than inherited, because the output is the evidence.
 *
 * The budget is enforced by `timeout`, not by this process. That matters for the shape of the
 * failure: `lake` starts `lean` children, and a signal aimed at `lake` alone leaves them
 * elaborating candidate text after the harness has stopped waiting for an answer. `timeout`
 * places the command in its own process group and signals the group, so expiry kills the
 * tree; the harness then reports a run that reached no verdict, never a pass. Signalling a
 * process group from here instead would be aiming at a group this process is a member of.
 *
 * What this is not is a sandbox: see `proofVerifierSandboxPremise` for the boundary the host
 * still owes, stated as an obligation rather than left as an assumption.
 */
export class SpawnProofCommandRunner extends ProofCommandRunner {
    private readonly timeoutMs: number;

    public constructor(timeoutMs: number = COMMAND_BUDGET_MS) {
        super();
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
            throw new TypeError(`A command budget is not a duration: ${timeoutMs}`);
        }
        this.timeoutMs = timeoutMs;
        Object.freeze(this);
    }

    public run(command: ProofCommand, cwd: string): ProofCommandOutcome {
        const isolated = realpathSync(cwd);
        const budget = `${this.timeoutMs / 1000}s`;
        const outcome = spawnSync(
            COMMAND_SUPERVISOR,
            [SUPERVISOR_GRACE, budget, command.command, ...command.args],
            {
                cwd: isolated,
                encoding: "utf8",
                env: scrubbedEnvironment(isolated),
                killSignal: "SIGKILL",
                maxBuffer: 64 * 1024 * 1024,
                // A backstop only: the supervisor owns the budget, and this bounds the case
                // where the supervisor itself never returns.
                timeout: this.timeoutMs + 30_000
            }
        );
        if (outcome.error !== undefined) {
            return { status: undefined, output: outcome.error.message };
        }
        if (outcome.status === SUPERVISOR_EXPIRED || outcome.status === SUPERVISOR_KILLED) {
            return {
                status: undefined,
                output: `${command.render()} was killed after ${this.timeoutMs}ms`
            };
        }
        return {
            status: outcome.status === null ? undefined : outcome.status,
            output: [outcome.stdout, outcome.stderr].filter((part) => part.length > 0).join("\n")
        };
    }
}

/**
 * The environment a Lean toolchain needs, and nothing else the host happens to hold.
 *
 * `HOME` points at the isolation on purpose: a candidate that writes to its home directory
 * writes into scratch space that is deleted with the isolation. That repointing is exactly why
 * `ELAN_HOME` has to be explicit — `elan` resolves toolchains under `$ELAN_HOME`, falling back
 * to `$HOME/.elan`, so a repointed home is a toolchain the runner cannot find and every real
 * run would report a verdict it never reached. The host's own value wins when it is set;
 * otherwise the reviewed default location under the host's real home is named here rather than
 * inherited by accident.
 *
 * Everything else the host holds — credentials, tokens, proxies, editor state — is dropped,
 * because a candidate's own elaboration can print any of it into the feedback the harness
 * hands back.
 */
function scrubbedEnvironment(directory: string): NodeJS.ProcessEnv {
    return {
        ELAN_HOME: elanHome(),
        HOME: directory,
        LANG: "C",
        LC_ALL: "C",
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        TMPDIR: directory
    };
}

/** Where the toolchain lives, named explicitly so a repointed `HOME` cannot hide it. */
function elanHome(): string {
    const declared = process.env["ELAN_HOME"];
    if (declared !== undefined && declared.length > 0) return declared;
    const home = process.env["HOME"];
    return home === undefined || home.length === 0 ? "/root/.elan" : join(home, ".elan");
}

/** A diagnostic whose message is still being read: Lean prints a goal as the lines that
 * follow its header, so the message is complete only at the next header, at a line lake
 * itself wrote, or at the end of the output. */
interface OpenProofDiagnostic {
    readonly artifact: string;
    readonly span: ProofArtifactSpan;
    readonly severity: ProofDiagnosticSeverity;
    readonly lines: string[];
}

/**
 * Every Lean diagnostic in a run's output, in either of the two forms the two commands
 * print.
 *
 * A line that is not a header continues the message above it, because Lean prints a goal as
 * unindented lines under its header and an indentation rule would silently drop exactly the
 * part a repair needs. The continuation stops at a line lake or the report wrote itself, so
 * neither the build summary nor the evidence the protocol judges is absorbed into a
 * counterexample.
 */
export function parseProofDiagnostics(output: string): readonly ProofDiagnostic[] {
    const opened: OpenProofDiagnostic[] = [];
    let reading: OpenProofDiagnostic | undefined;
    for (const line of output.split(/\r?\n/u)) {
        const started = openDiagnostic(line);
        if (started !== undefined) {
            opened.push(started);
            reading = started;
            continue;
        }
        if (CONTINUATION_BOUNDARY.test(line)) {
            reading = undefined;
            continue;
        }
        reading?.lines.push(line);
    }
    return opened.map(
        (diagnostic) =>
            new ProofDiagnostic(
                diagnostic.artifact,
                diagnostic.span,
                diagnostic.severity,
                diagnostic.lines.join("\n").replace(/\s+$/u, "")
            )
    );
}

/** The diagnostic a line begins, or nothing when the line is not a header. */
function openDiagnostic(line: string): OpenProofDiagnostic | undefined {
    const direct = DIAGNOSTIC.exec(line);
    if (direct !== null) {
        const [, artifact, atLine, atColumn, severity, message] = direct;
        return positioned(artifact, atLine, atColumn, severity, message);
    }
    const wrapped = LAKE_DIAGNOSTIC.exec(line);
    if (wrapped !== null) {
        const [, severity, artifact, atLine, atColumn, message] = wrapped;
        return positioned(artifact, atLine, atColumn, severity, message);
    }
    return undefined;
}

function positioned(
    artifact: string | undefined,
    atLine: string | undefined,
    atColumn: string | undefined,
    severity: string | undefined,
    message: string | undefined
): OpenProofDiagnostic | undefined {
    if (
        artifact === undefined ||
        atLine === undefined ||
        atColumn === undefined ||
        severity === undefined ||
        message === undefined
    ) {
        return undefined;
    }
    return {
        artifact,
        span: new ProofArtifactSpan(Number.parseInt(atLine, 10), Number.parseInt(atColumn, 10)),
        severity: severityOf(severity),
        lines: [message]
    };
}

/** Lake calls the same severity `info` and adds `trace`; both are information here. */
function severityOf(severity: string): ProofDiagnosticSeverity {
    if (severity === "error" || severity === "warning") return severity;
    return "information";
}

/** Every axiom designation `#print axioms` printed, in either of its two forms. */
export function parseAxiomDesignations(output: string): readonly DeclarationAxioms[] {
    const designations: DeclarationAxioms[] = [];
    for (const raw of output.split(/\r?\n/u)) {
        const line = raw.trim();
        const plain = NO_AXIOMS.exec(line);
        if (plain !== null && plain[1] !== undefined) {
            designations.push(new DeclarationAxioms(plain[1], []));
            continue;
        }
        const listed = AXIOM_LIST.exec(line);
        if (listed !== null && listed[1] !== undefined && listed[2] !== undefined) {
            const axioms = listed[2]
                .split(",")
                .map((name) => name.trim())
                .filter((name) => name.length > 0);
            designations.push(new DeclarationAxioms(listed[1], axioms));
        }
    }
    return designations;
}

/** A Lean import, which is a module name and therefore a path once the corpus root is known. */
const IMPORT = /^import\s+([A-Za-z_][A-Za-z0-9_.]*)\s*$/u;

/**
 * The modules the audited run actually elaborates, walked from one frozen entry module.
 *
 * Only a frozen module's imports are followed. A writable module is included when something
 * frozen imports it, but its own import list is candidate-controlled: following it would let a
 * candidate declare its own unreachable module reachable, which is the property this walk
 * exists to decide. A module the walk names but the tree does not carry is simply not read —
 * the elaboration would fail on it, and that failure is a diagnostic, not this reader's
 * business.
 */
export function reachableProofModules(root: string, entry: string): ReadonlySet<string> {
    const reached = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
        const module = pending.pop();
        if (module === undefined || reached.has(module)) continue;
        reached.add(module);
        if (!PROOF_EVIDENCE_MODULES.has(module)) continue;
        for (const imported of importedProofModules(root, module)) pending.push(imported);
    }
    return reached;
}

/** The corpus modules one module imports, read from the isolated tree. */
function importedProofModules(root: string, module: string): readonly string[] {
    let source: string;
    try {
        source = readFileSync(join(root, module), "utf8");
    } catch {
        // A frozen module the tree does not carry imports nothing here; the elaboration will
        // report its absence itself.
        return [];
    }
    const imported: string[] = [];
    for (const line of source.split(/\r?\n/u)) {
        const match = IMPORT.exec(line.trim());
        const name = match?.[1];
        if (name === undefined || !name.startsWith("SpecCnl.")) continue;
        imported.push(`${name.split(".").join("/")}.lean`);
    }
    return imported;
}

/**
 * The constructions a candidate may not use, and the reason the list is a list of tokens.
 *
 * Two questions have to be separated. *Is this text sound?* is a kernel question, and the
 * kernel answers it: the axiom designations are exact over the audited names, so a discharge
 * that leans on anything the doctrine has not reviewed is refused with the axiom named. *Does
 * this text reach past the kernel?* is not a kernel question at all, because the constructions
 * that reach past it do their work while the file elaborates — `sorry` and `admit` leave a
 * hole, `axiom` asserts one, `native_decide` moves the proof into a compiled decision
 * procedure, and `elab`, `macro`, `macro_rules`, `run_cmd`, `initialize`, `@[implemented_by]`
 * and `extern` all run or replace code during elaboration, where they can print evidence the
 * harness then reads. `opaque`, `partial`, `unsafe` and `noncomputable` sit in the same family:
 * each admits a definition the kernel does not check the way a proof is checked.
 *
 * So the scan is deliberately not a parser. It does not decide what a declaration is, which is
 * the mistake it replaces: a regex over lines cannot see a declaration that spans lines, and it
 * refuses honest private helpers while a `macro` rewrites the file underneath it. A token scan
 * over comment-stripped text has neither failure — it cannot be evaded by formatting, and a
 * helper carrying none of these tokens is admitted, because whatever unsoundness it could
 * smuggle has to arrive through a token here or through an axiom the designation audit refuses.
 *
 * The precedent is the same shape as the reviewed corpus gates: `cnl.mjs` refuses `sorryAx` out
 * of the designation report, and the formal negative probes plant a `native_decide` axiom to
 * prove the refusal fires.
 */
export const PROOF_FORBIDDEN_TOKENS: readonly string[] = Object.freeze([
    "@[implemented_by]",
    "admit",
    "axiom",
    "elab",
    "extern",
    "initialize",
    "macro",
    "macro_rules",
    "native_decide",
    "noncomputable",
    "opaque",
    "partial",
    "run_cmd",
    "sorry",
    "unsafe"
]);

/** The scan itself: identifier tokens match on word boundaries, and the attribute matches
 * wherever it appears inside an attribute list. */
const FORBIDDEN_PATTERNS: readonly { readonly token: string; readonly pattern: RegExp }[] =
    Object.freeze(
        PROOF_FORBIDDEN_TOKENS.map((token) => ({
            token,
            pattern:
                token === "@[implemented_by]"
                    ? /@\[[^\]]*\bimplemented_by\b/u
                    : new RegExp(`\\b${token}\\b`, "u")
        }))
    );

/**
 * The forbidden tokens one candidate artifact carries, in the order the policy lists them.
 *
 * The scan runs over lexed code, not over raw text, and the difference is the whole guarantee.
 * Stripping comments by pattern is not enough because a comment marker can appear inside a
 * string: `def marker : String := "/-"` opens nothing, and a stripper that believed it did
 * would treat the rest of the file as comment text — including an `axiom` the scan then never
 * saw. The same holds in reverse for a quote inside a comment. So the source is lexed with the
 * states Lean actually has: line comments, nested block comments, string literals with escapes,
 * raw strings with their hash fences, and char literals. Only code survives, and only code is
 * scanned; a forbidden word in a comment or a string is prose, not a construction.
 */
export function forbiddenProofTokens(source: string): readonly string[] {
    const code = proofSourceCode(source);
    return FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(code)).map(({ token }) => token);
}

/**
 * The candidate's code with every comment, string, raw string and char literal removed.
 *
 * Each removed span leaves a space, so tokens on either side of it stay separate words rather
 * than joining into one. An apostrophe is only a char literal when it opens one — `foo'` is an
 * ordinary Lean name — so a quote that follows an identifier character stays code.
 */
function proofSourceCode(source: string): string {
    let code = "";
    let index = 0;
    while (index < source.length) {
        if (source.startsWith("--", index)) {
            const line = source.indexOf("\n", index);
            index = line === -1 ? source.length : line;
            code += " ";
            continue;
        }
        if (source.startsWith("/-", index)) {
            index = afterBlockComment(source, index);
            code += " ";
            continue;
        }
        const raw = afterRawString(source, index);
        if (raw !== undefined) {
            index = raw;
            code += " ";
            continue;
        }
        if (source.startsWith('"', index)) {
            index = afterQuoted(source, index + 1, '"');
            code += " ";
            continue;
        }
        if (source.startsWith("'", index) && !opensName(code) && closesChar(source, index)) {
            index = afterQuoted(source, index + 1, "'");
            code += " ";
            continue;
        }
        code += source[index];
        index += 1;
    }
    return code;
}

/** The index just past a nested block comment: `/- ... /- ... -/ ... -/` is one comment. */
function afterBlockComment(source: string, start: number): number {
    let depth = 0;
    let index = start;
    while (index < source.length) {
        if (source.startsWith("/-", index)) {
            depth += 1;
            index += 2;
            continue;
        }
        if (source.startsWith("-/", index)) {
            depth -= 1;
            index += 2;
            if (depth === 0) return index;
            continue;
        }
        index += 1;
    }
    return source.length;
}

/** The index just past a raw string, or nothing when this is not one. Lean fences a raw string
 * with `r`, any number of `#`, and a quote, and closes it with the quote and the same fence. */
function afterRawString(source: string, start: number): number | undefined {
    if (source[start] !== "r") return undefined;
    let hashes = 0;
    while (source[start + 1 + hashes] === "#") hashes += 1;
    if (source[start + 1 + hashes] !== '"') return undefined;
    const fence = `"${"#".repeat(hashes)}`;
    const close = source.indexOf(fence, start + 2 + hashes);
    return close === -1 ? source.length : close + fence.length;
}

/** The index just past a quoted literal, honouring backslash escapes. */
function afterQuoted(source: string, start: number, quote: string): number {
    let index = start;
    while (index < source.length) {
        if (source[index] === "\\") {
            index += 2;
            continue;
        }
        if (source.startsWith(quote, index)) return index + 1;
        index += 1;
    }
    return source.length;
}

/** Whether the code so far ends in a name, which makes a following quote part of that name. */
function opensName(code: string): boolean {
    return /[A-Za-z0-9_?!]$/u.test(code);
}

/** Whether a char literal actually closes: `'a'` and `'\n'` do, a stray quote does not. */
function closesChar(source: string, start: number): boolean {
    return /^'(?:\\.|[^'\\])'/u.test(source.slice(start, start + 4));
}

/**
 * Runs the reviewed Lean commands inside one isolation and reads their output.
 *
 * The build runs first for the same reason the controlled-language gate builds first: the
 * corpus asserts its declaration shapes and its refusals while the library elaborates, so a
 * report read off a stale cache would have run none of those guards.
 */
export class LeanProofCandidateVerification extends ProofCandidateVerification {
    private readonly runner: ProofCommandRunner;
    private readonly owners: ProofArtifactOwners;
    private readonly build: ProofCommand;
    private readonly report: ProofCommand;
    private readonly audited: readonly string[];
    private readonly entry: string;

    /**
     * @param audited every declaration the reviewed corpus registers for the axiom report,
     * supplied by the host from the reviewed corpus rather than read out of the report the
     * candidate's own elaboration produced.
     * @param entry the module the audited run elaborates. It must be an evidence module, so
     * the import closure walked from it is one the candidate cannot extend.
     */
    public constructor(
        runner: ProofCommandRunner,
        owners: ProofArtifactOwners,
        build: ProofCommand,
        report: ProofCommand,
        audited: readonly string[],
        entry: string
    ) {
        super();
        this.runner = runner;
        this.owners = owners;
        this.build = build;
        this.report = report;
        if (audited.length === 0) {
            throw new TypeError("A verification names no audited declarations");
        }
        for (const name of audited) assertProofDeclaration(name, "An audited declaration");
        if (new Set(audited).size !== audited.length) {
            throw new TypeError("A verification names one audited declaration twice");
        }
        if (!PROOF_EVIDENCE_MODULES.has(entry)) {
            throw new TypeError(`A verification entry module is not frozen evidence: ${entry}`);
        }
        this.audited = Object.freeze([...audited]);
        this.entry = entry;
        Object.freeze(this);
    }

    public auditedNames(): readonly string[] {
        return this.audited;
    }

    public verify(subject: ProofCandidateSubject): ProofVerificationReport | ProofRepairRefusal {
        // Both gates run before any command does: a candidate the audited build never reads,
        // or one declaring something the axiom report will never designate, is refused without
        // spending an elaboration on it.
        const admitted = this.admissible(subject);
        if (admitted !== undefined) return admitted;
        const built = this.runner.run(this.build, subject.root);
        const buildFindings = this.findings(subject, built.output);
        if (built.status !== 0) {
            return buildFindings.length === 0
                ? inconclusive(this.build, built)
                : this.reported(subject, buildFindings, [], []);
        }
        const run = this.runner.run(this.report, subject.root);
        const findings = [...buildFindings, ...this.findings(subject, run.output)];
        if (run.status !== 0) {
            return findings.length === 0
                ? inconclusive(this.report, run)
                : this.reported(subject, findings, [], []);
        }
        const ledger = ledgerLine(run.output, this.report.render());
        if (ledger instanceof ProofRepairRefusal) return ledger;
        const proved = provedUnits(ledger, this.report.render());
        if (proved instanceof ProofRepairRefusal) return proved;
        return this.reported(subject, findings, proved, parseAxiomDesignations(run.output));
    }

    /**
     * Whether this candidate is one the audited run can actually judge, or the refusal saying
     * why not.
     *
     * Two questions, both answered from the isolation before it is elaborated.
     *
     * *Reachability.* The artifact policy says which modules a candidate may write; it does
     * not say the elaboration reads them. A new module under `SpecCnl/` that nothing imports
     * would be accepted into the durable ledger while the kernel never looked at it, so the
     * import closure is walked from the frozen entry module — following imports only through
     * frozen modules, because a writable module's own import list is candidate-controlled —
     * and an artifact outside that closure is refused.
     *
     * *Constructions.* `#print axioms` designates the audited names and nothing else, so a
     * construction that reaches past the kernel — a hole, an asserted axiom, a compiled
     * decision procedure, or elaboration-time code that can print evidence — would be
     * inspected by nobody. The candidate's own text is scanned for those tokens and refused
     * before anything elaborates. What the scan does not do is decide what a declaration is:
     * a private helper carrying none of these tokens is legitimate, and its soundness is the
     * designation audit's question, not this scan's.
     */
    private admissible(subject: ProofCandidateSubject): ProofRepairRefusal | undefined {
        let reachable: ReadonlySet<string>;
        try {
            reachable = reachableProofModules(subject.root, this.entry);
        } catch (error) {
            return ProofRepairRefusal.runtime("import closure", [
                error instanceof Error ? error.message : "the import closure could not be read"
            ]);
        }
        for (const path of subject.candidate.paths()) {
            if (!reachable.has(path)) {
                return ProofRepairRefusal.malformed(
                    `${path} is outside the import closure of ${this.entry}, ` +
                        "so the audited run never reads it"
                );
            }
        }
        for (const artifact of subject.candidate.artifacts) {
            const forbidden = forbiddenProofTokens(artifact.text);
            const first = forbidden[0];
            if (first !== undefined) {
                return ProofRepairRefusal.malformed(
                    `${artifact.path} uses ${forbidden.join(", ")}, which a candidate may not: ` +
                        `${first} reaches past the kernel that judges it`
                );
            }
        }
        return undefined;
    }

    private reported(
        subject: ProofCandidateSubject,
        findings: readonly ProofFinding[],
        proved: readonly ProofObligation[],
        designations: readonly DeclarationAxioms[]
    ): ProofVerificationReport | ProofRepairRefusal {
        const artifacts = measuredArtifacts(subject);
        if (artifacts instanceof ProofRepairRefusal) return artifacts;
        return new ProofVerificationReport(
            reportGrant,
            subject.candidate.identity,
            artifacts,
            findings,
            proved,
            designations
        );
    }

    private findings(subject: ProofCandidateSubject, output: string): readonly ProofFinding[] {
        const findings: ProofFinding[] = [];
        for (const diagnostic of parseProofDiagnostics(output)) {
            if (diagnostic.severity !== "error") continue;
            const finding = this.classify(subject, diagnostic);
            if (finding !== undefined) findings.push(finding);
        }
        return findings;
    }

    /**
     * One error diagnostic, attributed.
     *
     * A diagnostic in a candidate file is the candidate's own defect. A diagnostic in a base
     * file is still the candidate's defect: a candidate that edits one corpus module can break
     * a reference in another, and dropping that diagnostic would leave a failed build whose
     * only remaining reading — an unattributed run that reached no verdict — is false. Its
     * locus names the file that stopped elaborating, with the candidate's own artifacts named
     * beside it, so the repair points at the text to fix and knows what caused it.
     */
    private classify(
        subject: ProofCandidateSubject,
        diagnostic: ProofDiagnostic
    ): ProofFinding | undefined {
        const model = this.modelFinding(subject, diagnostic);
        if (model !== undefined) return model;
        const artifact = relativeArtifact(diagnostic.artifact, subject.root);
        if (artifact === undefined) return undefined;
        const owner = this.owners.owner(artifact);
        if (owner === undefined) return undefined;
        const locus = ProofRepairLocus.at(owner, artifact);
        const paths = subject.candidate.paths();
        if (paths.includes(artifact)) {
            return (
                ambiguityFinding(locus, diagnostic) ??
                ProofRepairRefusal.compile(locus.withSpan(diagnostic.span), diagnostic.message)
            );
        }
        return ProofRepairRefusal.compile(
            locus.withSpan(diagnostic.span),
            `${diagnostic.message} [broken by the candidate edit to ${paths.join(" ")}]`
        );
    }

    /**
     * The shapes assertion refuses every mismatched declaration in one message, joined with
     * `; `. The locus names the first entry this candidate is answerable for — a candidate can
     * break a declaration it did not write — while the counterexample keeps every entry, so
     * nothing the assertion said is dropped on the way to the generator.
     */
    private modelFinding(
        subject: ProofCandidateSubject,
        diagnostic: ProofDiagnostic
    ): ProofFinding | undefined {
        const shapes = SHAPES.exec(diagnostic.message);
        if (shapes === null || shapes[1] === undefined) return undefined;
        const entries = shapes[1].split("; ");
        for (const entry of entries) {
            const declaration = SHAPE_DECLARATION.exec(entry);
            if (declaration === null || declaration[1] === undefined) continue;
            const artifact = leanArtifact(declaration[1], subject.candidate.paths());
            if (artifact === undefined) continue;
            const owner = this.owners.owner(artifact);
            if (owner === undefined) continue;
            return ProofRepairRefusal.model(
                ProofRepairLocus.at(owner, artifact).withTheorem(declaration[1]),
                [...entries, `reported at ${diagnostic.artifact}:${diagnostic.span.render()}`]
            );
        }
        return undefined;
    }
}

/**
 * The ambiguity a refused sentence carries, or nothing when the message is not that refusal.
 *
 * Exactly two readings are a counterexample a repair can act on: the sentence means either
 * this or that, and one of the two has to be said instead. A refusal reporting some other
 * number of readings is left to the compile classification, which carries the whole message,
 * rather than being narrowed to a pair the harness picked.
 */
function ambiguityFinding(
    locus: ProofRepairLocus,
    diagnostic: ProofDiagnostic
): ProofFinding | undefined {
    const refused = AMBIGUOUS.exec(diagnostic.message);
    if (refused === null) return undefined;
    const [, sentence, count, rendered] = refused;
    if (sentence === undefined || count === undefined || rendered === undefined) return undefined;
    const readings = rendered.split(" | ");
    if (Number.parseInt(count, 10) !== 2 || new Set(readings).size !== 2) return undefined;
    return ProofRepairRefusal.ambiguity(locus.withSpan(diagnostic.span), sentence, readings);
}

/** The verifier measures candidate bytes after both Lean commands have returned. A command
 * that rewrites, removes, or replaces one candidate file cannot leave a report that claims it
 * verified the original digest. */
function measuredArtifacts(
    subject: ProofCandidateSubject
): readonly ProofArtifactDigest[] | ProofRepairRefusal {
    try {
        return subject.candidate.artifacts.map((artifact) => {
            const path = join(subject.root, artifact.path);
            const entry = lstatSync(path);
            if (!entry.isFile() || entry.isSymbolicLink()) {
                throw new TypeError(`${artifact.path} is not an ordinary isolated file`);
            }
            return new ProofArtifactDigest(artifact.path, sha256(readFileSync(path, "utf8")));
        });
    } catch (error) {
        return ProofRepairRefusal.runtime("artifact measurement", [
            error instanceof Error ? error.message : "the isolated artifact set could not be read"
        ]);
    }
}

function inconclusive(command: ProofCommand, outcome: ProofCommandOutcome): ProofRepairRefusal {
    return ProofRepairRefusal.runtime(command.render(), [
        `exit ${outcome.status ?? "none"}`,
        outcome.output.length === 0 ? "no output" : outcome.output
    ]);
}

/** Lean prints the artifact as it was given, so a leading `./` and an absolute path under the
 * isolation both name a file inside it. A path that resolves anywhere else is not this
 * candidate's, and its diagnostic is left unclassified rather than misattributed. */
function relativeArtifact(printed: string, root: string): string | undefined {
    const trimmed = printed.startsWith("./") ? printed.slice(2) : printed;
    const relative = trimmed.startsWith(`${root}/`) ? trimmed.slice(root.length + 1) : trimmed;
    if (relative.length === 0 || relative.startsWith("/") || relative.split("/").includes("..")) {
        return undefined;
    }
    return relative;
}

/**
 * The one ledger line the reviewed report printed.
 *
 * Exactly one is required, and that requirement is the guard: candidate text elaborated by the
 * same run can print, so a candidate that emits its own `cnl-ledger` line to claim closures it
 * never proved produces two. It cannot remove the real one — the report module is not
 * candidate-writable — so a second line is the tell, and the harness refuses rather than
 * choosing which one to believe. The reviewed controlled-language gate refuses two ledgers for
 * the same reason.
 */
function ledgerLine(output: string, command: string): string | ProofRepairRefusal {
    const printed = output
        .split(/\r?\n/u)
        .map((raw) => raw.trim())
        .filter((line) => line.startsWith(LEDGER_LINE))
        .map((line) => line.slice(LEDGER_LINE.length));
    const only = printed[0];
    if (only === undefined) {
        return ProofRepairRefusal.runtime(command, ["no ledger line was printed"]);
    }
    if (printed.length > 1) {
        return ProofRepairRefusal.runtime(command, [
            `the run printed ${printed.length} ledger lines, so one of them is not the report's`
        ]);
    }
    return only;
}

/** The rule units the run proved, read from the report's own ledger line. A line that is not
 * the shape this reader expects is no evidence, not a smaller proved set. */
function provedUnits(
    line: string,
    command: string
): readonly ProofObligation[] | ProofRepairRefusal {
    try {
        const ledger = assertObject(parseCanonicalJson(line, "the report ledger"), "the ledger");
        return assertArray(ledger["units"], "the ledger units").map((entry, index) =>
            provedUnit(entry, `the ledger unit ${index}`)
        );
    } catch (error) {
        return ProofRepairRefusal.runtime(command, [
            error instanceof Error ? error.message : "the ledger line could not be read"
        ]);
    }
}

function provedUnit(entry: JsonValue, owner: string): ProofObligation {
    const unit: JsonObject = assertObject(entry, owner);
    return new ProofObligation(
        assertString(unit["digest"], `${owner}.digest`),
        assertArray(unit["atoms"], `${owner}.atoms`).map((atom, index) =>
            assertString(atom, `${owner}.atoms[${index}]`)
        ),
        assertString(unit["anchor"], `${owner}.anchor`)
    );
}
