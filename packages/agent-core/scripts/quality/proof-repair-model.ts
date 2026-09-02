import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
    assertArray,
    assertExactKeys,
    assertObject,
    assertString,
    jsonKind,
    parseCanonicalJson,
    type JsonObject,
    type JsonValue
} from "./project.mjs";
import {
    assertDigest,
    ProofObligation,
    ProofRepairCandidate,
    ProofRepairObjective,
    ProposedArtifact,
    type ProofArtifactContent
} from "./proof-repair-record.js";
import { PROOF_FORBIDDEN_TOKENS } from "./proof-repair-verification.js";
import { type ProofCandidateGenerator, type ProofRepairTurn } from "./proof-repair-host.js";

/**
 * The live-model generator for the untrusted-LLM proof synthesis loop.
 *
 * The host owns the loop and the protocol owns the decision. This module owns exactly one
 * thing: turning one `ProofRepairTurn` into one raw proposal, by asking a real model. It
 * holds no store, no ledger path, and no verifier — the only value it produces is the
 * `JsonValue` the host hands to the protocol's one boundary, so "the generator cannot write
 * the accepted state" is a property of what this module is given rather than a rule it
 * follows.
 *
 * Three decisions shape everything below.
 *
 * **The seam is synchronous, because the loop is.** `ProofCandidateGenerator.propose`
 * returns a value, the store is synchronous, and the Lean verifier is a `spawnSync` away;
 * an async generator would mean an async loop, and the landed host's whole shape says the
 * loop is a straight line. The OpenAI-compatible port in `@agent-core/harness` is `async` —
 * as every network client is — so the bridge is a child process per exchange
 * (`SpawnProofModelExchange`), exactly the shape the verifier already uses to run Lean. One
 * extra process per attempt, beside the two Lean processes each attempt already spends, is
 * not a cost worth inventing a thread-and-`Atomics` protocol to avoid.
 *
 * **Nothing repairs model output.** The reply is parsed once, strictly, at this boundary:
 * exactly one JSON value, with no duplicate keys and no trailing prose. A reply that is not
 * that is forwarded *as the string it is*, because the protocol's own boundary already
 * refuses a proposal that is not a well-formed candidate and says exactly what was wrong
 * with it, and the loop carries that refusal back to the model on the next turn. A boundary
 * that stripped code fences, guessed which of two objects was the answer, or filled in a
 * field the model omitted would be a boundary that can no longer tell you what the model
 * actually said.
 *
 * **The prompt shows the model the candidate it is rewriting.** The trusted objective
 * arrives as the host's own turn text; the envelope around it — the baseline digest, the
 * obligation rows, and the current text of every writable artifact — is rendered from the
 * records' own codecs, so there is no second description of the wire shape to drift. The
 * model's job is to return that same object with repaired artifact text. It may still get
 * the envelope wrong, and when it does the protocol refuses it as stale or malformed with
 * feedback naming both sides; this module does not correct it.
 */

/** What one exchange sends: the system instructions and the one user message. Both are
 * derived from the turn, so a recorded exchange stores the turn rather than a second copy
 * of the text this module renders from it. */
export interface ProofModelRequest {
    readonly instructions: string;
    readonly text: string;
}

/** Raised when an exchange produced no answer at all: an unreachable endpoint, a refused
 * credential, a killed child, or a recording that has run out. It is never a statement
 * about a candidate — there is no candidate — so the generator turns it into a decline and
 * the loop's own `declined` terminal, rather than into feedback nobody could act on. */
export class ProofModelUnavailable extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "ProofModelUnavailable";
    }
}

/** The synchronous model seam: one request, one reply text. */
export abstract class ProofModelExchange {
    public abstract exchange(request: ProofModelRequest): string;
}

/**
 * What the model is told about its role, once.
 *
 * The forbidden-construction list is rendered from the policy the verifier enforces rather
 * than restated here, so the contract the model is held to and the contract the harness
 * applies cannot drift apart.
 */
