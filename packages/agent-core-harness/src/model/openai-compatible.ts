import { isJsonObject, isJsonValue, type JsonValue } from "@agent-core/core/core";
import type { TurnModelUsage } from "@agent-core/core/agents/runs";
import { BindingName } from "@agent-core/core/facets";
import { HarnessError } from "../error";
import {
    AssistantMessage,
    ToolCall,
    ToolCallId,
    ToolResultMessage,
    UserMessage,
    type Transcript
} from "../transcript";
import { ModelProvider, type ModelCompletion, type ModelRequest } from "./provider";

/**
 * Both Workers AI and AI Gateway speak the OpenAI chat-completions shape, so one
 * implementation serves both; only the endpoint and credential differ.
 */
export interface OpenAiCompatibleModelOptions {
    readonly endpoint: string;
    readonly model: string;
    readonly credential: () => Promise<string>;
    readonly fetch: typeof globalThis.fetch;
}

export class OpenAiCompatibleModelProvider extends ModelProvider {
    public constructor(private readonly options: OpenAiCompatibleModelOptions) {
        super();
    }

    public async complete(request: ModelRequest): Promise<ModelCompletion> {
        const body = {
            model: this.options.model,
            messages: renderMessages(request.transcript),
            ...(request.tools.length === 0
                ? {}
                : {
                      tools: request.tools.map((tool) => ({
                          type: "function",
                          function: {
                              name: tool.name,
                              description: tool.description,
                              parameters: tool.input
                          }
                      }))
                  })
        };
        const response = await this.send(body, request.signal);
        if (!response.ok) {
            throw new HarnessError(
                response.status >= 500 || response.status === 429
                    ? "model.unavailable"
                    : "model.rejected",
                `Model endpoint returned ${response.status}`
            );
        }
        return readCompletion(await response.text());
    }

    private async send(body: JsonValue, signal: AbortSignal): Promise<Response> {
        // Resolved before the request so a credential failure is not reported as an
        // unreachable endpoint.
        const credential = await this.options.credential();
        try {
            return await this.options.fetch(this.options.endpoint, {
                method: "POST",
                signal,
                headers: {
                    authorization: `Bearer ${credential}`,
                    "content-type": "application/json"
                },
                body: JSON.stringify(body)
            });
        } catch (error) {
            if (signal.aborted) throw error;
            throw new HarnessError(
                "model.unavailable",
                `Model endpoint is unreachable: ${errorMessage(error)}`
            );
        }
    }
}

/** Workers AI's OpenAI-compatible route for one account. */
export function workersAiEndpoint(accountId: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
}

/** AI Gateway's OpenAI-compatible route for one gateway and upstream provider. */
export function aiGatewayEndpoint(accountId: string, gateway: string, provider: string): string {
    return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gateway)}/${encodeURIComponent(provider)}/chat/completions`;
}

function renderMessages(transcript: Transcript): readonly JsonValue[] {
    const messages: JsonValue[] = [{ role: "system", content: transcript.instructions }];
    for (const message of transcript.messages) {
        if (message instanceof UserMessage) {
            messages.push({ role: "user", content: message.text });
            continue;
        }
        if (message instanceof AssistantMessage) {
            messages.push({
                role: "assistant",
                content: message.text,
                ...(message.toolCalls.length === 0
                    ? {}
                    : {
                          tool_calls: message.toolCalls.map((call) => ({
                              id: call.id.value,
                              type: "function",
                              function: {
                                  name: call.binding.value,
                                  arguments: JSON.stringify(call.input)
                              }
                          }))
                      })
            });
            continue;
        }
        if (!(message instanceof ToolResultMessage)) {
            throw new HarnessError("transcript.invalid", "Unknown transcript message kind");
        }
        messages.push({
            role: "tool",
            tool_call_id: message.call.value,
            content: JSON.stringify(message.output)
        });
    }
    return messages;
}

function readCompletion(text: string): ModelCompletion {
    const value = requireObject(parseJson(text, "Model response"), "Model response");
    const choice = firstChoice(value);
    const message = field(choice, "message", isJsonObject);
    const rawContent = message["content"];
    const content = rawContent === null || rawContent === undefined ? "" : rawContent;
    if (typeof content !== "string") {
        throw malformed("Model message content must be a string");
    }
    return Object.freeze({
        message: new AssistantMessage(content, readToolCalls(message["tool_calls"])),
        usage: readUsage(value["usage"])
    });
}

function readToolCalls(value: JsonValue | undefined): readonly ToolCall[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw malformed("Model tool calls must be an array");
    return value.map((entry) => {
        const call = requireObject(entry, "Model tool call");
        const fn = field(call, "function", isJsonObject);
        const name = field(fn, "name", isString);
        const args = field(fn, "arguments", isString);
        return new ToolCall(
            new ToolCallId(field(call, "id", isString)),
            new BindingName(name),
            decodeArguments(args)
        );
    });
}

function decodeArguments(value: string): JsonValue {
    return parseJson(value === "" ? "{}" : value, "Model tool call arguments");
}

function readUsage(value: JsonValue | undefined): TurnModelUsage {
    const usage = value === undefined || value === null ? {} : requireObject(value, "Model usage");
    return Object.freeze({
        inputTokens: countOf(usage["prompt_tokens"]),
        outputTokens: countOf(usage["completion_tokens"])
    });
}

function countOf(value: JsonValue | undefined): number {
    if (value === undefined || value === null) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw malformed("Model usage counts must be non-negative integers");
    }
    return value;
}

function firstChoice(root: { readonly [key: string]: JsonValue }): {
    readonly [key: string]: JsonValue;
} {
    const choices = root["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
        throw malformed("Model response carries no choices");
    }
    return requireObject(choices[0], "Model choice");
}

/**
 * A provider response is untrusted, arbitrarily ordered JSON, so it is parsed and
 * narrowed here rather than read with the kernel's canonical-form decoder, which
 * rejects any byte sequence that is not already in canonical form.
 */
function parseJson(text: string, subject: string): JsonValue {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw malformed(`${subject} is not valid JSON`);
    }
    if (!isJsonValue(value)) throw malformed(`${subject} is not JSON data`);
    return value;
}

function field<Value extends JsonValue>(
    record: { readonly [key: string]: JsonValue },
    name: string,
    accepts: (value: JsonValue | undefined) => value is Value
): Value {
    const value = record[name];
    if (!accepts(value)) throw malformed(`Model response field ${name} is malformed`);
    return value;
}

function isString(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}

function requireObject(
    value: JsonValue | undefined,
    subject: string
): { readonly [key: string]: JsonValue } {
    if (!isJsonObject(value)) throw malformed(`${subject} must be an object`);
    return value;
}

function malformed(message: string): HarnessError {
    return new HarnessError("model.malformed-response", message);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
