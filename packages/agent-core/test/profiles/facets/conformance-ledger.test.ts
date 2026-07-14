import { ContentRef, Digest, Revision, type JsonValue } from "../../../src/core";
import {
    APPROVAL_GATEWAY_ISOLATION,
    APPROVAL_GATEWAY_OPERATION_CONTRACTS,
    APPROVAL_GATEWAY_OPERATIONS,
    DEVICE_COMMAND_EVENTS,
    DEVICE_OPERATIONS,
    ENVIRONMENT_EVENTS,
    ENVIRONMENT_OPERATIONS,
    FILESYSTEM_ERROR_CODES,
    FILESYSTEM_OPERATIONS,
    InMemoryMemoryIndexBackend,
    MCP_MAXIMUM_PROMPT_BYTES,
    MCP_MAXIMUM_PROMPTS,
    McpDiscoveryBackend,
    McpPromptMaterializationContract,
    MemoryFilesystemBackend,
    MEMORY_CONTRIBUTIONS,
    MEMORY_OPERATIONS,
    MemoryBackend,
    type MemoryAccessBackend,
    type MemoryContentBackend,
    ReadonlyFilesystemBackend,
    SELF_OPERATIONS,
    SHELL_OPERATIONS,
    SINGLE_TENANT_EVENTS,
    SINGLE_TENANT_OPERATIONS,
    SLATE_OPERATIONS,
    TASK_OPERATIONS,
    OperationDescriptor,
    SlotName
} from "../../../src/facets";
import { Principal, PrincipalId, Tenant, TenantId } from "../../../src/identity";
import { expect, test } from "vitest";

type Check = () => void;

function requirement(id: string, check: Check): void {
    test(`[${id}] exact profile manifest or runtime contract`, check);
}

function operation(operations: readonly OperationDescriptor[], name: string): OperationDescriptor {
    const descriptor = operations.find((candidate) => candidate.name.value === name);
    if (descriptor === undefined) throw new TypeError(`Missing profile operation ${name}`);
    return descriptor;
}

function impact(
    id: string,
    operations: readonly OperationDescriptor[],
    name: string,
    expected: OperationDescriptor["impact"]
): void {
    requirement(id, () => expect(operation(operations, name).impact).toBe(expected));
}

impact("P11-APPROVAL-GATEWAY-OBSERVE", APPROVAL_GATEWAY_OPERATIONS, "observe", "observe");
requirement("P11-APPROVAL-GATEWAY-PROVIDER", () => {
    expect(APPROVAL_GATEWAY_ISOLATION).toEqual(["provider"]);
});
requirement("P11-APPROVAL-GATEWAY-READS", () => {
    expect(APPROVAL_GATEWAY_OPERATION_CONTRACTS.observe.descriptor.impact).toBe("observe");
});
requirement("P11-APPROVAL-GATEWAY-RECEIPTS", () => {
    expect(APPROVAL_GATEWAY_OPERATION_CONTRACTS.applyAction.resultMode).toBe("output");
});
requirement("P11-APPROVAL-GATEWAY-RECONCILIATION", () => {
    expect(APPROVAL_GATEWAY_OPERATION_CONTRACTS.applyAction.descriptor.impact).toBe("externalSend");
});

requirement("P11-BASE-COMPOSITION", () => {
    expect([FILESYSTEM_OPERATIONS, MEMORY_OPERATIONS, TASK_OPERATIONS].every(Object.isFrozen)).toBe(
        true
    );
});
requirement("P11-BASE-CONTRACT", () => {
    expect(FILESYSTEM_OPERATIONS.every((value) => value instanceof OperationDescriptor)).toBe(true);
});
requirement("P11-BASE-TESTS", () => {
    for (const descriptor of [...FILESYSTEM_OPERATIONS, ...MEMORY_OPERATIONS, ...TASK_OPERATIONS]) {
        descriptor.input.assertValid();
        descriptor.output.assertValid();
    }
});

