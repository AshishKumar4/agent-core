// The operator entry for one untrusted-LLM proof repair run.
//
// Everything this composes is already reviewed: the corpus objective comes from the
// controlled-language gate's committed ledger, the candidate is judged by the Lean verifier
// inside a disposable isolation, and the accepted state is written only by the protocol's
// own store. What this entry adds is the wiring an operator needs to run the loop once,
// end to end, against the real corpus — and the two refusals that keep the run from being
// something nobody asked for.
//
// *Consent.* A live run costs money and sends the corpus, the objective and the current
// proof text to a third-party endpoint, so it happens only behind `--consent live-model`
// together with a credential in `PROOF_REPAIR_MODEL_TOKEN`. Neither implies the other:
// a credential lying in the environment is not permission, and permission without a
// credential is not a run. `--replay <recording>` reruns a recorded run with no network at
// all and needs no consent, which is what the test suite uses.
//
// *The accepted state.* An acceptance publishes the accepted artifact text into the ledger,
// and the committed ledger gate requires that text to be byte-identical to the reviewed
// `formal/` tree. Nothing here writes the reviewed tree — the protocol deliberately has no
// path into it — so this entry runs against an isolated ledger seeded from the committed
// record by default, and reports the accepted text for review. Promoting an acceptance is
// a reviewed edit followed by a run against the committed record with `--ledger`, never a
// silent write from a model loop.
//
// Usage
//   node scripts/quality/proof-repair-run.mjs --replay test/quality/fixtures/<recording>.json
//   PROOF_REPAIR_MODEL_TOKEN=... node scripts/quality/proof-repair-run.mjs \
//       --consent live-model --model <name> --account <cloudflare-account-id> \
//       [--gateway <gateway> --provider <upstream>] [--endpoint <url>] \
//       [--attempts 3] [--exchanges 3] [--timeout 120] \
//       [--ledger <path>] [--corpus <path>] [--record <path>] [--report <path>]
//
// Exit status is the verdict: zero when the objective was closed by an accepted candidate,
// one for every other terminal, with the terminal named on standard output.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import { portablePath, reportRoot, writeCanonicalJson } from "./project.mjs";

register(new URL("./ts-companion.mjs", import.meta.url));

const { acceptedProofArtifact } = await import("./proof-repair-record.ts");
const { RepositoryProofArtifactOwners } = await import("./proof-repair.ts");
const { FileProofRepairStore, proofRepairLedgerArtifact } = await import("./proof-repair-store.ts");
const { LeanProofCandidateVerification, ProofCommand, SpawnProofCommandRunner } =
    await import("./proof-repair-verification.ts");
const { ProofRepairHost, cnlCorpusLedgerArtifact } = await import("./proof-repair-host.ts");
const {
    ProofRepairModelGenerator,
    ProofRepairModelRecording,
    ProofRepairPrompt,
    RecordedProofModelExchange,
    SpawnProofModelExchange,
    proofModelExchangeBudgetMs
} = await import("./proof-repair-model.ts");

/** The environment variable a live run's credential arrives in, named here because this
 * entry is the only thing that reads it: the adapter is handed a thunk, and the child that
 * performs the exchange is handed the value on its standard input. */
const CREDENTIAL_ENVIRONMENT = "PROOF_REPAIR_MODEL_TOKEN";

/** The consent a live run requires, spelled out rather than a bare boolean flag: an
 * operator types what they are consenting to. */
const LIVE_CONSENT = "live-model";

/** The corpus's own evidence entry, and the two commands the reviewed controlled-language
 * gate runs over it. The entry module must be frozen evidence, which is what makes the
 * import closure walked from it one a candidate cannot extend. */
const CORPUS_ENTRY_MODULE = "SpecCnl/Report.lean";
const CORPUS_ROOT = "SpecCnl";
const lakeCommand = process.env.LEAN_LAKE?.trim() || "lake";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const formalRoot = resolve(scriptRoot, "../../formal");
const options = parseArguments(process.argv.slice(2));

