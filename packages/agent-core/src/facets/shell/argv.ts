/**
 * POSIX-ish argv parser for our shell.
 *
 * Fixes the structural bugs in minimist for our use-case:
 *
 * - `-name *.ts` is NOT parsed as `-n -a -m -e` when `name` is declared as a
 *   long-with-single-dash flag (what `find` needs).
 * - Unknown flags produce a clear error (strict mode), not silent truthy values.
 * - `-N` numeric shorthand for `head -3`, `tail -3`, `grep -A2` etc. is supported
 *   via a declared `numericShortcut` option or the `collectNumericShortcuts`
 *   pre-pass helper.
 * - Repeatable string flags (`-e p1 -e p2`) collect into an array when declared
 *   as `"stringArray"`.
 * - `--flag`, `--flag=val`, `--flag val`, `-f`, `-f val`, `-fval`, `-abc` are all
 *   handled per POSIX.
 */

export type FlagType =
	| "boolean"
	| "string"
	| "stringArray"
	| "number";

type FlagValue = boolean | string | string[] | number;

interface FlagSpecBase<Type extends FlagType, DefaultValue extends FlagValue | readonly string[]> {
	/** Canonical name on the result object. */
	name: string;
	/** Single-character aliases. Each char produces `-X`. */
	short?: readonly string[];
	/** Long aliases. Each entry accepts BOTH `--name` and `-name` (POSIX-ish). */
	long?: readonly string[];
	type: Type;
	/** Default value if flag is absent. */
	default?: DefaultValue;
	/**
	 * For flags like grep's `-A N` / `-B N` / `-C N` where `-A2` is valid shorthand.
	 * Only meaningful when `short` contains a single uppercase letter and type is "number".
	 */
	numericAttached?: boolean;
	/** Optional help string used by `--help`. */
	help?: string;
}

export type FlagSpec =
	| FlagSpecBase<"boolean", boolean>
	| FlagSpecBase<"string", string>
	| FlagSpecBase<"stringArray", readonly string[]>
	| FlagSpecBase<"number", number>;

type ParsedFlagValue<Spec extends FlagSpec> =
	Spec extends { type: "boolean" } ? boolean
		: Spec extends { type: "stringArray" } ? string[]
			: Spec extends { type: "string"; default: string } ? string
				: Spec extends { type: "string" } ? string | undefined
					: Spec extends { type: "number"; default: number } ? number
						: Spec extends { type: "number" } ? number | undefined
							: never;

export type ParsedFlags<Specs extends readonly FlagSpec[]> = {
	[Spec in Specs[number] as Spec["name"]]: ParsedFlagValue<Spec>;
};

export interface ArgvSpec<Flags extends readonly FlagSpec[] = readonly FlagSpec[]> {
	/** Command name (for error messages). */
	command: string;
	flags: Flags;
	/**
	 * If true, treat any token matching `/^-\d+$/` in the pre-pass as a shorthand
	 * for a declared numeric flag with `name === shorthandTarget`. Used by
	 * `head` / `tail` so `head -3` becomes `head -n 3`.
	 */
	numericShortcut?: { target: string };
	/**
	 * If true, unknown flags produce an error. Default true (strict). Set to
	 * false ONLY if a command genuinely accepts unknown args as positional
	 * pass-through (currently: none).
	 */
	strict?: boolean;
}

export interface ParsedArgv<Flags = Record<string, FlagValue | undefined>> {
	flags: Flags;
	positional: string[];
	error: string | undefined;
}