const modelInstructions = [
    "You repair Lean proofs in a controlled-language corpus that a harness verifies.",
    "",
    "Reply with exactly one JSON object and nothing else: no prose, no explanation, no",
    "markdown fence. The object is the candidate you were shown, with the `text` of every",
    "artifact you repaired replaced by that file's complete new contents. Copy `baseline`",
    "and `obligations` through byte for byte and keep every artifact `path` unchanged: the",
    "harness owns those fields and refuses a candidate that alters them.",
    "",
    "Every artifact `text` is a whole file, never a patch or a fragment. The harness",
    "overlays it into a disposable copy of the corpus and elaborates it with Lean, so a",
    "file that drops a declaration another module imports fails to build.",
    "",
    `A candidate may not use: ${PROOF_FORBIDDEN_TOKENS.join(", ")}. Each of those reaches`,
    "past the kernel that judges the proof, and the harness refuses the candidate before",
    "anything elaborates.",
    "",
    "You are not trusted. Nothing you write is believed until Lean checks it, and when a",
    "candidate is refused you are told exactly what was refused and where. Repair that."
].join("\n");

/**
 * The envelope every turn is asked inside: the baseline the candidate binds itself to, the
 * trusted obligation set, and the current text of the artifacts a candidate may rewrite.
 *
 * Both halves of the envelope come from the harness, not from the model, and neither is the
 * ledger: the baseline is one digest string the caller read from the store, and the sources
 * are reviewed corpus files. A repair loop can hand those over because the committed ledger
 * gate already requires every accepted artifact to be byte-identical to the reviewed tree at
 * the same path — so the reviewed text *is* the accepted text, and showing it to a model
 * discloses nothing the model is not about to be asked to rewrite.
 *
 * The rendered candidate is a real `ProofRepairCandidate`, so the shape the model is shown
 * is the shape the protocol reads, derived from the same codec rather than described twice.
 * It also means an unwritable path is refused while the prompt is built, rather than after a
 * model has spent an attempt proposing text for it.
 */
export class ProofRepairPrompt {
    public readonly baseline: string;
    public readonly objective: ProofRepairObjective;
    private readonly frame: ProofRepairCandidate;

    public constructor(
        baseline: string,
        objective: ProofRepairObjective,
        sources: readonly ProofArtifactContent[]
    ) {
        this.baseline = assertDigest(baseline, "A prompt baseline");
        this.objective = objective;
        if (sources.length === 0) {
            throw new TypeError("A proof repair prompt shows the model no writable artifact");
        }
        this.frame = new ProofRepairCandidate(
            this.baseline,
            objective.obligations,
            sources.map((source) => new ProposedArtifact(source.path, source.text))
        );
        Object.freeze(this);
    }

    /** The one rendering of one turn. Recorded replay compares against this, so a recording
     * describes the exact question the loop asks rather than an approximation of it. */
    public render(turn: ProofRepairTurn): ProofModelRequest {
        const refused =
            turn.feedback === undefined
                ? []
                : ["", "The previous attempt was refused:", turn.feedback];
        return Object.freeze({
            instructions: modelInstructions,
            text: [
                turn.prompt,
                ...refused,
                "",
                "The candidate to repair:",
                JSON.stringify(this.frame.toData(), null, 2)
            ].join("\n")
        });
    }
}

/** One recorded exchange: the turn the loop asked, and the verbatim reply it heard. The
 * rendered request is deliberately absent — it is derived from the turn by one function, so
 * recording it too would be a second copy of the same fact, free to drift. */
export class ProofModelExchangeRecord {
    public readonly attempt: number;
    public readonly prompt: string;
    public readonly feedback: string | undefined;
    public readonly reply: string;

    public constructor(
        attempt: number,
        prompt: string,
        feedback: string | undefined,
        reply: string
    ) {
        if (!Number.isSafeInteger(attempt) || attempt < 1) {
            throw new TypeError(`A recorded exchange is not an attempt: ${attempt}`);
        }
        if (prompt.length === 0) throw new TypeError("A recorded exchange carries no prompt");
        if (feedback !== undefined && feedback.length === 0) {
            throw new TypeError("A recorded exchange carries empty feedback");
        }
        this.attempt = attempt;
        this.prompt = prompt;
        this.feedback = feedback;
        this.reply = reply;
        Object.freeze(this);
    }

