// One model exchange, in its own process.
//
// The proof synthesis loop is synchronous — the host returns a decision, the store commits
// inside one span, and the Lean verifier is a `spawnSync` away — while every network client
// in this repository, including the harness's OpenAI-compatible model port, is `async`.
// This entry is the bridge: the adapter writes one request to its standard input, this
// process performs the one asynchronous completion through the harness's own provider, and
// writes one reply record to its standard output. Nothing here decides anything about a
// candidate; it does not even know what a candidate is.
//
// Two properties are deliberate. The credential arrives on standard input rather than in an
// argument vector or an environment block, so it is not readable from the process table.
// And the harness's *built* entry point is what gets imported: `dist/index.js` is the one
// supported consumer surface of that package, and plain Node cannot load its TypeScript
// sources at all — they use constructor parameter properties, which type stripping refuses.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertObject, assertString, parseCanonicalJson } from "./project.mjs";

const harnessEntry = resolve(import.meta.dirname, "../../../agent-core-harness/dist/index.js");

if (!existsSync(harnessEntry)) {
    process.stderr.write(
        `the harness model port is not built at ${harnessEntry}: ` +
            "run `pnpm --filter @agent-core/harness build`\n"
    );
    process.exit(2);
}

const request = assertObject(
    parseCanonicalJson(readFileSync(0, "utf8"), "the model exchange request"),
    "the model exchange request"
);
const credential = assertString(request.credential, "the model exchange credential");
const endpoint = assertString(request.endpoint, "the model exchange endpoint");
const model = assertString(request.model, "the model exchange model");
const instructions = assertString(request.instructions, "the model exchange instructions");
const text = assertString(request.text, "the model exchange text");
const timeoutMs = request.timeoutMs;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`the model exchange budget is not a duration: ${timeoutMs}`);
}

const { OpenAiCompatibleModelProvider, Transcript, UserMessage } = await import(
    pathToFileURL(harnessEntry).href
);

const provider = new OpenAiCompatibleModelProvider({
    endpoint,
    model,
    credential: async () => credential,
    fetch: globalThis.fetch
});

// A model that refuses, rate-limits, or cannot be reached is a failed exchange, not a
// failed process: the adapter turns the named failure into a declined turn, and the loop
// reports that it reached no verdict rather than inventing a candidate. Only a broken
// invocation — an unreadable request, a missing build — exits nonzero.
try {
    const completion = await provider.complete({
        transcript: new Transcript(instructions, [new UserMessage(text)]),
        tools: [],
        signal: AbortSignal.timeout(timeoutMs)
    });
    process.stdout.write(
        `${JSON.stringify({ text: completion.message.text, usage: completion.usage })}\n`
    );
} catch (error) {
    const failure =
        error instanceof Error
            ? `${"code" in error ? `${error.code}: ` : ""}${error.message}`
            : "the exchange failed with no diagnostic";
    process.stdout.write(`${JSON.stringify({ failure })}\n`);
}