for (const [id, name, input, invalid] of [
    [
        "P11-DEVICE-CAMERA",
        "camera",
        { deviceId: "phone", arguments: { facing: "front" } },
        [
            { deviceId: "phone", arguments: { facing: "side" } },
            { deviceId: "phone", arguments: { facing: "front", extra: true } }
        ]
    ],
    [
        "P11-DEVICE-LOCATION",
        "location",
        { deviceId: "phone", arguments: { accuracyMeters: 1 } },
        [
            { deviceId: "phone", arguments: { accuracyMeters: -1 } },
            { deviceId: "phone", arguments: { extra: true } }
        ]
    ],
    [
        "P11-DEVICE-SCREEN",
        "screen",
        { deviceId: "phone", arguments: { mode: "capture" } },
        [
            { deviceId: "phone", arguments: { mode: "record" } },
            { deviceId: "phone", arguments: { mode: "capture", extra: true } }
        ]
    ],
    [
        "P11-DEVICE-SMS",
        "sms",
        { deviceId: "phone", arguments: { to: "+10000000000", message: "hello" } },
        [
            { deviceId: "phone", arguments: { to: "", message: "hello" } },
            { deviceId: "phone", arguments: { to: "+1", message: "", extra: true } }
        ]
    ],
    [
        "P11-DEVICE-SYSTEM-RUN",
        "system.run",
        { deviceId: "phone", arguments: { command: "status", arguments: ["--json"] } },
        [
            { deviceId: "phone", arguments: { command: "" } },
            { deviceId: "phone", arguments: { command: "status", arguments: [1] } }
        ]
    ]
] as const) {
    requirement(id, () => {
        const schema = operation(DEVICE_OPERATIONS, name).input;
        expect(schema.accepts(input)).toBe(true);
        expect(schema.accepts({ ...input, extra: true })).toBe(false);
        for (const candidate of invalid) expect(schema.accepts(candidate)).toBe(false);
    });
}
requirement("P11-DEVICE-NO-PROFILE-EVENTS", () => {
    expect(Object.values(DEVICE_COMMAND_EVENTS).map((event) => event.kind.value)).toEqual([
        "command.invoked",
        "command.completed"
    ]);
});

requirement("P11-ENVIRONMENT-DISPOSE", () => {
    expect(ENVIRONMENT_OPERATIONS).toEqual([]);
    expect(ENVIRONMENT_EVENTS).toEqual([]);
});
requirement("P11-ENVIRONMENT-NO-BASE-EVENTS", () => expect(ENVIRONMENT_EVENTS).toEqual([]));
requirement("P11-ENVIRONMENT-NO-BASE-IMPACTS", () => {
    expect(ENVIRONMENT_OPERATIONS.map((value) => value.impact)).toEqual([]);
});
requirement("P11-ENVIRONMENT-NO-BASE-OPERATIONS", () => {
    expect(ENVIRONMENT_OPERATIONS).toEqual([]);
});

