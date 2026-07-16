import { Digest, strictJsonSchemaValidator, type JsonValue } from "../../../src/core";
import {
    EffectDispatch,
    EffectDispatchAttempt,
    MCP_IMPACT_ANNOTATION,
    MCP_MAXIMUM_PROMPT_BYTES,
    MCP_MAXIMUM_PROMPTS,
    MCP_PROTOCOL_REVISION,
    McpDiscoveryBackend,
    McpDiscoveryRegistration,
    McpFacet,
    McpPromptMaterializationContract,
    McpServerBackend,
    MemoryMcpDiscoveryRegistrationStore,
    type McpDiscoveryDocument
} from "../../../src/facets";
import { EffectAttemptId } from "../../../src/invocations";
import { describe, expect, test } from "vitest";
import { denyingRuntime, recordingRuntime } from "./harness";

describe("MCP protected lifecycle and durable operation registration", () => {
    test("[P11-MCP-INVOCATION] mediates lifecycle, discovery, and discovered calls", async () => {
        const server = new TestMcpServer();
        const { runtime, admission } = recordingRuntime("mcp");
        const facet = new McpFacet(
            runtime,
            createDiscovery(),
            server,
            new MemoryMcpDiscoveryRegistrationStore()
        );

        await facet.start();
        await expect(facet.health()).resolves.toBe(true);
        const discovery = await facet.discover();
        await expect(
            facet.call({ operation: "send", arguments: { text: "hello" } })
        ).resolves.toEqual({ operation: "send", input: { text: "hello" } });
        await facet.stop();

        expect(
            discovery.operations.map((operation) => [operation.name.value, operation.impact])
        ).toEqual([
            ["send", "externalSend"],
            ["read", "observe"]
        ]);
        expect(discovery.contributions.entries.map((entry) => entry.slot.value)).toEqual([
            "operations",
            "prompt"
        ]);
        expect(admission.calls.map((call) => [call.kind, call.name])).toEqual([
            ["control", "mcp.start"],
            ["control", "mcp.health"],
            ["control", "mcp.discover"],
            ["invoke", "send"],
            ["control", "mcp.stop"]
        ]);
    });

    test("[P11-MCP-ADAPTER] [P11-MCP-TOOLS] [facet.mcp-discovery-registration] restores validated immutable operation registration without rediscovery", async () => {
        const store = new MemoryMcpDiscoveryRegistrationStore();
        const firstServer = new TestMcpServer();
        const first = new McpFacet(
            recordingRuntime("mcp-first").runtime,
            createDiscovery(),
            firstServer,
            store
        );
        const result = await first.discover();
        const persisted = store.load();
        expect(persisted?.digest.value).toHaveLength(64);
        expect(Object.isFrozen(persisted?.document)).toBe(true);
        expect(Object.isFrozen(result.operations[0])).toBe(true);
        expect(new MemoryMcpDiscoveryRegistrationStore().load()).toBeUndefined();
        expect(new MemoryMcpDiscoveryRegistrationStore().snapshot()).toBeUndefined();

        const restartedServer = new TestMcpServer();
        restartedServer.discoveryAllowed = false;
        const restarted = new McpFacet(
            recordingRuntime("mcp-restarted").runtime,
            createDiscovery(),
            restartedServer,
            new MemoryMcpDiscoveryRegistrationStore(store.snapshot())
        );

        await expect(
            restarted.call({ operation: "send", arguments: { text: "after-restart" } })
        ).resolves.toEqual({ operation: "send", input: { text: "after-restart" } });
        expect(restartedServer.discoveryCalls).toBe(0);
    });

    test("[P11-MCP-LIFECYCLE] denial prevents server lifecycle handlers", async () => {
        const server = new TestMcpServer();
        const facet = new McpFacet(
            denyingRuntime("mcp").runtime,
            createDiscovery(),
            server,
            new MemoryMcpDiscoveryRegistrationStore()
        );
        await expect(facet.start()).rejects.toMatchObject({ code: "authority.denied" });
        expect(server.started).toBe(false);
    });
});

