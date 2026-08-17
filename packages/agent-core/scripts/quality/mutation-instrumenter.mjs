// The mutants a Stryker run of one file would contain, without running a test.
//
// The equivalence register anchors a proof to (file, symbol, mutator, replacement, the
// exact source the mutator replaces). Three of those five the working tree can answer on
// its own; `mutator` and `replacement` it cannot, because whether a mutator applies to a
// node is a property of Stryker's mutators and not of the source. An audit that checks
// only the source text therefore accepts an anchor at a node no mutator will ever touch —
// which is how `src/actors/id.ts#isExactActorId ConditionalExpression -> true @
// isObjectRecord(value)` passed every gate while a real run reported it stale. The
// refactor that produced `isObjectRecord(value)` turned two boolean operands into one call
// expression, and `ConditionalExpression` mutates boolean expressions and the tests of
// conditions, never a call.
//
// So the mutators are asked. Reimplementing them here was the alternative and it is not
// one: the register names thirteen of them, several of which compute their replacement
// from the node (`MethodExpression`, `Regex`, `ArrayDeclaration`), and a restatement that
// drifted from the installed Stryker would silently weaken the very check it exists to
// make. Stryker's instrumenter is the mutant generator itself, it is a library, and
// generating mutants is the half of a run that needs no test runner, no sandbox and no
// subprocess: 78 registered files enumerate in about 2.5 seconds.
import { Instrumenter } from "@stryker-mutator/instrumenter";
import strykerConfig from "../../stryker.conf.mjs";

// What core passes: `{ ignorers, ...options.mutator }`, over Stryker's own defaults for
// the two settings that decide which mutants exist. `noHeader` is a printing option and
// this never prints.
const MUTATOR_DEFAULTS = { plugins: null, excludedMutations: [] };

/**
 * The instrumenter reports through a logger and never through a return value, so a
 * discarded warning is a mutant set quietly measured against something other than what
 * this claims. At 9.6.1 it logs only progress, on `debug` and `info`; anything louder is
 * new and is a finding rather than a line of output nobody reads.
 */
const logger = {
    isTraceEnabled: () => false,
    isDebugEnabled: () => false,
    isInfoEnabled: () => false,
    isWarnEnabled: () => true,
    isErrorEnabled: () => true,
    isFatalEnabled: () => true,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (message) => raise("warn", message),
    error: (message) => raise("error", message),
    fatal: (message) => raise("fatal", message)
};

let instrumenter;
let options;

/**
 * Every mutant Stryker would generate for `text` at `file`, in the location convention of
 * the JSON report — 1-based line and column — so one predicate resolves an anchor against
 * a run's report and against the working tree alike. Statuses are absent by construction:
 * whether a mutant survives is what a run is for.
 */
export async function generatedMutants(file, text) {
    instrumenter ??= new Instrumenter(logger);
    const result = await instrumenter.instrument(
        [{ name: file, mutate: true, content: text }],
        (options ??= mutatorOptions())
    );
    return result.mutants.map((mutant) => ({
        mutatorName: mutant.mutatorName,
        replacement: mutant.replacement,
        location: {
            start: reportPosition(mutant.location.start),
            end: reportPosition(mutant.location.end)
        }
    }));
}

/**
 * The settings the measured run instruments with, read from its own configuration so the
 * two cannot drift. `ignorers` names plugins only Stryker's plugin loader can construct,
 * so one declared here would mean this enumerates mutants the run would suppress; that is
 * a refusal rather than a silent difference.
 */
function mutatorOptions() {
    if (strykerConfig.ignorers !== undefined) {
        throw new TypeError(
            "stryker.conf.mjs declares ignorers, which mutant enumeration cannot construct: " +
                "an anchor audit would then admit mutants the measured run suppresses."
        );
    }
    return { ...MUTATOR_DEFAULTS, ...strykerConfig.mutator, ignorers: [] };
}

// Stryker's API location is 0-based in both axes ("Stryker works 0-based internally");
// its JSON report is 1-based in both, which is what the register was written against.
function reportPosition(position) {
    return { line: position.line + 1, column: position.column + 1 };
}

function raise(level, message) {
    throw new TypeError(`Stryker instrumenter reported ${level}: ${message}`);
}