for (const [id, name, expected] of [
    ["P11-FILESYSTEM-READ", "read", "observe"],
    ["P11-FILESYSTEM-STAT", "stat", "observe"],
    ["P11-FILESYSTEM-LIST", "list", "observe"],
    ["P11-FILESYSTEM-WRITE", "write", "mutate"],
    ["P11-FILESYSTEM-REMOVE", "remove", "mutate"],
    ["P11-FILESYSTEM-MKDIR", "mkdir", "mutate"]
] as const) {
    impact(id, FILESYSTEM_OPERATIONS, name, expected);
}
requirement("P11-FILESYSTEM-ATOMICITY-ASSERTIONS", () => {
    const filesystem = new MemoryFilesystemBackend(1);
    filesystem.write("/file", new Uint8Array([1]));
    expect(() => filesystem.write("/file", new Uint8Array([2, 3]), "replace")).toThrow();
    expect(filesystem.read("/file")).toEqual(new Uint8Array([1]));
});
requirement("P11-FILESYSTEM-CODE-ASSERTIONS", () => {
    expect(FILESYSTEM_ERROR_CODES).toHaveLength(6);
});
requirement("P11-FILESYSTEM-ERROR-BRANCHING", () => {
    const filesystem = new MemoryFilesystemBackend();
    try {
        filesystem.read("/missing");
        throw new TypeError("Expected a missing-path error");
    } catch (error) {
        expect(error).toMatchObject({ detailCode: "not-found", detail: { code: "not-found" } });
    }
});
requirement("P11-FILESYSTEM-ERROR-CLOSED", () => {
    try {
        new MemoryFilesystemBackend().read("/missing");
        throw new TypeError("Expected a closed filesystem error");
    } catch (error) {
        expect(FILESYSTEM_ERROR_CODES).toContain(
            (error as { readonly detailCode: (typeof FILESYSTEM_ERROR_CODES)[number] }).detailCode
        );
    }
});
requirement("P11-FILESYSTEM-ERROR-CODES", () => {
    expect(FILESYSTEM_ERROR_CODES).toEqual([
        "not-found",
        "exists",
        "not-a-directory",
        "is-a-directory",
        "path.invalid",
        "too-large"
    ]);
});
requirement("P11-FILESYSTEM-PAGING-ASSERTIONS", () => {
    const filesystem = new MemoryFilesystemBackend();
    filesystem.mkdir("/docs");
    filesystem.write("/docs/b", new Uint8Array([1, 2]));
    filesystem.write("/docs/a", new Uint8Array([3]));
    const first = filesystem.list("/docs", undefined, 1);
    expect(first.entries).toEqual([filesystem.stat("/docs/a")]);
    expect(filesystem.list("/docs", first.cursor, 1).entries).toEqual([filesystem.stat("/docs/b")]);
});
requirement("P11-FILESYSTEM-READONLY", () => {
    const mutable = new MemoryFilesystemBackend();
    mutable.write("/file", new Uint8Array([1]));
    const readonly = new ReadonlyFilesystemBackend(mutable);
    expect(readonly.read("/file")).toEqual(new Uint8Array([1]));
    expect("write" in readonly).toBe(false);
});

requirement("P11-MCP-TOOLS", () => {
    expect(mcpDiscovery(false).operations.map((value) => value.name.value)).toEqual(["tool"]);
});
requirement("P11-MCP-RESOURCES", () => {
    const discovered = new McpDiscoveryBackend(mcpConfig(false), {
        assertSchema: () => undefined
    }).discover({
        ...mcpDocument(),
        tools: [],
        resources: [{ name: "resource", outputSchema: {} }]
    });
    expect(discovered.operations.map((value) => [value.name.value, value.impact])).toEqual([
        ["resource", "observe"]
    ]);
});
requirement("P11-MCP-PROMPTS", () => {
    const discovered = new McpDiscoveryBackend(mcpConfig(false), {
        assertSchema: () => undefined
    }).discover({ ...mcpDocument(), tools: [], prompts: [{ title: "title", body: "body" }] });
    expect(discovered.promptContribution.sections).toMatchObject([
        { title: "title", body: "body" }
    ]);
});
requirement("P11-MCP-IMPACT-ANNOTATION", () => {
    expect(mcpDiscovery(false, { impact: "mutate" }).operations[0]?.impact).toBe("mutate");
});
requirement("P11-MCP-IMPACT-DEFAULT-LOCAL", () => {
    expect(mcpDiscovery(false).operations[0]?.impact).toBe("execute");
});
requirement("P11-MCP-IMPACT-DEFAULT-REMOTE", () => {
    expect(mcpDiscovery(true).operations[0]?.impact).toBe("externalSend");
});
requirement("P11-MCP-IMPACT-UNKNOWN", () => {
    expect(() => mcpDiscovery(false, { impact: "unknown" as never })).toThrow(/impact/);
});
requirement("P11-MCP-MALFORMED-SCHEMA", () => {
    const backend = new McpDiscoveryBackend(mcpConfig(false), {
        assertSchema: () => {
            throw new TypeError("malformed");
        }
    });
    expect(() => backend.discover(mcpDocument())).toThrow(/schema/);
});
requirement("P11-MCP-NO-LATE-SCHEMA", () => {
    let calls = 0;
    const backend = new McpDiscoveryBackend(mcpConfig(false), {
        assertSchema: () => {
            calls += 1;
            throw new TypeError("malformed");
        }
    });
    expect(() => backend.discover(mcpDocument())).toThrow();
    expect(calls).toBe(1);
});
requirement("P11-MCP-POSITIVE-BOUNDS", () => {
    expect(() => new McpPromptMaterializationContract(0, 1)).toThrow();
    expect(() => new McpPromptMaterializationContract(1, 0)).toThrow();
    expect(() => new McpPromptMaterializationContract(MCP_MAXIMUM_PROMPTS + 1, 1)).toThrow();
});
requirement("P11-MCP-PROMPT-BYTES", () => {
    const materializer = new McpPromptMaterializationContract(1, 2);
    expect(() => materializer.materialize([{ title: "é", body: "x" }])).toThrow(/bound/);
    expect(MCP_MAXIMUM_PROMPT_BYTES).toBe(262_144);
});
requirement("P11-MCP-PROMPT-COUNT", () => {
    expect(MCP_MAXIMUM_PROMPTS).toBe(32);
    expect(() => new McpPromptMaterializationContract(33, 1)).toThrow(/bound/);
});

