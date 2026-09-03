import { describe, expect, test } from "vitest";
import { MemoryContentStore } from "@agent-core/core/content";
import { BindingName } from "@agent-core/core/facets";
import { HarnessError } from "../src/error.js";
import { ModelProvider, type ModelCompletion, type ModelRequest } from "../src/model/provider.js";
import {
    OpenAiCompatibleModelProvider,
    workersAiEndpoint
} from "../src/model/openai-compatible.js";
import { TranscriptTurnModelPort } from "../src/model/port.js";
import {
    AssistantMessage,
    ToolCall,
    ToolCallId,
    Transcript,
    TranscriptCodec,
    UserMessage
} from "../src/transcript.js";
import { boundOperation, modelCall } from "./fixture.js";
import {
    CONTRACT_UNDECLARED_TOOL,
    MODEL_SERVICE_OPERATIONS,
    MODEL_SERVICE_REFUSALS,
    modelServiceContract,
    serviceReply,
    type ModelServiceImplementation,
    type ModelServiceScenario
} from "./model-service-contract.js";

/**
 * The `model.inference` contract, run against both implementations the repository has:
 * a reference provider that answers each scenario directly, and the real
 * `OpenAiCompatibleModelProvider` driven into the same scenario over a `fetch` double
 * that produces the wire condition rather than the classification.
 *
 * The reference implementation is the control. It is what the contract would look like
 * if the transport were perfect, so a case that only the real adapter fails is a fact
 * about the adapter and not about the suite.
 */

/** How many times a transport was asked to carry something, per provider instance. */
const reachCounts = new WeakMap<ModelProvider, { count: number }>();

class ReferenceModelProvider extends ModelProvider {
    public constructor(private readonly scenario: ModelServiceScenario) {
        super();
    }

    public async complete(request: ModelRequest): Promise<ModelCompletion> {
        reachCounts.get(this)!.count += 1;
        // A provider that ignores its signal would make every caller's withdrawal look
        // like a completed inference, so the reference honors it first.
        if (request.signal.aborted) throw request.signal.reason;
        if (this.scenario.kind === "faults") {
            throw new TypeError("Reference transport failed in a way the taxonomy does not name");
        }
        if (this.scenario.kind === "refuses") {
            if (this.scenario.code !== "model.unknown-tool") {
                throw new HarnessError(
                    this.scenario.code,
                    `Reference refusal ${this.scenario.code}`
                );
            }
            // Not a throw: an undeclared tool is something the service *answered*, and the
            // port is what refuses it. Producing it any other way would test the reference
            // rather than the rule.
            return Object.freeze({
                message: new AssistantMessage("", [
                    new ToolCall(
                        new ToolCallId("call-1"),
                        new BindingName(CONTRACT_UNDECLARED_TOOL),
                        {}
                    )
                ]),
                usage: Object.freeze({ inputTokens: 0, outputTokens: 0 })
            });
        }
        return Object.freeze({
            message: new AssistantMessage(this.scenario.text),
            usage: Object.freeze({ inputTokens: 5, outputTokens: 2 })
        });
    }
}

const reference: ModelServiceImplementation = {
    provider(scenario) {
        const provider = new ReferenceModelProvider(scenario);
        reachCounts.set(provider, { count: 0 });
        return provider;
    },
    reached(provider) {
        return (reachCounts.get(provider)?.count ?? 0) > 0;
    }
};

/**
 * The wire condition for one scenario, as the service would present it. Nothing here
 * names a taxonomy code: the adapter's own classification is what the contract measures,
 * so the double speaks HTTP and JSON and lets the adapter decide.
 */
