import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "@agent-core/core/content";
import type { ContentRef } from "@agent-core/core/core";
import type {
    TurnBoundOperation,
    TurnModelCall,
    TurnModelUsage
} from "@agent-core/core/agents/runs";
import { HarnessError } from "../src/error.js";
import { ModelProvider } from "../src/model/provider.js";
import { TranscriptTurnModelPort } from "../src/model/port.js";
import { boundOperation, modelCall } from "./fixture.js";
import { Transcript, TranscriptCodec, UserMessage } from "../src/transcript.js";

/**
 * The `model.inference` service contract from `packages/agent-core/artifacts/service-contracts.json`.
 *
 * The runtime's seam onto a third-party inference service is `TranscriptTurnModelPort`
 * over a `ModelProvider`: the port renders one committed Transcript into a request, the
 * provider carries it across the boundary, and the port validates the reply against the
 * tool vocabulary the request declared. This module is the executable half of that
 * contract, and it is deliberately shaped the way `AgentCore.Substrate`'s law sets are:
 * a closed operation vocabulary, a closed reply vocabulary in which a service failure is
 * a value rather than a throw, and one parameterised body every implementation answers.
 *
 * The adapters throw. That is not a disagreement with the model — it is the same
 * arrangement the substrate contracts record, where `LocalStoreReply.refused` is a value
 * in Lean and `AgentCoreError` is a throw in TypeScript. `serviceReply` below is the
 * correspondence, and it is total: every throw the protocol declares becomes exactly one
 * reply value, and anything undeclared becomes `indeterminate` rather than being dressed
 * up as a refusal the service never gave.
 */

/**
 * The closed operation vocabulary. One operation, because the seam offers one: a
 * completion over a rendered Transcript. Streaming is not in this vocabulary and the
 * artifact records why — `OpenAiCompatibleModelProvider` reads `response.text()` whole,
 * so a streamed endpoint is not reachable through this adapter at all.
 */
export const MODEL_SERVICE_OPERATIONS = Object.freeze(["complete"] as const);

export type ModelServiceOperation = (typeof MODEL_SERVICE_OPERATIONS)[number];

/**
 * The closed refusal vocabulary: the service was reached and its answer is a failure.
 * Every code is a `HarnessErrorCode`, which the harness owns because the kernel's
 * `AgentCoreErrorCode` is closed and carries no model-provider case.
 */
export const MODEL_SERVICE_REFUSALS = Object.freeze([
    "model.malformed-response",
    "model.rejected",
    "model.unavailable",
    "model.unknown-tool"
] as const);

export type ModelServiceRefusalCode = (typeof MODEL_SERVICE_REFUSALS)[number];

/**
 * The closed request-refusal vocabulary: the request was not renderable, so nothing
 * crossed the boundary. Separated from `refused` because the two carry different
 * obligations — an unsendable request has no service answer to reconcile against, and the
 * contract asserts that the transport was never reached.
 */
export const MODEL_SERVICE_UNSENDABLE = Object.freeze(["transcript.invalid"] as const);

export type ModelServiceUnsendableCode = (typeof MODEL_SERVICE_UNSENDABLE)[number];

/**
 * The closed vocabulary of ways this service can fail — the refusals plus the one
 * request-side refusal. It is a vocabulary of its own rather than just the code set
 * because a taxonomy keyed by code can only claim that every code is reachable, and the
 * claim that closes a taxonomy is that every declared way of failing reaches one.
 */
export const MODEL_SERVICE_FAILURES = Object.freeze([
    "model.malformed-response",
    "model.rejected",
    "model.unavailable",
    "model.unknown-tool",
    "transcript.invalid"
] as const);

/**
 * The closed reply vocabulary. Five kinds, and the last two are the ones that keep this
 * honest: a caller's own withdrawal is not a service refusal, and an undeclared throw is
 * not one either.
 */
export type ModelServiceReply =
    | { readonly kind: "answered"; readonly output: ContentRef; readonly usage: TurnModelUsage }
    | { readonly kind: "unsendable"; readonly code: ModelServiceUnsendableCode }
    | { readonly kind: "refused"; readonly code: ModelServiceRefusalCode }
    | { readonly kind: "abandoned" }
    | { readonly kind: "indeterminate"; readonly cause: unknown };

/**
 * The classification tables: a wire code to the vocabulary member it is. Records rather
 * than Sets because both tables are static and string-keyed, the way
 * `provider-capability.ts#DISCLOSED_CODES` states its disclosed set. Mapping to the
 * member rather than to `true` is what makes this a classification instead of a
 * membership test followed by an assertion that repeats it unchecked.
 */
const REFUSAL_CODES: Readonly<Record<string, ModelServiceRefusalCode | undefined>> = Object.freeze(
    Object.fromEntries(MODEL_SERVICE_REFUSALS.map((code) => [code, code]))
);
const UNSENDABLE_CODES: Readonly<Record<string, ModelServiceUnsendableCode | undefined>> =
    Object.freeze(Object.fromEntries(MODEL_SERVICE_UNSENDABLE.map((code) => [code, code])));

/**
 * One call, one reply value. This is the whole correspondence between what the adapters
 * throw and what the contract says the service answered, and it is the only place in the
 * suite that inspects a thrown value.
 */