    public toData(): JsonObject {
        if (this.feedback === undefined) {
            return { attempt: this.attempt, prompt: this.prompt, reply: this.reply };
        }
        return {
            attempt: this.attempt,
            feedback: this.feedback,
            prompt: this.prompt,
            reply: this.reply
        };
    }

    public static fromData(value: JsonValue | undefined, owner: string): ProofModelExchangeRecord {
        const record = assertObject(value, owner);
        const feedback = record["feedback"];
        assertExactKeys(
            record,
            feedback === undefined
                ? ["attempt", "prompt", "reply"]
                : ["attempt", "feedback", "prompt", "reply"],
            owner
        );
        const attempt = record["attempt"];
        if (!isJsonNumber(attempt)) throw new TypeError(`${owner}.attempt must be a number`);
        return new ProofModelExchangeRecord(
            attempt,
            assertString(record["prompt"], `${owner}.prompt`),
            feedback === undefined ? undefined : assertString(feedback, `${owner}.feedback`),
            assertString(record["reply"], `${owner}.reply`)
        );
    }
}

const RECORDING_KIND = "proof.repair.model.recording";

/**
 * The recording version, read exactly.
 *
 * The ledger's codec tolerates an older minor within its major because it reads durable
 * state nobody can re-derive. A recording is not durable state: it is a transcript of one
 * model run, and the honest answer to a version this reader does not know is to record the
 * run again, not to guess which fields the writer meant. So there is no version algebra
 * here, and no second copy of the ledger's.
 */
export const proofRepairModelRecordingVersion = "1.0";

/**
 * One recorded model run: the state it was recorded against, and every exchange in order.
 *
 * The baseline and the objective are part of the record because a transcript of answers
 * means nothing without the question's frame — a reply carrying a baseline is only correct
 * against the state that produced it. `RecordedProofModelExchange` refuses a prompt whose
 * frame differs, which is the same staleness discipline the protocol applies to candidates.
 *
 * A recording never carries a credential, an endpoint, or a header: the only fields are the
 * turns the loop asked and the text the model answered with, so a recorded fixture is safe
 * to commit and a committed fixture is exactly what a replay reruns.
 */
export class ProofRepairModelRecording {
    public readonly model: string;
    public readonly provenance: string;
    public readonly baseline: string;
    public readonly objective: readonly ProofObligation[];
    public readonly exchanges: readonly ProofModelExchangeRecord[];

    public constructor(
        model: string,
        provenance: string,
        baseline: string,
        objective: readonly ProofObligation[],
        exchanges: readonly ProofModelExchangeRecord[]
    ) {
        if (model.length === 0) throw new TypeError("A recording names no model");
        if (provenance.length === 0) throw new TypeError("A recording states no provenance");
        this.model = model;
        this.provenance = provenance;
        this.baseline = assertDigest(baseline, "A recording baseline");
        if (objective.length === 0) throw new TypeError("A recording names no objective");
        this.objective = Object.freeze([...objective]);
        if (exchanges.length === 0) throw new TypeError("A recording carries no exchange");
        exchanges.forEach((exchange, index) => {
            if (exchange.attempt !== index + 1) {
                throw new TypeError(
                    `A recording is out of order: entry ${index} is attempt ${exchange.attempt}`
                );
            }
        });
        this.exchanges = Object.freeze([...exchanges]);
        Object.freeze(this);
    }

    public toData(): JsonObject {
        return {
            baseline: this.baseline,
            exchanges: this.exchanges.map((exchange) => exchange.toData()),
            kind: RECORDING_KIND,
            model: this.model,
            objective: this.objective.map((obligation) => obligation.toData()),
            provenance: this.provenance,
            version: proofRepairModelRecordingVersion
        };
    }