// The mode is settled before anything is read, copied, or built: a run nobody consented to
// should cost nothing, and a refusal an operator can act on is one that arrives before a
// scratch ledger and a report have appeared beside it.
const credential = requireMode(options);

const owners = await RepositoryProofArtifactOwners.fromRepository();
const ledgerPath = runLedger(options);
const store = new FileProofRepairStore(ledgerPath);
const ledger = store.load();
const host = new ProofRepairHost(formalRoot, store, verifier(options), owners);
const objective = host.objectiveForUnits(options.corpus, ledger);

// What a candidate may rewrite is decided by the artifact policy, not by a name written
// here: every corpus source the policy admits is shown to the model with its current text,
// and everything else — the report, the corpus, the bridges, the grammar, the lakefile —
// is refused by that same policy before a proposal reaches an isolation.
const prompt = new ProofRepairPrompt(ledger.digest, objective, writableCorpusSources());
const exchange =
    options.replay === undefined ? await liveExchange(options) : replayExchange(options, prompt);
const generator = new ProofRepairModelGenerator(prompt, exchange, options.exchanges);

const result = host.repair(objective, generator, options.attempts);

const spend = exchange instanceof SpawnProofModelExchange ? exchange.spend() : undefined;
// `--record` needs a live run, and a live run names its model, so what is recorded is
// always the model that answered.
if (options.record !== undefined && options.model !== undefined) {
    await writeCanonicalJson(
        options.record,
        generator.recording(options.model, options.provenance).toData()
    );
}

await writeCanonicalJson(options.report, {
    edition: "1.0.0",
    outcome: result.name,
    attempts: result.attempts,
    declined: generator.declined() ?? null,
    ledger: portablePath(ledgerPath),
    corpus: portablePath(options.corpus),
    owed: objective.obligations.map((obligation) => obligation.describe()),
    refusals: [...result.refusals],
    accepted: result.ledger.closed.map((closed) => ({
        obligation: closed.obligation.describe(),
        candidate: closed.candidate,
        artifacts: [...closed.artifacts]
    })),
    // The accepted text is the thing a reviewer reads before it is promoted into `formal/`,
    // so the report carries it rather than pointing at a ledger the operator would then
    // have to decode.
    artifacts: result.ledger.artifacts.map((artifact) => ({
        path: artifact.path,
        digest: artifact.digest,
        text: artifact.text
    })),
    inconclusiveCandidate: result.inconclusiveCandidate ?? null,
    spend: spend ?? null,
    replay: options.replay === undefined ? null : portablePath(options.replay)
});

console.log(
    [
        `proof repair run ${result.name}: ${result.attempts} attempt(s) over ` +
            `${objective.obligations.length} owed obligation(s)`,
        ...result.refusals.map((refusal) => `  refused: ${refusal.split("\n")[0]}`),
        generator.declined() === undefined ? undefined : `  declined: ${generator.declined()}`,
        spend === undefined
            ? undefined
            : `  spend: ${spend.exchanges} exchange(s), ${spend.inputTokens} input and ` +
              `${spend.outputTokens} output token(s)`,
        `  ledger: ${portablePath(ledgerPath)}`,
        `  report: ${portablePath(options.report)}`,
        result.name === "accepted"
            ? "  promote by reviewing the accepted text in the report, copying it into " +
              "formal/, and rerunning with --ledger " +
              portablePath(proofRepairLedgerArtifact)
            : undefined
    ]
        .filter((line) => line !== undefined)
        .join("\n")
);
if (result.name !== "accepted") process.exitCode = 1;

/**
 * The reviewed corpus sources a candidate is allowed to rewrite, with their current text.
 *
 * A model asked for whole-file text needs the file it is rewriting, and the reviewed tree is
 * where that text lives: the committed ledger gate requires every accepted artifact to be
 * byte-identical to `formal/` at the same path, so the reviewed bytes and the accepted bytes
 * are the same bytes. Reading them here keeps the adapter away from the ledger entirely.
 */