export async function serviceReply(
    port: TranscriptTurnModelPort,
    request: TurnModelCall
): Promise<ModelServiceReply> {
    try {
        const result = await port.call(request);
        return { kind: "answered", output: result.output, usage: result.usage };
    } catch (cause) {
        // The caller's own withdrawal, which the adapter deliberately re-throws
        // unclassified (src/model/openai-compatible.ts: `if (signal.aborted) throw error`).
        // Reporting it as a refusal would attribute the runtime's decision to the service.
        if (request.signal.aborted) return { kind: "abandoned" };
        if (cause instanceof HarnessError) {
            const unsendable = UNSENDABLE_CODES[cause.code];
            if (unsendable !== undefined) return { kind: "unsendable", code: unsendable };
            const refused = REFUSAL_CODES[cause.code];
            if (refused !== undefined) return { kind: "refused", code: refused };
        }
        // Undeclared. The contract's position is that the runtime does not know what
        // happened, which is a different claim from "the service refused".
        return { kind: "indeterminate", cause };
    }
}

/**
 * What an implementation must be able to be put into. One member per reply the
 * vocabulary declares, so a suite that iterates the taxonomy cannot skip a case: an
 * implementation that cannot produce a declared refusal fails to compile.
 */
export type ModelServiceScenario =
    | { readonly kind: "answers"; readonly text: string }
    | { readonly kind: "refuses"; readonly code: ModelServiceRefusalCode }
    | { readonly kind: "faults" };

/**
 * One implementation of the service protocol, as the contract reaches it. `provider`
 * builds the transport for one scenario; `reached` reports whether that transport was
 * asked to carry anything, which is what makes the unsendable claim observable rather
 * than asserted.
 */
export interface ModelServiceImplementation {
    provider(scenario: ModelServiceScenario): ModelProvider;
    reached(provider: ModelProvider): boolean;
}

/** The one tool the contract's requests declare, so an undeclared one is nameable. */
export const CONTRACT_TOOL = "recall";

export const CONTRACT_UNDECLARED_TOOL = "exfiltrate";

const CATALOG: readonly TurnBoundOperation[] = Object.freeze([
    boundOperation(CONTRACT_TOOL, CONTRACT_TOOL)
]);

function call(signal: AbortSignal): TurnModelCall {
    return modelCall(
        TranscriptCodec.encode(new Transcript("Be brief.", [new UserMessage("Hello")])),
        CATALOG,
        signal
    );
}

/**
 * A request the port cannot render: this harness assembles exactly one shown section, so
 * two is a request no `renderMessages` will ever be handed. Built by widening a real call
 * rather than by hand, so the rest of the record stays whatever the kernel builds.
 */
function unsendableCall(signal: AbortSignal): TurnModelCall {
    const sound = call(signal);
    return Object.freeze({
        ...sound,
        sections: Object.freeze([...sound.sections, ...sound.sections])
    });
}

function portOver(provider: ModelProvider): TranscriptTurnModelPort {
    return new TranscriptTurnModelPort(provider, new MemoryContentStore());
}

export function modelServiceContract(
    name: string,
    implementation: ModelServiceImplementation
): void {
    describe(`${name} model inference service contract`, () => {
        test(
            "answers a completion as one content-addressed assistant message",
            { tags: "p1" },
            async () => {
                const provider = implementation.provider({ kind: "answers", text: "Hi." });
                const reply = await serviceReply(
                    portOver(provider),
                    call(new AbortController().signal)
                );

                expect(reply.kind).toBe("answered");
                if (reply.kind !== "answered") return;
                expect(reply.output.value.startsWith("sha256:")).toBe(true);
                expect(reply.usage.inputTokens).toBeGreaterThanOrEqual(0);
                expect(implementation.reached(provider)).toBe(true);
            }
        );

        test(
            "answers every refusal the taxonomy declares, and declares every refusal it answers",
            { tags: "p0" },
            async () => {
                const answered: string[] = [];
                for (const code of MODEL_SERVICE_REFUSALS) {
                    const reply = await serviceReply(
                        portOver(implementation.provider({ kind: "refuses", code })),
                        call(new AbortController().signal)
                    );

                    expect(reply).toEqual({ kind: "refused", code });
                    answered.push(code);
                }

                // Both directions: the taxonomy has no code this implementation cannot
                // produce, and this implementation produced no code outside it.
                expect(answered).toEqual([...MODEL_SERVICE_REFUSALS]);
                expect(answered.every((code) => REFUSAL_CODES[code] === code)).toBe(true);
            }
        );

        test(
            "refuses an unrenderable request without reaching the service",
            { tags: "p1" },
            async () => {
                const provider = implementation.provider({ kind: "answers", text: "unreached" });
                const reply = await serviceReply(
                    portOver(provider),
                    unsendableCall(new AbortController().signal)
                );

                expect(reply).toEqual({ kind: "unsendable", code: "transcript.invalid" });
                // The claim the separate variant exists for: no bytes crossed.
                expect(implementation.reached(provider)).toBe(false);
            }
        );

        test(
            "answers a caller abort as abandoned rather than as a service refusal",
            { tags: "p2" },
            async () => {
                const controller = new AbortController();
                controller.abort();
                const reply = await serviceReply(
                    portOver(implementation.provider({ kind: "faults" })),
                    call(controller.signal)
                );

                expect(reply).toEqual({ kind: "abandoned" });
            }
        );

        test(
            "answers an unclassified transport failure as indeterminate rather than as a refusal",
            { tags: "p1" },
            async () => {
                const reply = await serviceReply(
                    portOver(implementation.provider({ kind: "faults" })),
                    call(new AbortController().signal)
                );

                expect(reply.kind).toBe("indeterminate");
                if (reply.kind !== "indeterminate") return;
                // The cause travels whole. A refusal code invented here would be the
                // runtime claiming to know an answer the service never gave.
                expect(reply.cause).toBeDefined();
            }
        );
    });
}
