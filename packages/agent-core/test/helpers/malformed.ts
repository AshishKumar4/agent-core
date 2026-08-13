import type { JsonValue } from "../../src/core";

/**
 * Labels a JSON value as a domain type it demonstrably is not, so a guard that must
 * reject it can be called at all.
 *
 * Constructors and intent builders validate their arguments at runtime because callers
 * reach them across encoding boundaries, where a raw string or number arrives in place of
 * a branded identity. A test that the validation fires has to present exactly that value,
 * which the parameter type forbids by construction. Naming the demanded type at the call
 * site — `malformed<ContentRef>("invalid")` — says which contract is being violated and
 * keeps the violation to this one place.
 *
 * This is for values the type system cannot express, not for ones it merely infers
 * differently: where a wrong value already type-checks, pass it directly.
 */
export function malformed<Target>(value: JsonValue): Target {
    // SAFETY: the returned value is deliberately not a Target — that is the point of the
    // call. Every caller passes it straight to a guard asserted to reject it, so nothing
    // downstream reads it as a Target.
    return value as Target;
}

/**
 * A valid record with named fields replaced by values its contract forbids.
 *
 * Discriminated intent unions pin fields such as `impact` to one literal per member, so a
 * record carrying the wrong one names no member and cannot be written down. Starting from
 * a record that does type-check and naming only the fields to violate keeps the rest of it
 * checked against the real contract, and leaves the test reading as the single deviation
 * it is asserting on.
 */
export function violating<Target>(
    base: Target,
    violations: Partial<Record<keyof Target & string, JsonValue>>
): Target {
    // SAFETY: the result is a Target in every field except the ones just overwritten with
    // values the contract forbids. It exists to be handed to the validator that must
    // reject it, and is never read as a well-formed Target.
    return { ...base, ...violations } as Target;
}
