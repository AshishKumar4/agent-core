import {
    Digest,
    JsonSchema,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonSchemaDocument,
    type JsonValue
} from "../../core";
import { Contributions, Contribution, OperationDescriptor, type Impact } from "../contribution";
import {
    DataRecordCodec,
    requireArray,
    requireBoolean,
    requireDataObject,
    requireExactFields,
    requireString,
    type FacetData
} from "../data";
import { OperationName, SlotName } from "../id";
import { Prompt, PromptContribution } from "../prompt";
import { SlotAuthorityPolicy, SlotDeclaration } from "../slot";
import {
    DetailedProfileError,
    ProfileControlContract,
    ProfileOperationContract,
    facetDataWireCodec,
    profileWireCodec,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema,
    voidProfileWireCodec
} from "../profile-runtime";

export interface McpSchemaBoundary {
    assertSchema(schema: JsonSchemaDocument): void;
}

export interface McpToolDiscovery {
    readonly name: string;
    readonly inputSchema: JsonSchemaDocument;
    readonly outputSchema: JsonSchemaDocument;
    readonly _meta?: Readonly<Record<string, JsonValue>>;
}

export interface McpResourceDiscovery {
    readonly name: string;
    readonly outputSchema: JsonSchemaDocument;
}

export interface McpPromptDiscovery {
    readonly title: string;
    readonly body: string;
}

export interface McpDiscoveryDocument {
    readonly revision: string;
    readonly tools: readonly McpToolDiscovery[];
    readonly resources: readonly McpResourceDiscovery[];
    readonly prompts: readonly McpPromptDiscovery[];
}

export interface McpDiscoveryResult {
    readonly operations: readonly OperationDescriptor[];
    readonly prompts: readonly McpPromptDiscovery[];
    readonly promptContribution: PromptContribution;
    readonly contributions: Contributions;
}

export interface McpFacetConfig {
    readonly remote: boolean;
    readonly maximumPrompts: number;
    readonly maximumPromptBytes: number;
}

export interface McpEmptyControlInput extends PublicProfileInput {}

export interface McpCallInput extends PublicProfileInput {
    readonly operation: string;
    readonly arguments: JsonValue;
}

export const MCP_OPERATIONS: readonly OperationDescriptor[] = Object.freeze([]);
export const MCP_PROTOCOL_REVISION = "2025-11-25";
export const MCP_MAXIMUM_PROMPTS = 32;
export const MCP_MAXIMUM_PROMPT_BYTES = 262_144;
export const MCP_IMPACT_ANNOTATION = "io.agent-core/impact";

export class McpDiscoveryRegistration {
    public readonly document: McpDiscoveryDocument;
    public readonly digest: Digest;

    public constructor(document: McpDiscoveryDocument, expectedDigest?: Digest) {
        const bytes = canonicalDiscoveryBytes(document);
        const digest = Digest.sha256(bytes);
        if (expectedDigest !== undefined && !digest.equals(expectedDigest)) {
            throw new TypeError("MCP discovery registration digest does not match its document");
        }
        this.document = freezeDiscoveryDocument(
            decodeCanonicalJson(bytes) as unknown as McpDiscoveryDocument
        );
        this.digest = digest;
        Object.freeze(this);
    }

    public static encode(registration: McpDiscoveryRegistration): Uint8Array {
        return mcpDiscoveryRegistrationCodec.encode(registration);
    }

    public static decode(bytes: Uint8Array): McpDiscoveryRegistration {
        return mcpDiscoveryRegistrationCodec.decode(bytes);
    }

    public toData(): FacetData {
        return {
            digest: this.digest.value,
            document: this.document as unknown as FacetData
        };
    }
}

const mcpDiscoveryRegistrationCodec = new DataRecordCodec(
    "facet.mcp-discovery-registration",
    (registration: McpDiscoveryRegistration) => registration.toData(),
    (payload) => {
        const object = requireDataObject(payload, "MCP discovery registration");
        requireExactFields(object, ["digest", "document"]);
        return new McpDiscoveryRegistration(
            object["document"] as unknown as McpDiscoveryDocument,
            new Digest(requireString(object["digest"], "MCP discovery digest"))
        );
    }
);

export abstract class McpDiscoveryRegistrationStore {
    public abstract load(): McpDiscoveryRegistration | undefined;
    public abstract save(registration: McpDiscoveryRegistration): void;
}

