import type { JsonValue } from "../../core";

const TERMINAL_OUTCOMES = Object.freeze(["succeeded", "failed", "cancelled"] as const);

export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

export function requireTerminalOutcome(
    value: JsonValue | undefined,
    subject: string
): TerminalOutcome {
    if (typeof value === "string" && TERMINAL_OUTCOMES.includes(value as TerminalOutcome)) {
        return value as TerminalOutcome;
    }
    throw new TypeError(`${subject} is invalid`);
}