export function parseArgv<const Flags extends readonly FlagSpec[]>(
	argv: string[],
	spec: ArgvSpec<Flags>,
): ParsedArgv<ParsedFlags<Flags>> {
	const strict = spec.strict !== false;
	const flags: Record<string, FlagValue | undefined> = {};
	const positional: string[] = [];

	// Seed defaults
	for (const f of spec.flags) {
		if (f.default !== undefined) {
			flags[f.name] = f.type === "stringArray" ? [...f.default] : f.default;
		} else if (f.type === "boolean") {
			flags[f.name] = false;
		} else if (f.type === "stringArray") {
			flags[f.name] = [];
		}
	}

	// Build lookup tables
	const byShort = new Map<string, FlagSpec>();
	const byLong = new Map<string, FlagSpec>();
	for (const f of spec.flags) {
		for (const s of f.short ?? []) byShort.set(s, f);
		for (const l of f.long ?? []) byLong.set(l, f);
	}

	// Pre-pass: rewrite `-N` numeric shorthand if enabled.
	const tokens = spec.numericShortcut
		? rewriteNumericShortcut(argv, spec.numericShortcut.target)
		: argv.slice();

	let stopFlags = false;
	let i = 0;

	while (i < tokens.length) {
		const tok = tokens.at(i);
		if (tok === undefined) break;

		if (stopFlags || tok === "-" || !tok.startsWith("-")) {
			positional.push(tok);
			i++;
			continue;
		}

		if (tok === "--") {
			stopFlags = true;
			i++;
			continue;
		}

		// --long / --long=value
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
			const attached = eq === -1 ? undefined : tok.slice(eq + 1);
			const f = byLong.get(name);
			if (!f) {
				if (strict) return parsedResult(flags, spec.flags, positional, `${spec.command}: unrecognized option '--${name}'`);
				i++;
				continue;
			}
			const consumeErr = consumeFlag(f, attached, tokens, i, flags);
			if (typeof consumeErr === "string") return parsedResult(flags, spec.flags, positional, `${spec.command}: ${consumeErr}`);
			i = consumeErr;
			continue;
		}

		// Single-dash: either short cluster (-abc), short+value (-fvalue, -f value), or long-with-single-dash (-name)
		const body = tok.slice(1);

		// Long-with-single-dash first (gives `-name` priority over `-n -a -m -e`)
		const eq = body.indexOf("=");
		const longName = eq === -1 ? body : body.slice(0, eq);
		const longAttached = eq === -1 ? undefined : body.slice(eq + 1);
		const longSpec = byLong.get(longName);
		if (longSpec) {
			const consumeErr = consumeFlag(longSpec, longAttached, tokens, i, flags);
			if (typeof consumeErr === "string") return parsedResult(flags, spec.flags, positional, `${spec.command}: ${consumeErr}`);
			i = consumeErr;
			continue;
		}

		// Short flag with attached numeric value (e.g. `-A2` for grep)
		if (body.length >= 2) {
			const head = body.charAt(0);
			const rest = body.slice(1);
			const headSpec = byShort.get(head);
			if (headSpec && headSpec.numericAttached && /^\d+$/.test(rest)) {
				const err = consumeFlag(headSpec, rest, tokens, i, flags);
				if (typeof err === "string") return parsedResult(flags, spec.flags, positional, `${spec.command}: ${err}`);
				i = err;
				continue;
			}
		}

		// Short cluster
		let consumed = false;
		let j = 0;
		while (j < body.length) {
			const ch = body.charAt(j);
			const f = byShort.get(ch);
			if (!f) {
				if (strict) return parsedResult(flags, spec.flags, positional, `${spec.command}: invalid option -- '${ch}'`);
				j++;
				continue;
			}
			if (f.type === "boolean") {
				flags[f.name] = true;
				j++;
				continue;
			}
			// String/number — rest of cluster is the value, or next argv token
			const rest = body.slice(j + 1);
			if (rest.length > 0) {
				const err = consumeFlag(f, rest, tokens, i, flags);
				if (typeof err === "string") return parsedResult(flags, spec.flags, positional, `${spec.command}: ${err}`);
				i = err;
				consumed = true;
				break;
			} else {
				const err = consumeFlag(f, undefined, tokens, i, flags);
				if (typeof err === "string") return parsedResult(flags, spec.flags, positional, `${spec.command}: ${err}`);
				i = err;
				consumed = true;
				break;
			}
		}
		if (!consumed) i++;
	}

	return parsedResult(flags, spec.flags, positional, undefined);
}

function parsedResult<const Flags extends readonly FlagSpec[]>(
	flags: Record<string, FlagValue | undefined>,
	specs: Flags,
	positional: string[],
	error: string | undefined
): ParsedArgv<ParsedFlags<Flags>> {
	assertParsedFlags(flags, specs);
	return { flags, positional, error };
}

function assertParsedFlags<const Flags extends readonly FlagSpec[]>(
	flags: Record<string, FlagValue | undefined>,
	specs: Flags,
): asserts flags is ParsedFlags<Flags> {
	for (const spec of specs) {
		const value = flags[spec.name];
		if (spec.type === "boolean") {
			if (typeof value !== "boolean") throwInvalidFlagValue(spec);
		} else if (spec.type === "stringArray") {
			if (!isStringArray(value)) throwInvalidFlagValue(spec);
		} else if (spec.type === "string") {
			if (value === undefined && spec.default === undefined) continue;
			if (typeof value !== "string") throwInvalidFlagValue(spec);
		} else {
			if (value === undefined && spec.default === undefined) continue;
			if (typeof value !== "number") throwInvalidFlagValue(spec);
		}
	}
}

function isStringArray(value: FlagValue | undefined): value is string[] {
	if (!Array.isArray(value)) return false;
	return value.every((item) => typeof item === "string");
}

function throwInvalidFlagValue(spec: FlagSpec): never {
	throw new TypeError(`argv parser produced invalid value for flag '${spec.name}'`);
}

/**
 * Given a matching FlagSpec, consume its value (from `attached`, or the next
 * positional argv token) and advance `i`. Returns the new `i`, or a string
 * error message.
 */
function consumeFlag(
	f: FlagSpec,
	attached: string | undefined,
	tokens: string[],
	i: number,
	flags: Record<string, FlagValue | undefined>,
): number | string {
	if (f.type === "boolean") {
		if (attached !== undefined && attached !== "true" && attached !== "false" && attached !== "") {
			return `option '${f.name}' does not take a value`;
		}
		flags[f.name] = attached === "false" ? false : true;
		return i + 1;
	}

	let raw: string;
	let next = i + 1;
	if (attached !== undefined) {
		raw = attached;
	} else {
		const value = tokens.at(next);
		if (value === undefined) return `option '${f.name}' requires a value`;
		raw = value;
		next++;
	}

	if (f.type === "number") {
		const n = Number(raw);
		if (!Number.isFinite(n)) return `option '${f.name}' requires a numeric value, got '${raw}'`;
		flags[f.name] = n;
	} else if (f.type === "stringArray") {
		const existing = flags[f.name];
		if (Array.isArray(existing)) existing.push(raw);
		else flags[f.name] = [raw];
	} else {
		flags[f.name] = raw;
	}

	return next;
}

/**
 * Rewrites `-N` (digits) occurring as a standalone token into `-<target> N`.
 * So `head -3 file` becomes `head -n 3 file` when target is `n`. Only
 * the FIRST such occurrence is rewritten (matches real `head`/`tail` behavior).
 */
function rewriteNumericShortcut(argv: string[], target: string): string[] {
	const out: string[] = [];
	let rewrote = false;
	for (const tok of argv) {
		if (!rewrote && /^-\d+$/.test(tok)) {
			out.push(`-${target}`, tok.slice(1));
			rewrote = true;
			continue;
		}
		out.push(tok);
	}
	return out;
}