export class MemoryMcpDiscoveryRegistrationStore extends McpDiscoveryRegistrationStore {
    #bytes: Uint8Array | undefined;

    public constructor(snapshot?: Uint8Array) {
        super();
        this.#bytes = snapshot?.slice();
    }

    public load(): McpDiscoveryRegistration | undefined {
        return this.#bytes === undefined
            ? undefined
            : McpDiscoveryRegistration.decode(this.#bytes.slice());
    }

    public save(registration: McpDiscoveryRegistration): void {
        this.#bytes = McpDiscoveryRegistration.encode(registration);
    }

    public snapshot(): Uint8Array | undefined {
        return this.#bytes?.slice();
    }
}

export class McpPromptMaterializationContract {
    public constructor(
        public readonly maximumPrompts: number,
        public readonly maximumBytes: number
    ) {
        if (
            !Number.isSafeInteger(maximumPrompts) ||
            maximumPrompts <= 0 ||
            maximumPrompts > MCP_MAXIMUM_PROMPTS ||
            !Number.isSafeInteger(maximumBytes) ||
            maximumBytes <= 0 ||
            maximumBytes > MCP_MAXIMUM_PROMPT_BYTES
        ) {
            throw new TypeError("MCP prompt materialization bounds must be positive safe integers");
        }
        Object.freeze(this);
    }

    public materialize(prompts: readonly McpPromptDiscovery[]): PromptContribution {
        if (prompts.length > this.maximumPrompts || promptBytes(prompts) > this.maximumBytes) {
            throw new McpDiscoveryError(
                "prompt.bound",
                "MCP prompt contribution exceeds its configured bound"
            );
        }
        try {
            return new PromptContribution(
                prompts.map((prompt) => new Prompt(prompt.title, prompt.body, 0))
            );
        } catch {
            throw new McpDiscoveryError(
                "schema.invalid",
                "MCP prompt declaration is invalid at discovery"
            );
        }
    }
}

export abstract class McpServerBackend {
    public abstract start(): Promise<void>;
    public abstract health(): Promise<boolean>;
    public abstract stop(): Promise<void>;
    public abstract discover(): Promise<McpDiscoveryDocument>;
    public abstract call(operation: string, input: JsonValue): Promise<JsonValue>;
}

export class McpDiscoveryBackend {
    readonly #promptMaterialization: McpPromptMaterializationContract;

    public constructor(
        private readonly config: McpFacetConfig,
        private readonly schemas: McpSchemaBoundary
    ) {
        if (
            !Number.isSafeInteger(config.maximumPrompts) ||
            config.maximumPrompts <= 0 ||
            config.maximumPrompts > MCP_MAXIMUM_PROMPTS ||
            !Number.isSafeInteger(config.maximumPromptBytes) ||
            config.maximumPromptBytes <= 0 ||
            config.maximumPromptBytes > MCP_MAXIMUM_PROMPT_BYTES
        ) {
            throw new TypeError("MCP prompt bounds must be positive safe integers");
        }
        this.#promptMaterialization = new McpPromptMaterializationContract(
            config.maximumPrompts,
            config.maximumPromptBytes
        );
    }

    public discover(document: McpDiscoveryDocument): McpDiscoveryResult {
        return this.validate(document).result;
    }

    public validate(document: McpDiscoveryDocument): {
        readonly registration: McpDiscoveryRegistration;
        readonly result: McpDiscoveryResult;
    } {
        requireDiscoveryDocument(document);
        if (document.revision !== MCP_PROTOCOL_REVISION) {
            throw new McpDiscoveryError(
                "revision.mismatch",
                "MCP server revision does not match its configured pin"
            );
        }
        const promptContribution = this.#promptMaterialization.materialize(document.prompts);

        const names = new Set<string>();
        const operations: OperationDescriptor[] = [];
        for (const tool of document.tools) {
            requireUniqueName(tool.name, names);
            this.assertSchema(tool.inputSchema);
            this.assertSchema(tool.outputSchema);
            operations.push(
                new OperationDescriptor(
                    new OperationName(tool.name),
                    toolImpact(tool, this.config.remote),
                    new JsonSchema(tool.inputSchema),
                    new JsonSchema(tool.outputSchema)
                )
            );
        }
        for (const resource of document.resources) {
            requireUniqueName(resource.name, names);
            this.assertSchema(resource.outputSchema);
            operations.push(
                new OperationDescriptor(
                    new OperationName(resource.name),
                    "observe",
                    new JsonSchema({ type: "object", additionalProperties: false }),
                    new JsonSchema(resource.outputSchema)
                )
            );
        }
        const prompts = Object.freeze(
            document.prompts.map((prompt) => Object.freeze({ ...prompt }))
        );
        const projected: Contribution[] = [];
        if (operations.length > 0) {
            projected.push(
                new Contribution(
                    new SlotName("operations"),
                    operations.map((operation) => operation.toData())
                )
            );
        }
        if (promptContribution.sections.length > 0) {
            projected.push(new Contribution(new SlotName("prompt"), [promptContribution.toData()]));
        }
        const result = Object.freeze({
            operations: Object.freeze(operations),
            prompts,
            promptContribution,
            contributions: new Contributions(projected)
        });
        return Object.freeze({ registration: new McpDiscoveryRegistration(document), result });
    }

