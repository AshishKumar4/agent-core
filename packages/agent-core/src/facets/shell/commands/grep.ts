import type { CommandFn } from "../types";
import picomatch from "picomatch";
import { parseArgv } from "../argv";
import { escapeRegex, expensiveMountAdvisory, isImplicitRoot, readTextFileForCmd, vfsErrorMessage, walkFiltered } from "../helpers";
import { isBinaryFile } from "../mime";

export const cmdGrep: CommandFn = async (ctx) => {
	const { flags, positional, error } = parseArgv(ctx.args, {
		command: "grep",
		flags: [
			{ name: "recursive", short: ["r", "R"], long: ["recursive"], type: "boolean" },
			{ name: "ignoreCase", short: ["i"], long: ["ignore-case"], type: "boolean" },
			{ name: "lineNumber", short: ["n"], long: ["line-number"], type: "boolean" },
			{ name: "count", short: ["c"], long: ["count"], type: "boolean" },
			{ name: "filesWithMatches", short: ["l"], long: ["files-with-matches"], type: "boolean" },
			{ name: "invert", short: ["v"], long: ["invert-match"], type: "boolean" },
			{ name: "extended", short: ["E"], long: ["extended-regexp"], type: "boolean" },
			{ name: "fixedStrings", short: ["F"], long: ["fixed-strings"], type: "boolean" },
			{ name: "wordRegexp", short: ["w"], long: ["word-regexp"], type: "boolean" },
			{ name: "lineRegexp", short: ["x"], long: ["line-regexp"], type: "boolean" },
			{ name: "onlyMatching", short: ["o"], long: ["only-matching"], type: "boolean" },
			{ name: "quiet", short: ["q"], long: ["quiet", "silent"], type: "boolean" },
			{ name: "withFilename", short: ["H"], long: ["with-filename"], type: "boolean" },
			{ name: "noFilename", short: ["h"], long: ["no-filename"], type: "boolean" },
			{ name: "after", short: ["A"], long: ["after-context"], type: "number", default: 0, numericAttached: true },
			{ name: "before", short: ["B"], long: ["before-context"], type: "number", default: 0, numericAttached: true },
			{ name: "context", short: ["C"], long: ["context"], type: "number", default: 0, numericAttached: true },
			{ name: "maxCount", short: ["m"], long: ["max-count"], type: "number", default: 0 },
			{ name: "patterns", short: ["e"], long: ["regexp"], type: "stringArray", default: [] },
			{ name: "include", long: ["include"], type: "string", default: "" },
			{ name: "excludeDir", long: ["exclude-dir"], type: "string", default: "" },
			{ name: "pcre", short: ["P"], long: ["perl-regexp"], type: "boolean" },
		],
	});
	if (error) { ctx.stderr.write(error + "\n"); return 2; }

	if (flags.pcre) {
		ctx.stderr.write("grep: PCRE (-P) is not supported by this shell; JS regex (ERE-compatible) is the default. Most PCRE features (\\d, \\s, \\w) work as-is.\n");
		return 2;
	}

	// Gather patterns: every -e entry, OR the first positional if no -e given
	const patterns: string[] = [...flags.patterns];
	let argPaths: string[] = positional;
	if (patterns.length === 0) {
		if (positional.length === 0) { ctx.stderr.write("grep: missing pattern\n"); return 2; }
		patterns.push(positional.at(0) ?? "");
		argPaths = positional.slice(1);
	}

	// Build the regex
	const reFlags = flags.ignoreCase ? "gi" : "g";
	const pieces = patterns.map((p) => flags.fixedStrings ? escapeRegex(p) : p);
	let combined = pieces.length === 1 ? pieces.at(0) ?? "" : pieces.map((p) => `(?:${p})`).join("|");
	if (flags.wordRegexp) combined = `\\b(?:${combined})\\b`;
	if (flags.lineRegexp) combined = `^(?:${combined})$`;

	let re: RegExp;
	try {
		re = new RegExp(combined, reFlags);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		ctx.stderr.write(`grep: invalid regex '${patterns.join("|")}': ${msg}\n`);
		return 2;
	}

	// Context settings (-C applies to both -A and -B if the specific ones aren't set)
	const after = flags.after || flags.context || 0;
	const before = flags.before || flags.context || 0;
	const maxPerFile = flags.maxCount > 0 ? flags.maxCount : Infinity;

	// Filename prefix rules:
	//   -H forces on, -h forces off, otherwise on when there are >1 sources or any recursive walk
	const multiSource = flags.recursive || argPaths.length > 1;
	const showPrefix = flags.withFilename ? true : flags.noFilename ? false : multiSource;

	const includeMatch = flags.include ? picomatch(flags.include) : null;
	const excludeDirMatch = flags.excludeDir ? picomatch(flags.excludeDir) : null;

	let anyMatch = false;

	const emitMatch = (
		file: string | null,
		lineNum: number,
		line: string,
		marker: string,
	): void => {
		if (flags.quiet) return;
		if (flags.filesWithMatches) return; // handled per-file
		if (flags.count) return;             // handled per-file
		let out = "";
		if (showPrefix && file) out += `${file}${marker}`;
		if (flags.lineNumber) out += `${lineNum}${marker}`;
		if (flags.onlyMatching) {
			// Emit each match on its own line
			re.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = re.exec(line)) !== null) {
				ctx.stdout.write(`${out}${m[0]}\n`);
				if (m.index === re.lastIndex) re.lastIndex++;
			}
		} else {
			ctx.stdout.write(`${out}${line}\n`);
		}
	};

	const grepOneFile = async (file: string | null, content: string): Promise<void> => {
		const lines = content.split("\n");
		// Drop phantom trailing empty from trailing newline
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

		let fileMatches = 0;
		let pendingAfter = 0;
		let lastEmittedIdx = -1;

		for (let i = 0; i < lines.length; i++) {
			// ReDoS bound: per-line signal check caps runaway regex cost.
			if (ctx.signal.aborted) return;

			const line = lines.at(i);
			if (line === undefined) continue;
			re.lastIndex = 0;
			const matches = re.test(line);
			const include = flags.invert ? !matches : matches;

			if (include) {
				anyMatch = true;
				fileMatches++;

				if (flags.filesWithMatches) {
					if (file && !flags.quiet) ctx.stdout.write(`${file}\n`);
					return;
				}

				if (before > 0 || after > 0) {
					if (lastEmittedIdx >= 0 && i - before > lastEmittedIdx + 1) {
						if (!flags.quiet && !flags.count) ctx.stdout.write("--\n");
					}
					const ctxStart = Math.max(0, i - before, lastEmittedIdx + 1);
					for (let j = ctxStart; j < i; j++) {
						const contextLine = lines.at(j);
						if (contextLine === undefined) continue;
						emitMatch(file, j + 1, contextLine, "-");
						lastEmittedIdx = j;
					}
				}

				emitMatch(file, i + 1, line, ":");
				lastEmittedIdx = i;
				pendingAfter = after;

				if (fileMatches >= maxPerFile) break;
				if (flags.quiet) return;
			} else if (pendingAfter > 0) {
				emitMatch(file, i + 1, line, "-");
				lastEmittedIdx = i;
				pendingAfter--;
			}
		}

		if (flags.count && !flags.quiet) {
			const prefix = showPrefix && file ? `${file}:` : "";
			ctx.stdout.write(`${prefix}${fileMatches}\n`);
		}
	};

	const grepStdin = async (): Promise<void> => {
		if (!ctx.stdin) return;
		const content = await ctx.stdin.readAll();
		await grepOneFile(null, content);
	};

	const grepOnePath = async (p: string): Promise<void> => {
		// Recursive walks already filtered binaries implicitly — here we silently
		// skip binary files so `grep -r pattern .` doesn't spam warnings.
		if (isBinaryFile(p)) return;
		const content = await readTextFileForCmd(ctx, p, "grep");
		if (content === null) return;
		await grepOneFile(p, content);
	};

	if (argPaths.length === 0) {
		if (!ctx.stdin) { ctx.stderr.write("grep: no input files\n"); return 2; }
		await grepStdin();
		return anyMatch ? 0 : 1;
	}

	if (flags.recursive) {
		// One advisory set across the whole -r invocation: if the agent passed
		// `. memory/` we don't want the advisory fired twice from separate walks.
		const advised = new Set<string>();
		const emitAdvisory = (mount: string) => {
			if (advised.has(mount)) return;
			advised.add(mount);
			ctx.stderr.write(expensiveMountAdvisory("grep", mount));
		};
		for (const root of argPaths) {
			const implicitRoot = isImplicitRoot(root);
			for await (const entry of walkFiltered(ctx.vfs, root, {
				excludeDir: excludeDirMatch ?? undefined,
				includeFile: includeMatch ?? undefined,
				signal: ctx.signal,
				excludeMounts: implicitRoot ? ctx.expensivePaths : undefined,
				onExcludeMount: implicitRoot ? emitAdvisory : undefined,
			})) {
				await grepOnePath(entry.path);
			}
		}
	} else {
		for (const p of argPaths) {
			if (ctx.signal.aborted) return 130;
			try {
				const st = await ctx.vfs.stat(p);
				if (st.isDirectory()) {
					ctx.stderr.write(`grep: ${p}: Is a directory\n`);
					continue;
				}
			} catch (e) {
				ctx.stderr.write(`grep: ${vfsErrorMessage(e, p)}\n`);
				continue;
			}
			await grepOnePath(p);
		}
	}

	return anyMatch ? 0 : 1;
};