describe("MCP normative discovery", () => {
    test("[P11-MCP-SCHEMA-BOUNDARY] validates discovered schemas before projecting Operations", () => {
        const discovered = createDiscovery().discover(document());
        expect(discovered.operations[0]?.input.document).toEqual({});
        expect(() =>
            createDiscovery().discover(
                document({ inputSchema: { type: "not-a-json-schema-type" } })
            )
        ).toThrow(expect.objectContaining({ detailCode: "schema.invalid" }));
    });

    test("[P11-MCP-REVISION] enforces the edition's exact protocol revision", () => {
        expect(MCP_PROTOCOL_REVISION).toBe("2025-11-25");
        expect(() =>
            createDiscovery().discover({
                revision: "2025-03-26",
                tools: [],
                resources: [],
                prompts: []
            })
        ).toThrow(expect.objectContaining({ detailCode: "revision.mismatch" }));
    });

    test("[P11-MCP-IMPACT-ANNOTATION] [P11-MCP-IMPACT-DEFAULT-REMOTE] [P11-MCP-IMPACT-DEFAULT-LOCAL] maps only exact impact metadata and defaults unannotated remote/local tools", () => {
        const annotated = createDiscovery().discover(
            document({ _meta: { [MCP_IMPACT_ANNOTATION]: "mutate" } })
        );
        expect(annotated.operations[0]?.impact).toBe("mutate");
        expect(createDiscovery().discover(document()).operations[0]?.impact).toBe("externalSend");
        expect(
            new McpDiscoveryBackend(
                { ...config(), remote: false },
                strictJsonSchemaValidator
            ).discover(document()).operations[0]?.impact
        ).toBe("execute");
    });

    test("[P11-MCP-IMPACT-UNKNOWN] rejects malformed or unknown impact metadata", () => {
        for (const metadata of [
            { _meta: { [MCP_IMPACT_ANNOTATION]: "unknown" } },
            { _meta: { [MCP_IMPACT_ANNOTATION]: 1 } },
            { _meta: null },
            { impact: "observe" }
        ]) {
            expect(() => createDiscovery().discover(document(metadata as never))).toThrow(
                expect.objectContaining({ detailCode: "impact.invalid" })
            );
        }
        expect(
            createDiscovery().discover(document({ _meta: { unrelated: true } })).operations[0]
                ?.impact
        ).toBe("externalSend");
    });

    test("[P11-MCP-MALFORMED-SCHEMA] [P11-MCP-NO-LATE-SCHEMA] rejects malformed discovery metadata and schemas before registration", () => {
        const discovery = createDiscovery();
        for (const malformed of [
            [],
            { revision: 1, tools: [], resources: [], prompts: [] },
            { revision: MCP_PROTOCOL_REVISION, tools: null, resources: [], prompts: [] },
            {
                revision: MCP_PROTOCOL_REVISION,
                tools: [{}],
                resources: [],
                prompts: []
            },
            {
                revision: MCP_PROTOCOL_REVISION,
                tools: [{ name: "bad", inputSchema: {}, outputSchema: undefined }],
                resources: [],
                prompts: []
            },
            {
                revision: MCP_PROTOCOL_REVISION,
                tools: [],
                resources: [{}],
                prompts: []
            },
            {
                revision: MCP_PROTOCOL_REVISION,
                tools: [],
                resources: [],
                prompts: [{ title: "hint", body: 1 }]
            }
        ]) {
            expect(() => discovery.discover(malformed as never)).toThrow(
                expect.objectContaining({ detailCode: "schema.invalid" })
            );
        }
        const rejectingSchemas = new McpDiscoveryBackend(config(), {
            assertSchema: () => {
                throw new TypeError("malformed schema");
            }
        });
        expect(() => rejectingSchemas.discover(document())).toThrow(
            expect.objectContaining({ detailCode: "schema.invalid" })
        );
        expect(() =>
            createDiscovery().discover({
                revision: MCP_PROTOCOL_REVISION,
                tools: [],
                resources: [],
                prompts: [{ title: " ", body: "body" }]
            })
        ).toThrow(expect.objectContaining({ detailCode: "schema.invalid" }));
    });

    test("rejects duplicate operation names and invalid persisted digests", () => {
        expect(() =>
            createDiscovery().discover({
                revision: MCP_PROTOCOL_REVISION,
                tools: [{ name: "same", inputSchema: {}, outputSchema: {} }],
                resources: [{ name: "same", outputSchema: {} }],
                prompts: []
            })
        ).toThrow(expect.objectContaining({ detailCode: "name.duplicate" }));
        expect(() => new McpDiscoveryRegistration(document(), new Digest("f".repeat(64)))).toThrow(
            /digest/
        );
        expect(() =>
            createDiscovery().restore({
                document: document(),
                digest: new Digest("f".repeat(64))
            } as McpDiscoveryRegistration)
        ).toThrow(expect.objectContaining({ detailCode: "registration.invalid" }));
        expect(() =>
            createDiscovery().discover({
                revision: MCP_PROTOCOL_REVISION,
                tools: [{ name: " ", inputSchema: {}, outputSchema: {} }],
                resources: [],
                prompts: []
            })
        ).toThrow(expect.objectContaining({ detailCode: "name.duplicate" }));
    });

    test("[P11-MCP-POSITIVE-BOUNDS] [P11-MCP-PROMPT-COUNT] [P11-MCP-PROMPT-BYTES] enforces positive finite normative prompt item and canonical byte bounds", () => {
        for (const bounds of [
            [0, 1],
            [1, 0],
            [Number.POSITIVE_INFINITY, 1],
            [1, Number.POSITIVE_INFINITY],
            [MCP_MAXIMUM_PROMPTS + 1, 1],
            [1, MCP_MAXIMUM_PROMPT_BYTES + 1]
        ] as const) {
            expect(() => new McpPromptMaterializationContract(bounds[0], bounds[1])).toThrow(
                TypeError
            );
        }
        const count = new McpPromptMaterializationContract(1, MCP_MAXIMUM_PROMPT_BYTES);
        expect(() =>
            count.materialize([
                { title: "one", body: "body" },
                { title: "two", body: "body" }
            ])
        ).toThrow(expect.objectContaining({ detailCode: "prompt.bound" }));
        const bytes = new McpPromptMaterializationContract(1, 32);
        expect(() => bytes.materialize([{ title: "multibyte", body: "é".repeat(20) }])).toThrow(
            expect.objectContaining({ detailCode: "prompt.bound" })
        );
        for (const invalid of [
            { ...config(), maximumPrompts: 0 },
            { ...config(), maximumPromptBytes: 0 },
            { ...config(), maximumPrompts: MCP_MAXIMUM_PROMPTS + 1 },
            { ...config(), maximumPromptBytes: MCP_MAXIMUM_PROMPT_BYTES + 1 }
        ]) {
            expect(() => new McpDiscoveryBackend(invalid, strictJsonSchemaValidator)).toThrow(
                TypeError
            );
        }
    });

    test("[P11-MCP-SCHEMA-BOUNDARY] [P11-MCP-RESOURCES] [P11-MCP-PROMPTS] preserves validated schemas and projects resources and prompts", () => {
        const discovered = createDiscovery().discover(new TestMcpServer().document);
        expect(discovered.operations[0]?.input.document).toEqual({
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false
        });
        expect(discovered.operations[1]?.impact).toBe("observe");
        expect(discovered.promptContribution.sections.map((prompt) => prompt.title)).toEqual([
            "hint"
        ]);
    });

    test("rejects calls that have no persisted discovery registration", () => {
        const facet = new McpFacet(
            recordingRuntime("mcp-undiscovered").runtime,
            createDiscovery(),
            new TestMcpServer(),
            new MemoryMcpDiscoveryRegistrationStore()
        );
        expect(() => facet.call({ operation: "missing", arguments: {} })).toThrow(
            expect.objectContaining({ detailCode: "operation.missing" })
        );
    });
});