    public restore(registration: McpDiscoveryRegistration): McpDiscoveryResult {
        const validated = this.validate(registration.document);
        if (!validated.registration.digest.equals(registration.digest)) {
            throw new McpDiscoveryError(
                "registration.invalid",
                "Persisted MCP discovery registration digest is invalid"
            );
        }
        return validated.result;
    }

    private assertSchema(candidate: JsonSchemaDocument): void {
        try {
            this.schemas.assertSchema(candidate);
        } catch {
            throw new McpDiscoveryError("schema.invalid", "MCP schema is invalid at discovery");
        }
    }
}

const emptySchema = strictObjectSchema({});
const voidSchema = schema({ type: "null" });
const emptyInputCodec = profileWireCodec<McpEmptyControlInput>(
    () => ({}),
    (data) => {
        requireDataObject(data, "MCP control input");
        return {};
    }
);

export const MCP_CONTROL_CONTRACTS = Object.freeze({
    start: new ProfileControlContract<"mcp.start", McpEmptyControlInput, void>(
        "mcp.start",
        emptySchema,
        voidSchema,
        emptyInputCodec,
        voidProfileWireCodec
    ),
    health: new ProfileControlContract<"mcp.health", McpEmptyControlInput, boolean>(
        "mcp.health",
        emptySchema,
        schema({ type: "boolean" }),
        emptyInputCodec,
        profileWireCodec(
            (value) => value,
            (data) => requireBoolean(data, "MCP health")
        )
    ),
    stop: new ProfileControlContract<"mcp.stop", McpEmptyControlInput, void>(
        "mcp.stop",
        emptySchema,
        voidSchema,
        emptyInputCodec,
        voidProfileWireCodec
    ),
    discover: new ProfileControlContract<"mcp.discover", McpEmptyControlInput, McpDiscoveryResult>(
        "mcp.discover",
        emptySchema,
        schema({
            type: "object",
            properties: {
                operations: { type: "array", items: { type: "object" } },
                prompts: { type: "array", items: { type: "object" } },
                promptContribution: { type: "array", items: { type: "object" } },
                contributions: { type: "object" }
            },
            required: ["operations", "prompts", "promptContribution", "contributions"],
            additionalProperties: false
        }),
        emptyInputCodec,
        profileWireCodec(
            (result) => ({
                operations: result.operations.map((operation) => operation.toData()),
                prompts: result.prompts.map((prompt) => ({ ...prompt })),
                promptContribution: result.promptContribution.toData(),
                contributions: result.contributions.toData()
            }),
            decodeDiscoveryResult
        )
    )
});
export const MCP_PARENT_DECLARATION = Object.freeze({
    lifecycle: Object.freeze([
        MCP_CONTROL_CONTRACTS.start,
        MCP_CONTROL_CONTRACTS.health,
        MCP_CONTROL_CONTRACTS.stop
    ]),
    discovery: MCP_CONTROL_CONTRACTS.discover
});
export const MCP_PARENT_SLOT = new SlotDeclaration(
    new SlotName("mcp.parent"),
    strictObjectSchema(
        {
            lifecycle: {
                type: "array",
                prefixItems: [
                    { const: "mcp.start" },
                    { const: "mcp.health" },
                    { const: "mcp.stop" }
                ],
                minItems: 3,
                maxItems: 3
            },
            discovery: { const: "mcp.discover" },
            promptBounds: {
                type: "object",
                properties: {
                    maximumPrompts: { const: "config.maximumPrompts" },
                    maximumBytes: { const: "config.maximumPromptBytes" }
                },
                required: ["maximumPrompts", "maximumBytes"],
                additionalProperties: false
            }
        },
        ["lifecycle", "discovery", "promptBounds"]
    ),
    new SlotAuthorityPolicy(["installed"], ["scope.read"])
);
export const MCP_PARENT_CONTRIBUTION = Object.freeze({
    lifecycle: Object.freeze(["mcp.start", "mcp.health", "mcp.stop"]),
    discovery: "mcp.discover",
    promptBounds: Object.freeze({
        maximumPrompts: "config.maximumPrompts",
        maximumBytes: "config.maximumPromptBytes"
    })
});
export const MCP_CONTRIBUTIONS = new Contributions([
    new Contribution(new SlotName("slots"), [MCP_PARENT_SLOT.toData()]),
    new Contribution(new SlotName("mcp.parent"), [MCP_PARENT_CONTRIBUTION])
]);

