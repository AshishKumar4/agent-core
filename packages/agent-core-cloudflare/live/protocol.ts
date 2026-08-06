import { AgentCoreError, type JsonValue } from "@agent-core/core";
import type { CloudflareErrorPort } from "../src/index.js";

/** Every live lane maps substrate failures into the shared taxonomy, never a raw throw. */
export const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

export type LiveBody = Record<string, JsonValue>;

export async function readBody(request: Request): Promise<LiveBody> {
    if (request.method !== "POST") return {};
    return (await request.json()) as LiveBody;
}

export function field(body: LiveBody, key: string): string {
    const value = body[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new AgentCoreError("operation.invalid-input", `Live request needs string ${key}`);
    }
    return value;
}

export function numberField(body: LiveBody, key: string): number {
    const value = body[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new AgentCoreError("operation.invalid-input", `Live request needs number ${key}`);
    }
    return value;
}

export function optionalNumberField(body: LiveBody, key: string, fallback: number): number {
    return body[key] === undefined ? fallback : numberField(body, key);
}

export function flagField(body: LiveBody, key: string): boolean {
    const value = body[key];
    if (value !== undefined && typeof value !== "boolean") {
        throw new AgentCoreError("operation.invalid-input", `Live request needs boolean ${key}`);
    }
    return value === true;
}

export async function handleResponse(operation: () => Promise<Response>): Promise<Response> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof AgentCoreError) {
            return Response.json(
                { ok: false, code: error.code, message: error.message },
                {
                    status: 409
                }
            );
        }
        throw error;
    }
}

export async function handle(operation: () => Promise<JsonValue>): Promise<Response> {
    return handleResponse(async () => Response.json({ ok: true, result: await operation() }));
}