for (const [id, name, expected] of [
    ["P11-MEMORY-RECALL", "recall", "observe"],
    ["P11-MEMORY-REMEMBER", "remember", "mutate"]
] as const) {
    impact(id, MEMORY_OPERATIONS, name, expected);
}
requirement("P11-MEMORY-COMPOSITION", () => {
    expect(MEMORY_CONTRIBUTIONS.get(new SlotName("operations"))).toBeDefined();
    expect(MEMORY_CONTRIBUTIONS.get(new SlotName("prompt"))).toBeDefined();
});
requirement("P11-MEMORY-INDEXES", () => {
    const backend = memoryBackend();
    backend.remember({ id: "entry", content: memoryContentRef, createdAt: 1 });
    const before = backend.recall({ query: "remembered" });
    backend.rebuildIndex();
    expect(backend.recall({ query: "remembered" })).toEqual(before);
});
requirement("P11-MEMORY-PRUNE-PAST", () => {
    const backend = memoryBackend();
    backend.remember({ id: "expired", content: memoryContentRef, createdAt: 1, retainUntil: 5 });
    expect(backend.prune(5)).toEqual(["expired"]);
    expect(backend.recall({ query: "remembered" })).toEqual([]);
});
requirement("P11-MEMORY-PRUNE-WITHIN", () => {
    const backend = memoryBackend();
    backend.remember({ id: "retained", content: memoryContentRef, createdAt: 1, retainUntil: 5 });
    expect(backend.prune(4)).toEqual([]);
    expect(backend.recall({ query: "remembered" }).map((entry) => entry.id)).toEqual(["retained"]);
});

for (const [id, name, expected] of [
    ["P11-SELF-CHECKPOINT", "checkpoint", "mutate"],
    ["P11-SELF-COMMIT-MESSAGE", "commitMessage", "mutate"],
    ["P11-SELF-FINISH", "finish", "mutate"],
    ["P11-SELF-PROPOSE-MIGRATION", "proposeMigration", "administer"],
    ["P11-SELF-SPAWN", "spawn", "delegate"]
] as const) {
    impact(id, SELF_OPERATIONS, name, expected);
}

impact("P11-SHELL-CANCEL", SHELL_OPERATIONS, "cancel", "mutate");

requirement("P11-SINGLE-TENANT-ASSEMBLY", () => {
    expect(SINGLE_TENANT_OPERATIONS).toEqual([]);
});
requirement("P11-SINGLE-TENANT-NO-EVENTS", () => expect(SINGLE_TENANT_EVENTS).toEqual([]));
requirement("P11-SINGLE-TENANT-NO-OPERATIONS", () => expect(SINGLE_TENANT_OPERATIONS).toEqual([]));
const tenant = new Tenant(new TenantId("personal"), "personal", "active", Revision.initial());
const principal = new Principal(new PrincipalId("owner"), "user", "active");
requirement("P11-SINGLE-TENANT-OWNER", () => expect(principal.status).toBe("active"));
requirement("P11-SINGLE-TENANT-POLICY", () => expect(tenant.kind).toBe("personal"));
requirement("P11-SINGLE-TENANT-PRINCIPAL", () => expect(principal.id.value).toBe("owner"));
requirement("P11-SINGLE-TENANT-PROMOTION", () => {
    expect(tenant.revise("suspended").id.equals(tenant.id)).toBe(true);
});
requirement("P11-SINGLE-TENANT-RECORDS", () => {
    expect(Tenant.decode(Tenant.encode(tenant)).id.equals(tenant.id)).toBe(true);
});
requirement("P11-SINGLE-TENANT-TENANT", () => expect(tenant.id.value).toBe("personal"));