    public static fromData(value: JsonValue | undefined, owner: string): ProofRepairModelRecording {
        const record = assertObject(value, owner);
        assertExactKeys(
            record,
            ["baseline", "exchanges", "kind", "model", "objective", "provenance", "version"],
            owner
        );
        const kind = assertString(record["kind"], `${owner}.kind`);
        if (kind !== RECORDING_KIND) {
            throw new TypeError(`${owner} is not a proof repair model recording: ${kind}`);
        }
        const version = assertString(record["version"], `${owner}.version`);
        if (version !== proofRepairModelRecordingVersion) {
            throw new TypeError(
                `${owner} is version ${version} and this reader records ` +
                    `${proofRepairModelRecordingVersion}; record the run again`
            );
        }
        return new ProofRepairModelRecording(
            assertString(record["model"], `${owner}.model`),
            assertString(record["provenance"], `${owner}.provenance`),
            assertString(record["baseline"], `${owner}.baseline`),
            assertArray(record["objective"], `${owner}.objective`).map((entry, index) =>
                ProofObligation.fromData(entry, `${owner}.objective[${index}]`)
            ),
            assertArray(record["exchanges"], `${owner}.exchanges`).map((entry, index) =>
                ProofModelExchangeRecord.fromData(entry, `${owner}.exchanges[${index}]`)
            )
        );
    }

    /** One recording read from its committed text, through the strict parser every artifact
     * this repo treats as evidence is read through. */
    public static read(source: string, owner: string): ProofRepairModelRecording {
        return ProofRepairModelRecording.fromData(parseCanonicalJson(source, owner), owner);
    }
}

/**
 * The deterministic exchange: the recorded replies, in order, for the turns they were
 * recorded for.
 *
 * The comparison is the point. A replay that answered whatever it was asked would let a
 * recording drift away from the loop it claims to describe — a changed prompt, a changed
 * refusal, a turn that no longer happens — and still report a green run. So each request is
 * compared against the one rendered from the recorded turn by the same prompt the live path
 * renders with, and a mismatch is a defect in the recording rather than a model behavior:
 * it throws. Running out of recorded exchanges is not a defect, though; it is a model that
 * stopped answering, so it arrives as `ProofModelUnavailable` and the loop declines.
 */
export class RecordedProofModelExchange extends ProofModelExchange {
    private readonly recording: ProofRepairModelRecording;
    private readonly prompt: ProofRepairPrompt;
    private position = 0;

    public constructor(recording: ProofRepairModelRecording, prompt: ProofRepairPrompt) {
        super();
        if (recording.baseline !== prompt.baseline) {
            throw new TypeError(
                `The recording was taken against baseline ${recording.baseline} and this run ` +
                    `is at ${prompt.baseline}; record the run again`
            );
        }
        const owed = prompt.objective.obligations;
        const sameObjective =
            recording.objective.length === owed.length &&
            owed.every((entry, index) => recording.objective[index]?.equals(entry) === true);
        if (!sameObjective) {
            throw new TypeError(
                "The recording was taken against another objective; record the run again"
            );
        }
        this.recording = recording;
        this.prompt = prompt;
    }

    public exchange(request: ProofModelRequest): string {
        const recorded = this.recording.exchanges[this.position];
        if (recorded === undefined) {
            throw new ProofModelUnavailable(
                `the recording holds ${this.recording.exchanges.length} exchange(s) and the ` +
                    `loop asked for ${this.position + 1}`
            );
        }
        this.position += 1;
        const expected = this.prompt.render({
            attempt: recorded.attempt,
            prompt: recorded.prompt,
            feedback: recorded.feedback
        });
        if (expected.instructions !== request.instructions || expected.text !== request.text) {
            throw new TypeError(
                `The recorded exchange ${recorded.attempt} no longer describes the question ` +
                    "this loop asks; record the run again"
            );
        }
        return recorded.reply;
    }

    /** How many recorded exchanges are still unanswered. */
    public remaining(): number {
        return this.recording.exchanges.length - this.position;
    }
}

/** What a live run spent. Tokens are the operator's own budget, so a run reports them
 * rather than leaving a paid loop unmeasured. A replay spends nothing and has none. */
export interface ProofModelSpend {
    readonly exchanges: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
}

/** Where one live exchange goes, and what it may spend getting there. */
export interface ProofModelTarget {
    readonly endpoint: string;
    readonly model: string;
    /** Resolved once per exchange and handed to the child on its standard input, never
     * placed in an argument vector or an environment block. */
    readonly credential: () => string;
    readonly timeoutMs: number;
}