function wireResponse(scenario: ModelServiceScenario): Response {
    if (scenario.kind === "refuses") {
        if (scenario.code === "model.unavailable") return new Response("{}", { status: 503 });
        if (scenario.code === "model.rejected") return new Response("{}", { status: 400 });
        if (scenario.code === "model.malformed-response") return new Response("not json");
        return new Response(
            JSON.stringify({
                choices: [
                    {
                        message: {
                            content: "",
                            tool_calls: [
                                {
                                    id: "call-1",
                                    function: {
                                        name: CONTRACT_UNDECLARED_TOOL,
                                        arguments: "{}"
                                    }
                                }
                            ]
                        }
                    }
                ]
            })
        );
    }
    if (scenario.kind === "faults") {
        // A reply the adapter reads as well-formed and then cannot construct: an empty
        // tool name passes every check `readToolCalls` makes and throws inside
        // `new BindingName("")`. This is the undeclared branch, produced by the service
        // rather than by the double throwing on the adapter's behalf.
        return new Response(
            JSON.stringify({
                choices: [
                    {
                        message: {
                            content: "",
                            tool_calls: [{ id: "call-1", function: { name: "", arguments: "{}" } }]
                        }
                    }
                ]
            })
        );
    }
    return new Response(
        JSON.stringify({
            choices: [{ message: { content: scenario.text } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 }
        })
    );
}

const adapter: ModelServiceImplementation = {
    provider(scenario) {
        const reach = { count: 0 };
        const provider = new OpenAiCompatibleModelProvider({
            endpoint: workersAiEndpoint("account-1"),
            model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            credential: async () => "token",
            fetch: async (_url, init) => {
                reach.count += 1;
                // The platform rejects a fetch on an aborted signal before it opens a
                // connection, and the adapter's `if (signal.aborted) throw error` branch
                // exists for exactly that reply.
                if (init?.signal?.aborted === true) throw init.signal.reason;
                return wireResponse(scenario);
            }
        });
        reachCounts.set(provider, reach);
        return provider;
    },
    reached(provider) {
        return (reachCounts.get(provider)?.count ?? 0) > 0;
    }
};

modelServiceContract("reference", reference);
modelServiceContract("OpenAI-compatible adapter", adapter);

describe("model inference service protocol", () => {
    test("declares exactly the operations an implementation has to serve", { tags: "p2" }, () => {
        expect([...MODEL_SERVICE_OPERATIONS]).toEqual(["complete"]);
        // `complete` is abstract, so `ModelProvider.prototype` carries no member of
        // its own; what is observable is what an implementation defines. The
        // reference defines exactly the vocabulary and nothing else, which is the
        // direction that catches a vocabulary entry no implementation serves. The
        // real adapter is only required to carry every declared operation: its
        // `send` is internal plumbing rather than a protocol verb.
        expect(
            Object.getOwnPropertyNames(ReferenceModelProvider.prototype)
                .filter((name) => name !== "constructor")
                .sort()
        ).toEqual([...MODEL_SERVICE_OPERATIONS]);
        const offered = Object.getOwnPropertyNames(OpenAiCompatibleModelProvider.prototype);
        expect(MODEL_SERVICE_OPERATIONS.every((name) => offered.includes(name))).toBe(true);
    });

    test(
        "leaves no HarnessError code outside the service taxonomy without saying so",
        { tags: "p0" },
        () => {
            // `loop.step-budget-exhausted` is the harness loop's own ceiling rather than
            // anything a service answered, and `transcript.invalid` is the request-side
            // refusal the reply vocabulary carries as `unsendable`. Every other code is a
            // refusal. The gate over artifacts/service-contracts.json holds the same
            // partition against src/error.ts, so this assertion and that one have to move
            // together.
            const declared = [
                ...MODEL_SERVICE_REFUSALS,
                "transcript.invalid",
                "loop.step-budget-exhausted"
            ].sort();
            expect(declared).toEqual([
                "loop.step-budget-exhausted",
                "model.malformed-response",
                "model.rejected",
                "model.unavailable",
                "model.unknown-tool",
                "transcript.invalid"
            ]);
        }
    );

    test(
        "leaves a credential resolution failure outside the taxonomy entirely",
        { tags: "p1" },
        async () => {
            // `send` resolves the credential before the try block, deliberately, so a
            // credential failure is not reported as an unreachable endpoint
            // (src/model/openai-compatible.ts:64-66). The consequence the taxonomy has to
            // own is that it is not reported as anything: whatever the host's closure
            // threw escapes as itself, which the contract answers as indeterminate rather
            // than inventing a service answer nobody gave.
            let reached = false;
            const provider = new OpenAiCompatibleModelProvider({
                endpoint: workersAiEndpoint("account-1"),
                model: "m",
                credential: async () => {
                    throw new RangeError("credential store is unavailable");
                },
                fetch: async () => {
                    reached = true;
                    return new Response("{}");
                }
            });

            const reply = await serviceReply(
                new TranscriptTurnModelPort(provider, new MemoryContentStore()),
                modelCall(
                    TranscriptCodec.encode(new Transcript("Be brief.", [new UserMessage("Hi")])),
                    [boundOperation("recall", "recall")],
                    new AbortController().signal
                )
            );

            expect(reply.kind).toBe("indeterminate");
            if (reply.kind !== "indeterminate") return;
            expect(reply.cause).toBeInstanceOf(RangeError);
            // Nothing crossed the boundary, and yet this is not `unsendable` either: the
            // request was renderable and the runtime simply could not authenticate.
            expect(reached).toBe(false);
        }
    );
});