export class McpFacet<Receipt> {
    public static readonly operations = MCP_OPERATIONS;

    readonly #operations = new Map<
        string,
        ProfileOperationContract<string, JsonValue, JsonValue>
    >();

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly discovery: McpDiscoveryBackend,
        private readonly server: McpServerBackend,
        private readonly registrations: McpDiscoveryRegistrationStore
    ) {
        const registration = registrations.load();
        if (registration !== undefined) this.install(discovery.restore(registration));
    }

    public start(input: McpEmptyControlInput = {}): Promise<void> {
        return this.runtime.control(MCP_CONTROL_CONTRACTS.start, input, () => this.server.start());
    }

    public health(input: McpEmptyControlInput = {}): Promise<boolean> {
        return this.runtime.control(MCP_CONTROL_CONTRACTS.health, input, () =>
            this.server.health()
        );
    }

    public stop(input: McpEmptyControlInput = {}): Promise<void> {
        return this.runtime.control(MCP_CONTROL_CONTRACTS.stop, input, () => this.server.stop());
    }

    public discover(input: McpEmptyControlInput = {}): Promise<McpDiscoveryResult> {
        return this.runtime.control(MCP_CONTROL_CONTRACTS.discover, input, async () => {
            const validated = this.discovery.validate(await this.server.discover());
            this.registrations.save(validated.registration);
            this.install(validated.result);
            return validated.result;
        });
    }

    public call(input: McpCallInput): Promise<JsonValue> {
        const contract = this.#operations.get(input.operation);
        if (contract === undefined) {
            throw new McpDiscoveryError(
                "operation.missing",
                "MCP operation was not registered by discovery"
            );
        }
        return this.runtime.invoke(contract, input.arguments, (admitted) =>
            this.server.call(input.operation, admitted)
        );
    }

    private install(result: McpDiscoveryResult): void {
        const operations = result.operations.map(
            (descriptor) =>
                [
                    descriptor.name.value,
                    new ProfileOperationContract(
                        descriptor.name.value,
                        descriptor,
                        facetDataWireCodec<JsonValue>(),
                        facetDataWireCodec<JsonValue>(),
                        "output"
                    )
                ] as const
        );
        this.#operations.clear();
        for (const [name, contract] of operations) this.#operations.set(name, contract);
    }
}

const IMPACTS: readonly Impact[] = Object.freeze([
    "observe",
    "mutate",
    "externalSend",
    "execute",
    "delegate",
    "administer"
]);

export type McpDiscoveryErrorCode =
    | "revision.mismatch"
    | "schema.invalid"
    | "prompt.bound"
    | "name.duplicate"
    | "impact.invalid"
    | "registration.invalid"
    | "operation.missing";

export class McpDiscoveryError extends DetailedProfileError<McpDiscoveryErrorCode> {
    public constructor(detailCode: McpDiscoveryErrorCode, message: string) {
        super(
            detailCode === "operation.missing" ? "operation.missing" : "operation.invalid-input",
            detailCode,
            message
        );
        this.name = "McpDiscoveryError";
    }
}

function requireUniqueName(name: string, names: Set<string>): void {
    if (name.trim().length === 0 || name !== name.trim() || names.has(name)) {
        throw new McpDiscoveryError(
            "name.duplicate",
            "MCP operation names must be nonblank and unique"
        );
    }
    names.add(name);
}

function requireImpact(value: Impact): Impact {
    if (!IMPACTS.includes(value))
        throw new McpDiscoveryError("impact.invalid", "MCP tool impact is invalid");
    return value;
}