describe("MCP effect identity to server backend", () => {
    test("[P11-MCP-DISPATCH] delivers the canonical effect identity derived from the context", async () => {
        const server = new TestMcpServer();
        const { runtime, admission } = recordingRuntime("mcp-dispatch");
        const facet = new McpFacet(
            runtime,
            createDiscovery(),
            server,
            new MemoryMcpDiscoveryRegistrationStore()
        );

        await facet.discover();
        await facet.call({ operation: "send", arguments: { text: "hello" } });

        const invoke = admission.calls.find((call) => call.kind === "invoke")!;
        const expected = invoke.context!.dispatch();
        const delivered = server.dispatched[0]!;
        expect(Object.isFrozen(delivered)).toBe(true);
        expect(delivered.idempotencyKey).toBe(expected.idempotencyKey);
        expect(delivered.attempt?.id.equals(expected.attempt!.id)).toBe(true);
        expect(delivered.attempt?.ordinal).toBe(expected.attempt!.ordinal);
        expect(delivered.attempt?.intentDigest.equals(expected.attempt!.intentDigest)).toBe(true);
    });

    test("[P11-MCP-CRASH-RETRY] a crash-after-send retry reuses the key so the provider dedups instead of re-invoking", async () => {
        const server = new DedupMcpServer();
        const dispatch = new EffectDispatch(
            "mcp-test-key",
            new EffectDispatchAttempt(
                new EffectAttemptId("mcp-test-attempt"),
                0,
                Digest.sha256(new TextEncoder().encode("mcp-test"))
            )
        );

        await expect(server.call("send", { text: "hi" }, dispatch)).rejects.toThrow(
            "crash after send"
        );
        const retry = await server.call("send", { text: "hi" }, dispatch);

        expect(server.attempts.map((attempt) => attempt.idempotencyKey)).toEqual([
            "mcp-test-key",
            "mcp-test-key"
        ]);
        expect(
            server.attempts.every((attempt) =>
                attempt.attempt!.id.equals(new EffectAttemptId("mcp-test-attempt"))
            )
        ).toBe(true);
        expect(server.deliveries).toBe(1);
        expect(retry).toEqual({ operation: "send", input: { text: "hi" } });
    });
});

