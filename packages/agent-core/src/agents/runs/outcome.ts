import { isMember, type JsonValue } from "../../core";
import type { TerminalOutcome } from "./generated/turn-status/AgentCore/Extract/TurnStatus";

const TERMINAL_OUTCOMES = Object.freeze(["succeeded", "failed", "cancelled"] as const);

// The three terminal words are lowered by the TSLean compiler from
// `formal/AgentCore/Extract/TurnStatus.lean`, beside the Turn transition table that decides
// which status each one lands on; the array above is the listing this decoder validates
// against, and `test/agents/runs/turn-status-extraction.test.ts` holds the two together.
export type { TerminalOutcome };

export function requireTerminalOutcome(
    value: JsonValue | undefined,
    subject: string
): TerminalOutcome {
    if (isMember(TERMINAL_OUTCOMES, value)) return value;
    throw new TypeError(`${subject} is invalid`);
}