function toolImpact(tool: McpToolDiscovery, remote: boolean): Impact {
    const candidate = tool as unknown as Record<string, unknown>;
    if (Object.hasOwn(candidate, "impact")) {
        throw new McpDiscoveryError(
            "impact.invalid",
            `MCP impact must use _meta["${MCP_IMPACT_ANNOTATION}"]`
        );
    }
    const metadata = candidate["_meta"];
    if (metadata === undefined) return remote ? "externalSend" : "execute";
    if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
        throw new McpDiscoveryError("impact.invalid", "MCP tool metadata must be an object");
    }
    const value = (metadata as Record<string, unknown>)[MCP_IMPACT_ANNOTATION];
    if (value === undefined) return remote ? "externalSend" : "execute";
    if (typeof value !== "string") {
        throw new McpDiscoveryError("impact.invalid", "MCP tool impact metadata must be a string");
    }
    return requireImpact(value as Impact);
}

function requireDiscoveryDocument(document: McpDiscoveryDocument): void {
    try {
        const candidate = document as unknown as Record<string, unknown>;
        if (
            document === null ||
            Array.isArray(document) ||
            typeof document !== "object" ||
            typeof candidate["revision"] !== "string" ||
            !Array.isArray(candidate["tools"]) ||
            !Array.isArray(candidate["resources"]) ||
            !Array.isArray(candidate["prompts"])
        ) {
            throw new TypeError("MCP discovery document is malformed");
        }
        for (const tool of document.tools) {
            if (
                tool === null ||
                Array.isArray(tool) ||
                typeof tool !== "object" ||
                typeof tool.name !== "string" ||
                !("inputSchema" in tool) ||
                !("outputSchema" in tool)
            ) {
                throw new TypeError("MCP tool discovery is malformed");
            }
        }
        for (const resource of document.resources) {
            if (
                resource === null ||
                Array.isArray(resource) ||
                typeof resource !== "object" ||
                typeof resource.name !== "string" ||
                !("outputSchema" in resource)
            ) {
                throw new TypeError("MCP resource discovery is malformed");
            }
        }
        for (const prompt of document.prompts) {
            if (
                prompt === null ||
                Array.isArray(prompt) ||
                typeof prompt !== "object" ||
                typeof prompt.title !== "string" ||
                typeof prompt.body !== "string"
            ) {
                throw new TypeError("MCP prompt discovery is malformed");
            }
        }
        canonicalDiscoveryBytes(document);
    } catch (error) {
        if (error instanceof McpDiscoveryError) throw error;
        throw new McpDiscoveryError("schema.invalid", "MCP discovery document is malformed");
    }
}

function canonicalDiscoveryBytes(document: McpDiscoveryDocument): Uint8Array {
    return encodeCanonicalJson(document as unknown as JsonValue);
}

function freezeDiscoveryDocument(document: McpDiscoveryDocument): McpDiscoveryDocument {
    return freezeJson(document as unknown as JsonValue) as unknown as McpDiscoveryDocument;
}

function freezeJson(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        for (const item of value) freezeJson(item);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === "object") {
        for (const item of Object.values(value)) freezeJson(item);
        return Object.freeze(value);
    }
    return value;
}

function promptBytes(prompts: readonly McpPromptDiscovery[]): number {
    return encodeCanonicalJson(
        prompts.map((prompt) => ({ title: prompt.title, body: prompt.body }))
    ).byteLength;
}

function decodeDiscoveryResult(data: import("../data").FacetData): McpDiscoveryResult {
    const object = requireDataObject(data, "MCP discovery result");
    const prompts = Object.freeze(
        requireArray(object["prompts"], "MCP prompts").map((value) => {
            const prompt = requireDataObject(value, "MCP prompt");
            return Object.freeze({
                title: requireString(prompt["title"], "MCP prompt title"),
                body: requireString(prompt["body"], "MCP prompt body")
            });
        })
    );
    return Object.freeze({
        operations: Object.freeze(
            requireArray(object["operations"], "MCP operations").map(OperationDescriptor.fromData)
        ),
        prompts,
        promptContribution: new PromptContribution(
            requireArray(object["promptContribution"], "MCP prompt contribution").map(
                Prompt.fromData
            )
        ),
        contributions: Contributions.fromMap(
            Object.fromEntries(
                Object.entries(
                    requireDataObject(object["contributions"] ?? null, "MCP contributions")
                ).map(([slot, entries]) => [
                    slot,
                    requireArray(entries ?? null, `MCP contribution ${slot}`)
                ])
            )
        )
    });
}