/** The default wall-clock budget one model exchange gets before the child is killed. */
export const proofModelExchangeBudgetMs = 120_000;

/** The child that owns the one asynchronous call. */
const exchangeEntry = resolve(import.meta.dirname, "proof-repair-model-call.mjs");

/** The grace the parent adds on top of the child's own abort, so a child that times out
 * reports its own failure instead of being killed before it can. */
const EXCHANGE_GRACE_MS = 15_000;
const EXCHANGE_OUTPUT_LIMIT = 8 * 1024 * 1024;

/**
 * The live exchange: one child process, one completion, through the harness's
 * OpenAI-compatible model port.
 *
 * The child exists because that port is asynchronous and this seam is not. It is also the
 * only place a credential is held: it arrives on the child's standard input, which — unlike
 * an argument vector — no other process on the host can read, and it is never written to
 * the recording, the run report, or a log. The child's output is untrusted like any other
 * input and is read strictly here; a child that exits nonzero, prints something else, or is
 * killed is an exchange that produced no answer.
 */
export class SpawnProofModelExchange extends ProofModelExchange {
    private readonly target: ProofModelTarget;
    private readonly entry: string;
    private exchanges = 0;
    private inputTokens = 0;
    private outputTokens = 0;

    public constructor(target: ProofModelTarget, entry: string = exchangeEntry) {
        super();
        if (target.endpoint.length === 0) throw new TypeError("A model target names no endpoint");
        if (target.model.length === 0) throw new TypeError("A model target names no model");
        if (!Number.isSafeInteger(target.timeoutMs) || target.timeoutMs <= 0) {
            throw new TypeError(`A model exchange budget is not a duration: ${target.timeoutMs}`);
        }
        this.target = target;
        this.entry = entry;
    }

    public exchange(request: ProofModelRequest): string {
        const outcome = spawnSync(process.execPath, [this.entry], {
            encoding: "utf8",
            input: JSON.stringify({
                credential: this.target.credential(),
                endpoint: this.target.endpoint,
                instructions: request.instructions,
                model: this.target.model,
                text: request.text,
                timeoutMs: this.target.timeoutMs
            }),
            killSignal: "SIGKILL",
            maxBuffer: EXCHANGE_OUTPUT_LIMIT,
            timeout: this.target.timeoutMs + EXCHANGE_GRACE_MS
        });
        this.exchanges += 1;
        if (outcome.error !== undefined) {
            throw new ProofModelUnavailable(`the model exchange failed: ${outcome.error.message}`);
        }
        if (outcome.status !== 0) {
            const diagnostic = outcome.stderr
                .split(/\r?\n/u)
                .find((line) => line.trim().length > 0);
            throw new ProofModelUnavailable(
                `the model exchange exited ${outcome.status ?? "on a signal"}: ` +
                    `${diagnostic?.trim() ?? "no diagnostic"}`
            );
        }
        return this.reply(outcome.stdout);
    }

    public spend(): ProofModelSpend {
        return Object.freeze({
            exchanges: this.exchanges,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens
        });
    }

    /** The child's one answer: either the model's text, or the reason there is none. */
    private reply(stdout: string): string {
        let record: JsonObject;
        try {
            record = assertObject(
                parseCanonicalJson(stdout, "the model exchange reply"),
                "the model exchange reply"
            );
        } catch (error) {
            throw new ProofModelUnavailable(
                "the model exchange answered with no reply record: " +
                    `${error instanceof Error ? error.message : "unreadable output"}`
            );
        }
        const failure = record["failure"];
        if (failure !== undefined) {
            // The child's output is untrusted like any other input: a failure field that is
            // not a message still means there is no answer, and it says so rather than
            // throwing a shape error out of the loop.
            throw new ProofModelUnavailable(
                `the model refused the exchange: ${isJsonString(failure) && failure.length > 0 ? failure : "no reason was given"}`
            );
        }
        const usage = record["usage"];
        if (usage !== undefined) {
            const counted = assertObject(usage, "the exchange usage");
            const input = counted["inputTokens"];
            const output = counted["outputTokens"];
            if (!isJsonNumber(input) || !isJsonNumber(output)) {
                throw new ProofModelUnavailable("the model exchange reported unreadable usage");
            }
            this.inputTokens += input;
            this.outputTokens += output;
        }
        const text = record["text"];
        if (!isJsonString(text)) {
            throw new ProofModelUnavailable("the model exchange reply carries no text");
        }
        return text;
    }
}

