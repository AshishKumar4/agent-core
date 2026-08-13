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
 * A record that deviates from its contract in exactly the ways named: fields holding
 * values the contract forbids, fields it never declared, or — by passing a base that is
 * missing them — fields it requires.
 *
 * Discriminated unions pin fields such as `impact` or a snapshot `version` to one literal
 * per member, so a record carrying the wrong one names no member and cannot be written
 * down. Starting from a record that does type-check keeps everything else checked against
 * the real contract, and leaves the test reading as the deviation it is asserting on.
 */
/**
 * A record's fields carried on a function rather than on a plain object.
 *
 * A decoder that reads fields without first establishing what it was handed accepts one
 * of these, because a function carries properties and answers `typeof` as its own kind.
 * Nothing well-typed can supply one where a record is required.
 */
export function callableRecord<Target>(container: () => void): Target {
    // SAFETY: a function is not the record type it stands in for. It reaches only decoders
    // asserted to reject it, and is never read as a Target.
    return container as Target;
}

export function violating<Target>(
    base: Partial<Target>,
    violations: Readonly<Record<string, JsonValue>> = {}
): Target {
    // SAFETY: the result is a Target apart from the deviations just named, which the
    // contract forbids. It exists to be handed to the validator that must reject it, and
    // is never read as a well-formed Target.
    return { ...base, ...violations } as Target;
}
