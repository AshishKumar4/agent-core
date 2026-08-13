import { isMember, type JsonValue } from "../../core";

const TERMINAL_OUTCOMES = Object.freeze(["succeeded", "failed", "cancelled"] as const);

export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

export function requireTerminalOutcome(
    value: JsonValue | undefined,
    subject: string
): TerminalOutcome {
    if (isMember(TERMINAL_OUTCOMES, value)) return value;
    throw new TypeError(`${subject} is invalid`);
}
