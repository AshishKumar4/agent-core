import type { CommandFn } from "../types";
import { readTextFileForCmd, splitLines } from "../helpers";

/**
 * Minimal sed. Supports:
 *   s/pattern/replacement/[flags]   substitution (flags: g, i)
 *   [N]d                            delete (all lines, or the Nth line)
 *   [N]p                            print (with -n, only when explicitly requested)
 *   q                               quit
 *
 * Multiple expressions via `-e expr` (repeatable) or a single trailing expression.
 * `-i` writes back to the file. `-n` suppresses automatic pattern-space print.
 * `-E` / `-r` accepted and no-op (JS regex is already ERE-ish).
 */

type SedOp =
	| { type: "s"; re: RegExp; replacement: string }
	| { type: "d"; line: number | undefined }
	| { type: "p"; line: number | undefined }
	| { type: "q" };

function parseExpr(expr: string): SedOp | string {
	const trimmed = expr.trim();
	if (!trimmed) return "empty expression";

	// [N]d or [N]p or q
	const bare = trimmed.match(/^(\d+)?([dpq])$/);
	if (bare) {
		const [, nStr, cmd] = bare;
		const line = nStr ? Number(nStr) : undefined;
		if (cmd === "q") return { type: "q" };
		if (cmd === "d") return { type: "d", line };
		return { type: "p", line };
	}

	// s/pat/repl/flags
	if (trimmed.startsWith("s") && trimmed.length > 1) {
		const delim = trimmed.charAt(1);
		const parts: string[] = [];
		let cur = "";
		let escaped = false;
		for (let i = 2; i < trimmed.length; i++) {
			const c = trimmed.charAt(i);
			if (escaped) { cur += c; escaped = false; continue; }
			if (c === "\\") { escaped = true; cur += c; continue; }
			if (c === delim) { parts.push(cur); cur = ""; continue; }
			cur += c;
		}
		parts.push(cur);
		if (parts.length < 2) return `invalid s expression: ${expr}`;
		const pattern = parts.at(0) ?? "";
		const replacement = parts.at(1) ?? "";
		const fstr = parts[2] ?? "";
		let reFlags = "";
		if (fstr.includes("g")) reFlags += "g";
		if (fstr.includes("i")) reFlags += "i";
		let re: RegExp;
		try {
			re = new RegExp(pattern, reFlags);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return `invalid regex in '${expr}': ${msg}`;
		}
		return { type: "s", re, replacement };
	}

	return `unsupported expression: ${expr} (supported: s/../../, [N]d, [N]p, q)`;
}

export const cmdSed: CommandFn = async (ctx) => {
	let inPlace = false;
	let quiet = false;
	const exprs: string[] = [];
	const files: string[] = [];

	for (let i = 0; i < ctx.args.length; i++) {
		const arg = ctx.args.at(i);
		if (arg === undefined) continue;
		if (arg === "-i" || arg === "--in-place") { inPlace = true; continue; }
		if (arg === "-n" || arg === "--quiet" || arg === "--silent") { quiet = true; continue; }
		if (arg === "-E" || arg === "-r" || arg === "--regexp-extended") { continue; }
		if (arg === "-e" || arg === "--expression") {
			if (i + 1 >= ctx.args.length) { ctx.stderr.write("sed: option '-e' requires a value\n"); return 2; }
			exprs.push(ctx.args.at(++i) ?? "");
			continue;
		}
		if (arg === "-f" || arg === "--file") {
			ctx.stderr.write("sed: -f (script file) not supported in this shell\n");
			return 2;
		}
		if (arg.startsWith("-") && arg.length > 1 && arg !== "-") {
			ctx.stderr.write(`sed: unrecognized option '${arg}'\n`);
			return 2;
		}
		if (exprs.length === 0) { exprs.push(arg); continue; }
		files.push(arg);
	}

	if (exprs.length === 0) { ctx.stderr.write("sed: missing expression\n"); return 2; }
	if (inPlace && files.length === 0) { ctx.stderr.write("sed: -i requires a file operand (refusing to edit stdin in place)\n"); return 2; }

	const ops: SedOp[] = [];
	for (const expr of exprs) {
		const op = parseExpr(expr);
		if (typeof op === "string") { ctx.stderr.write(`sed: ${op}\n`); return 2; }
		ops.push(op);
	}

	// Returns null on abort so caller can propagate exit 130.
	const apply = (text: string): string | null => {
		const hadTrailingNewline = text.endsWith("\n");
		const lines = splitLines(text);
		const out: string[] = [];
		let quit = false;

		for (let i = 0; i < lines.length && !quit; i++) {
			if (ctx.signal.aborted) return null;

			let line: string | null = lines.at(i) ?? null;
			const lineNum = i + 1;

			for (const op of ops) {
				if (line === null) break;
				if (op.type === "s") {
					line = line.replace(op.re, op.replacement);
				} else if (op.type === "d") {
					if (op.line === undefined || op.line === lineNum) line = null;
				} else if (op.type === "p") {
					// `p` always prints the current pattern-space immediately.
					// Under -n this is the only output; under default mode it's
					// a *second* copy (matching real sed semantics).
					if (op.line === undefined || op.line === lineNum) out.push(line);
				} else if (op.type === "q") {
					quit = true;
				}
			}

			// Auto-print at end of cycle UNLESS -n was set.
			if (line !== null && !quiet) out.push(line);
		}

		if (out.length === 0) return "";
		return out.join("\n") + (hadTrailingNewline ? "\n" : "");
	};

	if (files.length === 0) {
		if (!ctx.stdin) { ctx.stderr.write("sed: missing file operand\n"); return 2; }
		const result = apply(await ctx.stdin.readAll());
		if (result === null) return 130;
		ctx.stdout.write(result);
		return 0;
	}

	let exit = 0;
	for (const f of files) {
		const content = await readTextFileForCmd(ctx, f, "sed");
		if (content === null) { exit = 1; continue; }
		const result = apply(content);
		if (result === null) return 130;
		if (inPlace) {
			try { await ctx.vfs.writeFile(f, result); }
			catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				ctx.stderr.write(`sed: ${f}: ${msg}\n`);
				exit = 1;
			}
		} else {
			ctx.stdout.write(result);
		}
	}
	return exit;
};