for (const [id, name, expected] of [
    ["P11-SLATE-COMMIT", "commit", "mutate"],
    ["P11-SLATE-DEPLOY", "deploy", "externalSend"],
    ["P11-SLATE-FORK", "fork", "mutate"],
    ["P11-SLATE-PUBLISH", "publish", "mutate"],
    ["P11-SLATE-ROLLBACK", "rollback", "mutate"],
    ["P11-SLATE-UPDATE", "update", "mutate"]
] as const) {
    impact(id, SLATE_OPERATIONS, name, expected);
}
requirement("P11-SLATE-ROLLBACK-NO-DEPLOY", () => {
    expect(operation(SLATE_OPERATIONS, "rollback").impact).toBe("mutate");
    expect(operation(SLATE_OPERATIONS, "deploy").impact).toBe("externalSend");
});

for (const [id, name, expected] of [
    ["P11-TASK-CREATE", "create", "mutate"],
    ["P11-TASK-LIST", "list", "observe"],
    ["P11-TASK-UPDATE", "update", "mutate"]
] as const) {
    impact(id, TASK_OPERATIONS, name, expected);
}
requirement("P11-TASK-NO-BASE-LIFECYCLE", () => {
    expect(operation(TASK_OPERATIONS, "create").input.document).not.toHaveProperty("status");
});
requirement("P11-TASK-NO-RUN-COPY", () => {
    expect(operation(TASK_OPERATIONS, "create").input.document).not.toHaveProperty("runState");
});
requirement("P11-TASK-RUN-REFERENCE", () => {
    expect(
        operation(TASK_OPERATIONS, "create").input.accepts({
            task: { id: "task", runId: "run", attributes: {} }
        })
    ).toBe(true);
});
requirement("P11-TASK-RUN-RELATION", () => {
    expect(
        operation(TASK_OPERATIONS, "create").input.accepts({
            task: { id: "task", attributes: {} }
        })
    ).toBe(true);
});

function mcpConfig(remote: boolean) {
    return {
        remote,
        maximumPrompts: MCP_MAXIMUM_PROMPTS,
        maximumPromptBytes: MCP_MAXIMUM_PROMPT_BYTES
    };
}

function mcpDocument(tool: { readonly impact?: OperationDescriptor["impact"] } = {}) {
    return {
        revision: "2025-11-25",
        tools: [
            {
                name: "tool",
                inputSchema: { type: "object" } as const,
                outputSchema: { type: "object" } as const,
                ...(tool.impact === undefined
                    ? {}
                    : { _meta: { "io.agent-core/impact": tool.impact } })
            }
        ],
        resources: [],
        prompts: []
    };
}

function mcpDiscovery(
    remote: boolean,
    tool: { readonly impact?: OperationDescriptor["impact"] } = {}
) {
    return new McpDiscoveryBackend(mcpConfig(remote), { assertSchema: () => undefined }).discover(
        mcpDocument(tool)
    );
}

const memoryContentRef = ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode("memory")));

function memoryBackend(): MemoryBackend {
    const access: MemoryAccessBackend = {
        authorityForRemember: () => "owner",
        canRead: () => true,
        canForget: () => true
    };
    const content: MemoryContentBackend = {
        resolve: (_reference: ContentRef): JsonValue => ({ text: "remembered content" })
    };
    return new MemoryBackend(new InMemoryMemoryIndexBackend(), access, content);
}
