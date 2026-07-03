import { parse as shellParse, type ParseEntry } from "shell-quote";

/**
 * Parser for our shell input.
 *
 * Pipeline:
 *   input → extractCmdSubs → extractRedirects → shell-quote → buildPipeline
 *
 * Layered on top of shell-quote:
 *   - Pipelines (`|`)
 *   - Redirects (`>`, `>>`, `<`, `2>`, `2>>`, `&>`) with general path targets
 *   - Command lists (`&&`, `||`, `;`) with short-circuit semantics in dispatch
 *   - Glob tokens preserved for deferred VFS expansion
 *   - Command substitutions `$(...)` stashed as nested tokens re-evaluated at dispatch
 *
 * Both preprocessors use control-character sentinels to stash their content as
 * opaque literal tokens that shell-quote passes through untouched.
 */

/** A raw argv entry — either a literal string or a deferred expansion. */
export type ArgToken =
	| { kind: "literal"; value: string }
	| { kind: "glob"; pattern: string }
	| { kind: "cmdsub"; command: string };

export interface ParsedCommand {
	argv: ArgToken[];
}

export interface Redirect {
	type: ">" | ">>" | "<" | "2>" | "2>>" | "&>";
	path: string;
}

export interface ParsedPipeline {
	commands: ParsedCommand[];
	redirects: Redirect[];
}

export type ListOperator = "&&" | "||" | ";";

export interface ParsedCommandList {
	segments: Array<{
		pipeline: ParsedPipeline;
		operator: ListOperator | null;
	}>;
}

type ShellQuoteEntry = ParseEntry | { op: "cmdsub"; pattern: string };

// ---------------------------------------------------------------------------
// Sentinel markers
//
// Each sentinel uses a control-character boundary (\x01 for cmdsub, \x02 for
// redirect) plus an alphanumeric body. The control chars make user collision
// essentially impossible — no legal shell input types \x01/\x02 — while the
// alphanumeric body survives shell-quote's tokenizer (any `>`/`<`/`|`/`&`
// inside would be re-interpreted as a shell operator). Verified at the CLI:
// shell-quote returns a single string token for both patterns.
// ---------------------------------------------------------------------------

const CMDSUB_PREFIX = "\x01CMDSUB";
const CMDSUB_SUFFIX = "END\x01";

// Redirect operators, longest-match first so `>>` isn't tokenized as `> >`.
// Each has a short alphanumeric code used inside the sentinel.
const REDIRECT_OPS: Array<{ op: Redirect["type"]; code: string }> = [
	{ op: "2>>", code: "2GG" },
	{ op: "2>", code: "2G" },
	{ op: "&>", code: "AG" },
	{ op: ">>", code: "GG" },
	{ op: ">", code: "G" },
	{ op: "<", code: "L" },
];
const REDIR_PREFIX = "\x02REDIR";
const REDIR_SUFFIX = "END\x02";
const REDIR_SENTINEL_RE = new RegExp(`^${REDIR_PREFIX}([A-Z0-9]+)${REDIR_SUFFIX}$`);
const CODE_TO_OP = new Map<string, Redirect["type"]>(REDIRECT_OPS.map((r) => [r.code, r.op]));

// ---------------------------------------------------------------------------
// Preprocessors
// ---------------------------------------------------------------------------

/**
 * Replace `$(...)` with opaque sentinels before shell-quote tokenizes, so it
 * doesn't see `$`/`(`/`)` as loose operators. Quote state is tracked to
 * preserve POSIX: single-quoted `$(...)` is literal, double-quoted expands.
 * Nested `$(a $(b))` is preserved verbatim in the outer payload and re-parsed
 * when dispatch recurses into the subcommand.
 */
