/**
 * Minimal awk. Adapted from LIFO OS (`packages/core/src/commands/text/awk.ts`,
 * MIT-licensed) with the same restrictions:
 *
 *   - /pattern/ { action }  per-line rules
 *   - BEGIN { action }      run once before any input
 *   - END   { action }      run once after all input
 *   - print, print $N       field emit ($0 = line, $1.. fields, NF, NR)
 *
 * No variable assignment, no control flow, no user functions. Agents that
 * need real awk expressiveness should write the equivalent as a sed/cut/sort
 * pipeline or ask for a heavier command later.
 */

import type { CommandFn } from "../types";
import { collectTextInput, splitLines } from "../helpers";

interface AwkRule { pattern: RegExp | "BEGIN" | "END" | null; action: string; }

function parseProgram(program: string): AwkRule[] {
	const rules: AwkRule[] = [];
	let remaining = program.trim();

	while (remaining.length > 0) {
		remaining = remaining.trim();
		if (remaining.length === 0) break;

		let pattern: RegExp | "BEGIN" | "END" | null = null;
		let action = "";

		if (remaining.startsWith("BEGIN")) { pattern = "BEGIN"; remaining = remaining.slice(5).trim(); }
		else if (remaining.startsWith("END")) { pattern = "END"; remaining = remaining.slice(3).trim(); }
		else if (remaining.startsWith("/")) {
			const end = remaining.indexOf("/", 1);
			if (end > 0) {
				try { pattern = new RegExp(remaining.slice(1, end)); } catch { pattern = null; }
				remaining = remaining.slice(end + 1).trim();
			}
		}

		if (remaining.startsWith("{")) {
			let depth = 0;
			let i = 0;
			for (; i < remaining.length; i++) {
				if (remaining.charAt(i) === "{") depth++;
				else if (remaining.charAt(i) === "}") { depth--; if (depth === 0) break; }
			}
			action = remaining.slice(1, i).trim();
			remaining = remaining.slice(i + 1).trim();
		} else if (pattern === null) {
			action = remaining;
			remaining = "";
		}

		rules.push({ pattern, action });
	}

	return rules;
}

function evalExpr(expr: string, fields: string[], line: string, nr: number, nf: number): string {
	const e = expr.trim();
	if (e.startsWith('"') && e.endsWith('"')) {
		return e.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t");
	}
	if (e.startsWith("$")) {
		const rest = e.slice(1);
		if (rest === "NF") return fields[nf - 1] ?? "";
		const n = parseInt(rest, 10);
		if (n === 0) return line;
		return fields[n - 1] ?? "";
	}
	if (e === "NR") return String(nr);
	if (e === "NF") return String(nf);
	return e;
}

function executeAction(action: string, fields: string[], line: string, nr: number, nf: number): string {
	const out: string[] = [];
	const statements = action.split(";").map((s) => s.trim()).filter(Boolean);
	for (const stmt of statements) {
		if (stmt === "print" || stmt === "print $0") {
			out.push(line);
		} else if (stmt.startsWith("print ")) {
			const rest = stmt.slice(6).trim();
			const parts = rest.split(",").map((p) => p.trim());
			out.push(parts.map((p) => evalExpr(p, fields, line, nr, nf)).join(" "));
		}
	}
	return out.join("\n");
}

export const cmdAwk: CommandFn = async (ctx) => {
	let fieldSepStr = " ";
	let fieldSep: RegExp = /\s+/;
	let program = "";
	const files: string[] = [];

	for (let i = 0; i < ctx.args.length; i++) {
		const a = ctx.args.at(i);
		if (a === undefined) continue;
		if (a === "-F" && i + 1 < ctx.args.length) {
			fieldSepStr = ctx.args.at(++i) ?? "";
			fieldSep = new RegExp(fieldSepStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		} else if (a.startsWith("-F") && a.length > 2) {
			fieldSepStr = a.slice(2);
			fieldSep = new RegExp(fieldSepStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		} else if (!program) {
			program = a;
		} else {
			files.push(a);
		}
	}
	if (!program) { ctx.stderr.write("awk: missing program\n"); return 1; }

	const text = await collectTextInput(ctx, files, "awk");
	if (text === null) return 1;

	const rules = parseProgram(program);
	const lines = splitLines(text);

	for (const r of rules) {
		if (r.pattern === "BEGIN") {
			const out = executeAction(r.action, [], "", 0, 0);
			if (out) ctx.stdout.write(out + "\n");
		}
	}

	for (let i = 0; i < lines.length; i++) {
		if (ctx.signal.aborted) return 130;
		const line = lines.at(i);
		if (line === undefined) continue;
		const fields = line.split(fieldSep).filter((f) => f !== "");
		const nr = i + 1;
		const nf = fields.length;
		for (const r of rules) {
			if (r.pattern === "BEGIN" || r.pattern === "END") continue;
			const matches = r.pattern instanceof RegExp ? r.pattern.test(line) : true;
			if (matches) {
				const out = executeAction(r.action, fields, line, nr, nf);
				if (out) ctx.stdout.write(out + "\n");
			}
		}
	}

	for (const r of rules) {
		if (r.pattern === "END") {
			const out = executeAction(r.action, [], "", lines.length, 0);
			if (out) ctx.stdout.write(out + "\n");
		}
	}

	return 0;
};