function writableCorpusSources() {
    const root = join(formalRoot, CORPUS_ROOT);
    const sources = [];
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )) {
        if (!entry.isFile()) continue;
        const path = `${CORPUS_ROOT}/${entry.name}`;
        try {
            acceptedProofArtifact(path, "A corpus source");
        } catch {
            continue;
        }
        sources.push({ path, text: readFileSync(join(root, entry.name), "utf8") });
    }
    if (sources.length === 0) {
        throw new TypeError(`the corpus at ${portablePath(root)} carries no writable module`);
    }
    return sources;
}

/** The reviewed Lean verifier, over the audited declarations the corpus itself registers. */
function verifier(selected) {
    const corpus = JSON.parse(readFileSync(selected.corpus, "utf8"));
    const audited = corpus.auditedNames;
    if (!Array.isArray(audited) || audited.length === 0) {
        throw new TypeError(`${portablePath(selected.corpus)} registers no audited declarations`);
    }
    return new LeanProofCandidateVerification(
        new SpawnProofCommandRunner(),
        owners,
        new ProofCommand(lakeCommand, ["build", CORPUS_ROOT]),
        new ProofCommand(lakeCommand, ["env", "lean", CORPUS_ENTRY_MODULE]),
        audited,
        CORPUS_ENTRY_MODULE
    );
}

/**
 * The ledger this run publishes into.
 *
 * The default is an isolated copy of the committed record, seeded fresh on every run: an
 * acceptance is then a reviewable artifact rather than a surprise commit, and the committed
 * record keeps whatever the last reviewed acceptance left in it. An operator who means to
 * move the committed state says so with `--ledger`.
 */
function runLedger(selected) {
    if (selected.ledger !== undefined) return selected.ledger;
    const isolated = join(reportRoot, "proof-repair-run", "ledger.json");
    mkdirSync(dirname(isolated), { recursive: true });
    copyFileSync(proofRepairLedgerArtifact, isolated);
    return isolated;
}

/**
 * The one gate on what this run is allowed to do, and the credential a live run uses.
 *
 * A live run sends the corpus, the objective and the current proof text to a third-party
 * endpoint and pays for the answer, so it needs both halves: the operator's typed consent
 * and a credential. Neither implies the other — a credential lying in the environment is
 * not permission, and permission without a credential is not a run — and a replay is
 * neither, so it refuses consent rather than quietly accepting an argument that does
 * nothing.
 */
function requireMode(selected) {
    if (selected.replay !== undefined) {
        if (selected.consent !== undefined) {
            throw new TypeError("--replay reruns a recorded run, so it takes no consent");
        }
        return undefined;
    }
    if (selected.consent !== LIVE_CONSENT) {
        throw new TypeError(
            `a live model run requires --consent ${LIVE_CONSENT}; ` +
                "use --replay <recording> to rerun a recorded run with no network"
        );
    }
    const held = process.env[CREDENTIAL_ENVIRONMENT];
    if (held === undefined || held.length === 0) {
        throw new TypeError(
            `a live model run requires the credential in ${CREDENTIAL_ENVIRONMENT}; ` +
                "consent alone is not a run"
        );
    }
    if (selected.model === undefined) {
        throw new TypeError("a live model run requires --model <name>");
    }
    return held;
}

/** The live seam. Its credential is resolved per exchange and handed to the child on its
 * standard input; nothing here logs it, records it, or puts it in a process argument. */
async function liveExchange(selected) {
    if (credential === undefined) throw new TypeError("a live model run holds no credential");
    return new SpawnProofModelExchange({
        endpoint: selected.endpoint ?? (await modelEndpoint(selected)),
        model: selected.model,
        credential: () => credential,
        timeoutMs: selected.timeoutMs
    });
}

/** The endpoint, built by the harness's own helpers so this entry carries no second copy of
 * a provider route. The harness's built entry point is the supported consumer surface. */