function extractCmdSubs(input: string): { text: string; subs: string[] } {
	const subs: string[] = [];
	let out = "";
	let i = 0;
	const n = input.length;
	while (i < n) {
		const ch = input.charAt(i);

		if (ch === "'") {
			const end = input.indexOf("'", i + 1);
			if (end === -1) { out += input.slice(i); break; }
			out += input.slice(i, end + 1);
			i = end + 1;
			continue;
		}

		if (ch === '"') {
			out += ch;
			i++;
			while (i < n) {
				if (input.charAt(i) === "\\" && i + 1 < n) {
					out += input.charAt(i) + input.charAt(i + 1);
					i += 2;
					continue;
				}
				if (input.charAt(i) === "$" && input.charAt(i + 1) === "(") {
					const start = i + 2;
					let depth = 1;
					let j = start;
					while (j < n && depth > 0) {
						if (input.charAt(j) === "(") depth++;
						else if (input.charAt(j) === ")") depth--;
						if (depth === 0) break;
						j++;
					}
					if (depth !== 0) { out += input.slice(i); i = n; break; }
					subs.push(input.slice(start, j));
					out += `${CMDSUB_PREFIX}${subs.length - 1}${CMDSUB_SUFFIX}`;
					i = j + 1;
					continue;
				}
				out += input.charAt(i);
				if (input.charAt(i) === '"') { i++; break; }
				i++;
			}
			continue;
		}

		if (ch === "\\" && i + 1 < n) {
			out += input.charAt(i) + input.charAt(i + 1);
			i += 2;
			continue;
		}

		if (ch === "$" && input.charAt(i + 1) === "(") {
			const start = i + 2;
			let depth = 1;
			let j = start;
			while (j < n && depth > 0) {
				if (input.charAt(j) === "(") depth++;
				else if (input.charAt(j) === ")") depth--;
				if (depth === 0) break;
				j++;
			}
			if (depth !== 0) {
				out += input.slice(i);
				break;
			}
			subs.push(input.slice(start, j));
			out += ` ${CMDSUB_PREFIX}${subs.length - 1}${CMDSUB_SUFFIX} `;
			i = j + 1;
			continue;
		}

		out += ch;
		i++;
	}
	return { text: out, subs };
}

/**
 * Pre-process redirect operators before tokenization. Replaces every `>` /
 * `>>` / `<` / `2>` / `2>>` / `&>` that appears outside quotes with a sentinel
 * literal. shell-quote then tokenizes normally — the redirect target following
 * the sentinel is treated as any other argument (so `$VAR` expansion still
 * applies to the path).
 *
 * Previously we relied on shell-quote's fragile handling where `2>file` became
 * `["2", {op:">"}, "file"]` and `&>file` became `[{op:"&"}, {op:">"}, "file"]`.
 * That merging logic lived in `buildPipeline` and depended on shell-quote's
 * internal tokenization never changing. This pre-lexer decouples us entirely.
 */
function extractRedirects(input: string): string {
	let out = "";
	let i = 0;
	const n = input.length;
	while (i < n) {
		const ch = input.charAt(i);

		// Skip single-quoted strings verbatim — no escapes, no expansion inside.
		if (ch === "'") {
			const end = input.indexOf("'", i + 1);
			if (end === -1) { out += input.slice(i); break; }
			out += input.slice(i, end + 1);
			i = end + 1;
			continue;
		}

		// Skip double-quoted strings, honoring \" / \\ escapes. shell-quote will
		// re-parse them for $VAR expansion later.
		if (ch === '"') {
			out += ch;
			i++;
			while (i < n) {
				if (input.charAt(i) === "\\" && i + 1 < n) { out += input.charAt(i) + input.charAt(i + 1); i += 2; continue; }
				out += input.charAt(i);
				if (input.charAt(i) === '"') { i++; break; }
				i++;
			}
			continue;
		}

		// Escaped char outside quotes — pass through untouched.
		if (ch === "\\" && i + 1 < n) {
			out += input.charAt(i) + input.charAt(i + 1);
			i += 2;
			continue;
		}

		// Match redirect operator (longest-first).
		let matched: { op: Redirect["type"]; code: string } | null = null;
		for (const r of REDIRECT_OPS) {
			if (input.startsWith(r.op, i)) { matched = r; break; }
		}

		if (matched) {
			// Heredocs (`<<`) aren't supported — leave literal so a downstream layer
			// can emit a clear error. (None do today; agents would see a parser error.)
			// Pad with spaces so shell-quote tokenizes the sentinel as its own word
			// even when the caller wrote `>file` with no preceding space.
			out += ` ${REDIR_PREFIX}${matched.code}${REDIR_SUFFIX} `;
			i += matched.op.length;
			continue;
		}

		out += ch;
		i++;
	}
	return out;
}