class TestMcpServer extends McpServerBackend {
    public started = false;
    public discoveryAllowed = true;
    public discoveryCalls = 0;
    public readonly dispatched: EffectDispatch[] = [];
    public readonly document: McpDiscoveryDocument = {
        revision: MCP_PROTOCOL_REVISION,
        tools: [
            {
                name: "send",
                inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                    additionalProperties: false
                },
                outputSchema: {}
            }
        ],
        resources: [{ name: "read", outputSchema: {} }],
        prompts: [{ title: "hint", body: "body" }]
    };

    public async start(): Promise<void> {
        this.started = true;
    }
    public async health(): Promise<boolean> {
        return this.started;
    }
    public async stop(): Promise<void> {
        this.started = false;
    }
    public async discover(): Promise<McpDiscoveryDocument> {
        this.discoveryCalls += 1;
        if (!this.discoveryAllowed) throw new TypeError("rediscovery is forbidden");
        return this.document;
    }
    public async call(
        operation: string,
        input: JsonValue,
        dispatch: EffectDispatch
    ): Promise<JsonValue> {
        this.dispatched.push(dispatch);
        return { operation, input };
    }
}

/**
 * A server backend that dedups on the canonical idempotency key: the first call
 * delivers then crashes before the outcome is recorded; a retry carrying the same key
 * returns the prior result without re-invoking the tool (SPEC §7.4).
 */
class DedupMcpServer extends McpServerBackend {
    public readonly attempts: EffectDispatch[] = [];
    public deliveries = 0;
    readonly #results = new Map<string, JsonValue>();

    public async start(): Promise<void> {}
    public async health(): Promise<boolean> {
        return true;
    }
    public async stop(): Promise<void> {}
    public async discover(): Promise<McpDiscoveryDocument> {
        throw new TypeError("discovery is not exercised");
    }
    public async call(
        operation: string,
        input: JsonValue,
        dispatch: EffectDispatch
    ): Promise<JsonValue> {
        this.attempts.push(dispatch);
        const prior = this.#results.get(dispatch.idempotencyKey);
        if (prior !== undefined) return prior;
        this.deliveries += 1;
        this.#results.set(dispatch.idempotencyKey, { operation, input });
        throw new TypeError("crash after send");
    }
}

function createDiscovery(): McpDiscoveryBackend {
    return new McpDiscoveryBackend(config(), strictJsonSchemaValidator);
}

function config() {
    return {
        remote: true,
        maximumPrompts: MCP_MAXIMUM_PROMPTS,
        maximumPromptBytes: MCP_MAXIMUM_PROMPT_BYTES
    } as const;
}

function document(tool: Record<string, unknown> = {}): McpDiscoveryDocument {
    return {
        revision: MCP_PROTOCOL_REVISION,
        tools: [{ name: "tool", inputSchema: {}, outputSchema: {}, ...tool }],
        resources: [],
        prompts: []
    } as McpDiscoveryDocument;
}