/** Both readers below classify through the one classifier this repository parses artifacts
 * with, and leave the answer in the type, so a caller inherits the proof instead of
 * restating it. */
function isJsonNumber(value: JsonValue | undefined): value is number {
    return jsonKind(value) === "number";
}

function isJsonString(value: JsonValue | undefined): value is string {
    return jsonKind(value) === "string";
}

/**
 * The generator itself: one exchange per turn, under two bounds.
 *
 * The host's budget bounds the attempts one objective may spend. This generator's own
 * budget bounds the exchanges it will ever make, and the target's budget bounds how long
 * one of them may take. They are separate on purpose: a loop scheduled with a large attempt
 * budget, or a host reused across objectives, cannot turn into an unbounded number of paid
 * model calls, because the ceiling belongs to the thing that spends the money.
 *
 * A generator that stops answering — budget spent, endpoint unreachable, recording
 * exhausted, or an empty reply — returns nothing and records why. The host reads that as
 * its `declined` terminal, which is the honest outcome: no candidate was proposed, so
 * nothing was judged and nothing is claimed about the objective.
 *
 * It also records what it asked and what it heard. That is the only place both halves of an
 * exchange exist together, so recording lives here rather than in the seam, and `--record`
 * on the operator entry is the same code path a committed replay fixture comes from.
 */
export class ProofRepairModelGenerator implements ProofCandidateGenerator {
    private readonly prompt: ProofRepairPrompt;
    private readonly seam: ProofModelExchange;
    private readonly budget: number;
    private readonly recorded: ProofModelExchangeRecord[] = [];
    private reason: string | undefined;

    public constructor(prompt: ProofRepairPrompt, seam: ProofModelExchange, budget: number) {
        if (!Number.isSafeInteger(budget) || budget < 1) {
            throw new TypeError(`A model exchange budget bounds at least one exchange: ${budget}`);
        }
        this.prompt = prompt;
        this.seam = seam;
        this.budget = budget;
    }

    public propose(turn: ProofRepairTurn): JsonValue | undefined {
        if (this.recorded.length >= this.budget) {
            this.reason = `the exchange budget of ${this.budget} is spent`;
            return undefined;
        }
        let reply: string;
        try {
            reply = this.seam.exchange(this.prompt.render(turn));
        } catch (error) {
            if (!(error instanceof ProofModelUnavailable)) throw error;
            this.reason = error.message;
            return undefined;
        }
        this.recorded.push(
            new ProofModelExchangeRecord(turn.attempt, turn.prompt, turn.feedback, reply)
        );
        if (reply.trim().length === 0) {
            this.reason = "the model answered with no text";
            return undefined;
        }
        return proofModelProposal(reply);
    }

    /** Why this generator stopped answering, when it has. */
    public declined(): string | undefined {
        return this.reason;
    }

    /** Every exchange this generator made, as the recording a replay reruns. */
    public recording(model: string, provenance: string): ProofRepairModelRecording {
        return new ProofRepairModelRecording(
            model,
            provenance,
            this.prompt.baseline,
            this.prompt.objective.obligations,
            this.recorded
        );
    }
}

/**
 * The trust boundary: one model reply, as the proposal the protocol reads.
 *
 * A reply that is exactly one JSON value — no duplicate keys, no trailing prose — is that
 * value. Anything else is the text itself, as data, which is total and lossless and hands
 * the judgement to the one boundary that already owns it: the protocol refuses a proposal
 * that is not a well-formed candidate and says exactly what was wrong with it, and the loop
 * carries that refusal back to the model on the next turn. Extracting a fenced block or
 * repairing a missing field here would be this module deciding what the model meant.
 */
export function proofModelProposal(reply: string): JsonValue {
    try {
        return parseCanonicalJson(reply.trim(), "the model reply");
    } catch {
        return reply;
    }
}