function decodeCmdSub(token: string, subs: string[]): { kind: "literal"; value: string } | { kind: "cmdsub"; command: string } {
	const match = token.match(new RegExp(`^${CMDSUB_PREFIX}(\\d+)${CMDSUB_SUFFIX}$`));
	const index = match?.at(1);
	if (index !== undefined) {
		const command = subs.at(Number(index));
		if (command !== undefined) return { kind: "cmdsub", command };
	}
	return { kind: "literal", value: token };
}

function decodeRedirectOp(token: string): Redirect["type"] | null {
	const match = token.match(REDIR_SENTINEL_RE);
	if (!match) return null;
	const code = match.at(1);
	return code === undefined ? null : CODE_TO_OP.get(code) ?? null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function parseCommandList(input: string, env: Record<string, string> = {}): ParsedCommandList {
	const { text, subs } = extractCmdSubs(input);
	const rewired = extractRedirects(text);

	const tokens = shellParse(rewired, env);

	// Rehydrate cmdsub tokens inline so `buildPipeline` sees a structured marker.
	const hydrated: ShellQuoteEntry[] = tokens.map((t) => {
		if (typeof t !== "string") return t;
		const decoded = decodeCmdSub(t, subs);
		if (decoded.kind === "cmdsub") return { op: "cmdsub", pattern: decoded.command };
		return t;
	});

	const segments: ParsedCommandList["segments"] = [];
	let pipelineTokens: ShellQuoteEntry[] = [];

	const flush = (operator: ListOperator | null): void => {
		if (pipelineTokens.length === 0) return;
		segments.push({ pipeline: buildPipeline(pipelineTokens), operator });
		pipelineTokens = [];
	};

	for (const entry of hydrated) {
		if (typeof entry === "object" && "op" in entry) {
			if (entry.op === "&&" || entry.op === "||") { flush(entry.op); continue; }
			if (entry.op === ";") { flush(";"); continue; }
		}
		pipelineTokens.push(entry);
	}
	flush(null);

	if (segments.length === 0) throw new Error("Empty command");
	return { segments };
}

function buildPipeline(tokens: ShellQuoteEntry[]): ParsedPipeline {
	const commands: ParsedCommand[] = [];
	const redirects: Redirect[] = [];
	let current: ArgToken[] = [];

	const flushCmd = (): void => {
		if (current.length === 0) return;
		commands.push({ argv: current });
		current = [];
	};

	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i];

		if (typeof entry === "string") {
			// Redirect sentinel: next token is the target path.
			const redirOp = decodeRedirectOp(entry);
			if (redirOp) {
				const target = tokens[i + 1];
				if (typeof target !== "string") {
					throw new Error(`Redirect ${redirOp} requires a target file path`);
				}
				redirects.push({ type: redirOp, path: target });
				i++;
				continue;
			}
			current.push({ kind: "literal", value: entry });
			continue;
		}

		if (typeof entry === "object" && "op" in entry) {
			const op = entry.op;

			if (op === "|") { flushCmd(); continue; }

			// Glob tokens arrive as `{op: "glob", pattern: "..."}`
			if (op === "glob" && entry.pattern) {
				current.push({ kind: "glob", pattern: entry.pattern });
				continue;
			}

			// Synthetic cmdsub marker we inject during preprocessing
			if (op === "cmdsub" && entry.pattern !== undefined) {
				current.push({ kind: "cmdsub", command: entry.pattern });
				continue;
			}

			// `&` with no redirect partner — we don't support background jobs
			if (op === "&") {
				throw new Error("background jobs (trailing &) are not supported in this shell");
			}

			// Unknown op — stringify so the command can complain
			current.push({ kind: "literal", value: op });
			continue;
		}

		if (typeof entry === "object" && "comment" in entry) continue;
	}

	flushCmd();
	if (commands.length === 0) throw new Error("Empty command in pipeline");
	return { commands, redirects };
}