async function modelEndpoint(selected) {
    const built = resolve(scriptRoot, "../../../agent-core-harness/dist/index.js");
    if (!existsSync(built)) {
        throw new TypeError(
            `the harness model port is not built at ${portablePath(built)}: ` +
                "run `pnpm --filter @agent-core/harness build`"
        );
    }
    const { aiGatewayEndpoint, workersAiEndpoint } = await import(pathToFileURL(built).href);
    if (selected.account === undefined) {
        throw new TypeError(
            "a live model run needs --endpoint <url>, or --account <id> for Workers AI, " +
                "or --account with --gateway and --provider for AI Gateway"
        );
    }
    if (selected.gateway === undefined && selected.provider === undefined) {
        return workersAiEndpoint(selected.account);
    }
    if (selected.gateway === undefined || selected.provider === undefined) {
        throw new TypeError("an AI Gateway endpoint needs both --gateway and --provider");
    }
    return aiGatewayEndpoint(selected.account, selected.gateway, selected.provider);
}

/** The recorded seam: the committed transcript of a previous run, and no network. */
function replayExchange(selected, asked) {
    const recording = ProofRepairModelRecording.read(
        readFileSync(selected.replay, "utf8"),
        portablePath(selected.replay)
    );
    return new RecordedProofModelExchange(recording, asked);
}

function parseArguments(args) {
    const selected = {
        attempts: 3,
        consent: undefined,
        corpus: cnlCorpusLedgerArtifact,
        endpoint: undefined,
        exchanges: undefined,
        account: undefined,
        gateway: undefined,
        ledger: undefined,
        model: undefined,
        provenance: "recorded by scripts/quality/proof-repair-run.mjs",
        provider: undefined,
        record: undefined,
        replay: undefined,
        report: join(reportRoot, "proof-repair-run.json"),
        timeoutMs: proofModelExchangeBudgetMs
    };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--consent") selected.consent = required(args, ++index, argument);
        else if (argument === "--model") selected.model = required(args, ++index, argument);
        else if (argument === "--endpoint") selected.endpoint = required(args, ++index, argument);
        else if (argument === "--account") selected.account = required(args, ++index, argument);
        else if (argument === "--gateway") selected.gateway = required(args, ++index, argument);
        else if (argument === "--provider") selected.provider = required(args, ++index, argument);
        else if (argument === "--attempts") {
            selected.attempts = count(required(args, ++index, argument), argument);
        } else if (argument === "--exchanges") {
            selected.exchanges = count(required(args, ++index, argument), argument);
        } else if (argument === "--timeout") {
            selected.timeoutMs = count(required(args, ++index, argument), argument) * 1000;
        } else if (argument === "--ledger") {
            selected.ledger = resolve(required(args, ++index, argument));
        } else if (argument === "--corpus") {
            selected.corpus = resolve(required(args, ++index, argument));
        } else if (argument === "--record") {
            selected.record = resolve(required(args, ++index, argument));
        } else if (argument === "--replay") {
            selected.replay = resolve(required(args, ++index, argument));
        } else if (argument === "--provenance") {
            selected.provenance = required(args, ++index, argument);
        } else if (argument === "--report") {
            selected.report = resolve(required(args, ++index, argument));
        } else throw new TypeError(`Unknown proof-repair-run argument ${argument}`);
    }
    if (selected.replay !== undefined && selected.record !== undefined) {
        throw new TypeError("--record writes what a live run heard, so it needs a live run");
    }
    // The exchange ceiling defaults to the attempt budget: the loop cannot ask more often
    // than it is allowed to attempt, and an operator who wants a tighter money bound than
    // that says so.
    selected.exchanges ??= selected.attempts;
    return selected;
}

function required(args, index, option) {
    const value = args[index];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    return value;
}

function count(value, option) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new TypeError(`${option} takes a positive whole number, not ${value}`);
    }
    return parsed;
}
