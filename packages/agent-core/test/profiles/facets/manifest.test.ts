import { CompatRange, JsonSchema, SemVer } from "../../../src/core";
import {
    APPROVAL_GATEWAY_CONTRIBUTIONS,
    ApprovalGatewayFacet,
    BindingName,
    BindingRequirement,
    Contribution,
    Contributions,
    DEVICE_CONTRIBUTIONS,
    DEVICE_ENVIRONMENT_BINDING,
    DeviceFacet,
    ENVIRONMENT_CONTRIBUTIONS,
    ENVIRONMENT_CONTROL_CONTRACTS,
    ENVIRONMENT_PROVIDER_BINDING,
    EnvironmentFacet,
    FILESYSTEM_CONTRIBUTIONS,
    FacetManifest,
    FilesystemFacet,
    FacetPackageId,
    MCP_CONTRIBUTIONS,
    MCP_CONTROL_CONTRACTS,
    MCP_PARENT_BINDING,
    MCP_PARENT_CONTRIBUTION,
    MCP_PARENT_SLOT,
    MEMORY_CONTRIBUTIONS,
    MemoryFacet,
    McpFacet,
    OperationDescriptor,
    OperationName,
    SELF_CONTRIBUTIONS,
    SelfFacet,
    SHELL_CONTRIBUTIONS,
    SHELL_REQUIRED_BINDING,
    SLATE_CONTRIBUTIONS,
    SLATE_ENVIRONMENT_BINDING,
    SINGLE_TENANT_CONTRIBUTIONS,
    SINGLE_TENANT_EVENTS,
    SINGLE_TENANT_OPERATIONS,
    SlotAuthorityPolicy,
    SlotDeclaration,
    SlotName,
    SlateFacet,
    ShellFacet,
    TASK_BOARD_SURFACE,
    TASK_CONTRIBUTIONS,
    TaskBackend,
    TaskFacet,
    WEB_CONTRIBUTIONS,
    WebFacet,
    createApprovalGatewayManifest,
    createDeviceManifest,
    createEnvironmentManifest,
    createFilesystemManifest,
    createMcpManifest,
    createMemoryManifest,
    createSelfManifest,
    createShellManifest,
    createSlateManifest,
    createStandardProfileManifest,
    createTaskManifest,
    createWebManifest,
    canonicalIsolationModes,
    type FacetData,
    type IsolationMode
} from "../../../src/facets";
import { describe, expect, test } from "vitest";
import { recordingRuntime } from "./harness";

const SingleTenant = {
    SINGLE_TENANT_CONTRIBUTIONS,
    SINGLE_TENANT_EVENTS,
    SINGLE_TENANT_OPERATIONS
};

interface ProfileManifestCase {
    readonly name: string;
    readonly create: (init: ReturnType<typeof manifestInit>) => FacetManifest;
    readonly contributions: Contributions;
    readonly runtimeOperations: readonly OperationDescriptor[];
    readonly isolation: readonly IsolationMode[];
    readonly requiredBindings?: readonly string[];
}

const profiles: readonly ProfileManifestCase[] = [
    profile(
        "filesystem",
        createFilesystemManifest,
        FILESYSTEM_CONTRIBUTIONS,
        FilesystemFacet.operations,
        ["provider", "bundled"]
    ),
    profile(
        "shell",
        createShellManifest,
        SHELL_CONTRIBUTIONS,
        ShellFacet.operations,
        ["provider", "bundled"],
        [SHELL_REQUIRED_BINDING]
    ),
    profile("memory", createMemoryManifest, MEMORY_CONTRIBUTIONS, MemoryFacet.operations, [
        "provider",
        "bundled"
    ]),
    profile("task", createTaskManifest, TASK_CONTRIBUTIONS, TaskFacet.operations, [
        "provider",
        "bundled"
    ]),
    profile("web", createWebManifest, WEB_CONTRIBUTIONS, WebFacet.operations, ["provider"]),
    profile(
        "mcp",
        createMcpManifest,
        MCP_CONTRIBUTIONS,
        McpFacet.operations,
        ["provider", "bundled"],
        [MCP_PARENT_BINDING]
    ),
    profile(
        "approval",
        createApprovalGatewayManifest,
        APPROVAL_GATEWAY_CONTRIBUTIONS,
        ApprovalGatewayFacet.operations,
        ["provider"]
    ),
    profile("self", createSelfManifest, SELF_CONTRIBUTIONS, SelfFacet.operations, ["bundled"]),
    profile(
        "environment",
        createEnvironmentManifest,
        ENVIRONMENT_CONTRIBUTIONS,
        EnvironmentFacet.operations,
        ["provider"],
        [ENVIRONMENT_PROVIDER_BINDING]
    ),
    profile(
        "device",
        createDeviceManifest,
        DEVICE_CONTRIBUTIONS,
        DeviceFacet.operations,
        ["provider"],
        [DEVICE_ENVIRONMENT_BINDING]
    ),
    profile(
        "slate",
        createSlateManifest,
        SLATE_CONTRIBUTIONS,
        SlateFacet.operations,
        ["dynamic"],
        [SLATE_ENVIRONMENT_BINDING]
    )
];

const expectedProfileOperations: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    filesystem: {
        read: "observe",
        stat: "observe",
        list: "observe",
        write: "mutate",
        remove: "mutate",
        move: "mutate",
        mkdir: "mutate"
    },
    shell: { run: "execute", cancel: "mutate" },
    memory: { remember: "mutate", recall: "observe", forget: "mutate" },
    task: { create: "mutate", update: "mutate", list: "observe" },
    web: { fetch: "externalSend", search: "externalSend", readCached: "observe" },
    mcp: {},
    approval: { observe: "observe", applyAction: "externalSend" },
    self: {
        checkpoint: "mutate",
        commitMessage: "mutate",
        spawn: "delegate",
        finish: "mutate",
        proposeMigration: "administer"
    },
    environment: {},
    device: {
        camera: "externalSend",
        location: "externalSend",
        sms: "externalSend",
        screen: "externalSend",
        "system.run": "externalSend",
        readCached: "observe"
    },
    slate: {
        update: "mutate",
        commit: "mutate",
        fork: "mutate",
        publish: "mutate",
        deploy: "externalSend",
        rollback: "mutate"
    }
};

describe("W8 internal profile manifest/runtime correspondence", () => {
    test.each(profiles)(
        "$name manifest round-trips with exact closed contributions",
        (candidate) => {
            const manifest = candidate.create(
                manifestInit(candidate.name, candidate.requiredBindings)
            );
            const decoded = FacetManifest.decode(FacetManifest.encode(manifest));

            expect(decoded.toData()).toEqual(manifest.toData());
            expect(manifest.contributions).toBe(candidate.contributions);
            expect(manifest.contributions.toData()).toEqual(candidate.contributions.toData());
            expect(manifest.isolation).toEqual(candidate.isolation);
            const expected = expectedProfileOperations[candidate.name];
            expect(expected).toBeDefined();
            expect(operationImpacts(contributedOperations(manifest))).toEqual(expected);
            expect(operationImpacts(candidate.runtimeOperations)).toEqual(expected);
            manifest.configSchema?.assertValid();
            for (const operation of candidate.runtimeOperations) {
                operation.input.assertValid();
                operation.output.assertValid();
            }
        }
    );

    test.each(profiles.filter((candidate) => candidate.requiredBindings !== undefined))(
        "$name refuses a manifest missing its required composition binding",
        (candidate) => {
            expect(() => candidate.create(manifestInit(candidate.name))).toThrow(
                /requires binding/u
            );
        }
    );

    test("fixes provider-only Approval placement and dynamic zero-ambient Slate constraints", () => {
        const approval = createApprovalGatewayManifest(manifestInit("approval"));
        expect(approval.isolation).toEqual(["provider"]);

        const slate = createSlateManifest(manifestInit("slate", [SLATE_ENVIRONMENT_BINDING]));
        expect(slate.isolation).toEqual(["dynamic"]);
        expect(slate.bindings.map((binding) => binding.name.value)).toContain(
            SLATE_ENVIRONMENT_BINDING
        );
        expect(
            slate.configSchema?.accepts({
                backendIsolation: "dynamic",
                ambientAuthority: false
            })
        ).toBe(true);
        expect(
            slate.configSchema?.accepts({
                backendIsolation: "dynamic",
                ambientAuthority: true
            })
        ).toBe(false);
    });

    test("[P11-SLATE-DYNAMIC] rejects ambient authority from the dynamic backend configuration", () => {
        const slate = createSlateManifest(
            manifestInit("slate-dynamic", [SLATE_ENVIRONMENT_BINDING])
        );
        expect(slate.isolation).toEqual(["dynamic"]);
        expect(
            slate.configSchema?.accepts({ backendIsolation: "dynamic", ambientAuthority: false })
        ).toBe(true);
        expect(
            slate.configSchema?.accepts({ backendIsolation: "dynamic", ambientAuthority: true })
        ).toBe(false);
        expect(
            slate.configSchema?.accepts({ backendIsolation: "provider", ambientAuthority: false })
        ).toBe(false);
    });

    test("[P11-SLATE-BINDINGS] requires the Environment capability as an explicit Binding", () => {
        expect(() => createSlateManifest(manifestInit("slate-unbound"))).toThrow(
            /requires binding/u
        );
        const bound = createSlateManifest(manifestInit("slate-bound", [SLATE_ENVIRONMENT_BINDING]));
        expect(bound.bindings.map((binding) => binding.name.value)).toEqual([
            SLATE_ENVIRONMENT_BINDING
        ]);
    });

    test("declares MCP parent controls/config without static discovered Operations", () => {
        const manifest = createMcpManifest(manifestInit("mcp", [MCP_PARENT_BINDING]));
        expect(contributedOperations(manifest)).toEqual([]);
        expect(manifest.contributions.entries.map((entry) => entry.slot.value)).toEqual([
            "mcp.parent",
            "slots"
        ]);
        expect(MCP_PARENT_SLOT.entrySchema.accepts(MCP_PARENT_CONTRIBUTION)).toBe(true);
        expect(
            manifest.configSchema?.accepts({
                remote: true,
                maximumPrompts: 2,
                maximumPromptBytes: 100
            })
        ).toBe(true);
        for (const contract of Object.values(MCP_CONTROL_CONTRACTS)) {
            contract.input.assertValid();
            contract.output.assertValid();
        }
        for (const contract of Object.values(ENVIRONMENT_CONTROL_CONTRACTS)) {
            contract.input.assertValid();
            contract.output.assertValid();
        }
    });

    test("keeps Single-tenant explicitly policy-only with no Facet manifest factory", () => {
        expect("createSingleTenantManifest" in SingleTenant).toBe(false);
        expect(SingleTenant.SINGLE_TENANT_OPERATIONS).toEqual([]);
    });

    test("exposes the W8 internal runtime contract from every actual Facet facade", () => {
        const facades = [
            FilesystemFacet,
            ShellFacet,
            MemoryFacet,
            TaskFacet,
            WebFacet,
            ApprovalGatewayFacet,
            SelfFacet,
            EnvironmentFacet,
            DeviceFacet,
            SlateFacet
        ];
        expect(
            facades.every((facade) => typeof facade.prototype.asInternalRuntime === "function")
        ).toBe(true);
        expect("asInternalRuntime" in McpFacet.prototype).toBe(false);
    });

    test("coalesces concurrent lifecycle start/stop and gates the shared runtime", async () => {
        const lifecyclePort = recordingRuntime("task").runtime;
        lifecyclePort.deactivate();
        const internal = new TaskFacet(lifecyclePort, new TaskBackend()).asInternalRuntime(
            createTaskManifest(manifestInit("task"))
        );
        const context = { signal: new AbortController().signal };
        await Promise.all([internal.start(context), internal.start(context)]);
        expect(internal.active).toBe(true);
        await Promise.all([internal.stop(context), internal.stop(context)]);
        expect(internal.active).toBe(false);
    });

    test("preserves caller identity/config/bindings but rejects undeclared contributions", () => {
        const init = manifestInit("filesystem", ["caller.binding"]);
        const manifest = createFilesystemManifest(init);
        expect(manifest.id).toBe(init.id);
        expect(manifest.version).toBe(init.version);
        expect(manifest.compat).toBe(init.compat);
        expect(manifest.configSchema).toBe(init.configSchema);
        expect(manifest.bindings).toEqual(init.bindings);

        expect(() =>
            createStandardProfileManifest(init, {
                isolation: ["dynamic"],
                contributions: new Contributions([
                    new Contribution(new SlotName("undeclared.profile-slot"), [{}])
                ])
            })
        ).toThrow(/undeclared slot/u);
    });

    test("validates optional config composition, prompt shape, and declared custom entries", () => {
        const { configSchema: _configSchema, ...withoutConfig } = manifestInit("minimal");
        const unconstrained = createStandardProfileManifest(withoutConfig, {
            isolation: ["bundled"],
            contributions: Contributions.empty()
        });
        expect(unconstrained.configSchema).toBeUndefined();

        const constraint = new JsonSchema({
            type: "object",
            properties: { enabled: { type: "boolean" } },
            required: ["enabled"]
        });
        const constrained = createStandardProfileManifest(withoutConfig, {
            isolation: ["provider"],
            contributions: Contributions.empty(),
            configConstraint: constraint
        });
        expect(constrained.configSchema).toBe(constraint);

        expect(() =>
            createStandardProfileManifest(withoutConfig, {
                isolation: ["bundled"],
                contributions: new Contributions([new Contribution(new SlotName("prompt"), [{}])])
            })
        ).toThrow(/Prompt contribution must be an array/u);

        const customSlot = new SlotDeclaration(
            new SlotName("profile.custom"),
            new JsonSchema({ type: "integer" }),
            new SlotAuthorityPolicy(["installed"], ["scope.read"])
        );
        expect(() =>
            createStandardProfileManifest(withoutConfig, {
                isolation: ["bundled"],
                contributions: new Contributions([
                    new Contribution(new SlotName("slots"), [customSlot.toData()]),
                    new Contribution(new SlotName("profile.custom"), ["wrong"])
                ])
            })
        ).toThrow(/does not match slot/u);
    });

    test("provides internal lookup/surface/lifecycle/children without claiming the external Facet base", async () => {
        const manifest = createTaskManifest(manifestInit("task"));
        const { runtime } = recordingRuntime("task");
        runtime.deactivate();
        const facet = new TaskFacet(runtime, new TaskBackend());
        const internal = facet.asInternalRuntime(manifest);
        expect(internal.manifest).toBe(manifest);
        expect(internal.operation(new OperationName("create"))?.descriptor.name.value).toBe(
            "create"
        );
        expect(internal.operation(new OperationName("missing"))).toBeUndefined();
        expect(internal.surface(TASK_BOARD_SURFACE.id)?.descriptor).toBe(TASK_BOARD_SURFACE);
        expect(internal.children()).toEqual([]);
        await expect(facet.list()).rejects.toMatchObject({ code: "facet.inactive" });
        const context = { signal: new AbortController().signal };
        await internal.start(context);
        await internal.start(context);
        expect(internal.active).toBe(true);
        await expect(facet.list()).resolves.toEqual([]);
        await internal.stop(context);
        await internal.stop(context);
        expect(internal.active).toBe(false);
        await expect(facet.list()).rejects.toMatchObject({ code: "facet.inactive" });
        const mismatchedFacade = new TaskFacet(
            recordingRuntime("filesystem").runtime,
            new TaskBackend()
        );
        expect(() =>
            mismatchedFacade.asInternalRuntime(createFilesystemManifest(manifestInit("filesystem")))
        ).toThrow(/declarations do not match/u);
    });
});

describe("Facet manifest data validation", () => {
    test("freezes binding requirements and validates isolation modes", { tags: "p1" }, () => {
        const requirement = new BindingRequirement(
            new BindingName("env"),
            new FacetPackageId("dependency.env"),
            new CompatRange("^1.0.0", "^1.0.0")
        );
        expect(Object.isFrozen(requirement)).toBe(true);
        expect(() => canonicalIsolationModes(["dynamic", "bogus"] as never)).toThrow(
            "Manifest isolation modes must contain known values"
        );
    });

    test("round-trips the config schema document through toData and codec", { tags: "p1" }, () => {
        const manifest = createFilesystemManifest(manifestInit("filesystem"));
        expect(manifest.toData()).toMatchObject({ configSchema: { type: "object" } });
        const decoded = FacetManifest.decode(FacetManifest.encode(manifest));
        expect(decoded.configSchema?.document).toEqual({ type: "object" });
    });

    test("accepts boolean config schemas and rejects other documents", { tags: "p1" }, () => {
        expect(
            FacetManifest.fromData(manifestData({ configSchema: true })).configSchema?.document
        ).toBe(true);
        expect(() => FacetManifest.fromData(manifestData({ configSchema: null }))).toThrow(
            "Manifest config schema must be an object or boolean"
        );
        expect(() => FacetManifest.fromData(manifestData({ configSchema: [] }))).toThrow(
            "Manifest config schema must be an object or boolean"
        );
        expect(() => FacetManifest.fromData(manifestData({ isolation: ["bogus"] }))).toThrow(
            "Manifest isolation mode is invalid"
        );
    });

    test("labels malformed manifest and binding fields in messages", { tags: "p2" }, () => {
        expect(() => FacetManifest.fromData(manifestData({ id: 1 }))).toThrow(
            "Facet package ID must be a string"
        );
        expect(() => FacetManifest.fromData(manifestData({ version: 1 }))).toThrow(
            "Facet version must be a string"
        );
        expect(() =>
            FacetManifest.fromData(manifestData({ contributions: { custom: "nope" } }))
        ).toThrow("Manifest contribution custom must be an array");
        expect(() =>
            BindingRequirement.fromData({
                name: 1,
                facet: "dependency.env",
                compat: { host: "^1.0.0", spec: "^1.0.0" }
            })
        ).toThrow("Binding name must be a string");
        expect(() =>
            BindingRequirement.fromData({
                name: "env",
                facet: 1,
                compat: { host: "^1.0.0", spec: "^1.0.0" }
            })
        ).toThrow("Binding facet must be a string");
    });
});

function manifestData(overrides: { readonly [key: string]: FacetData }): FacetData {
    return {
        bindings: [],
        compat: { host: "^1.0.0", spec: "^1.0.0" },
        contributions: {},
        id: "profile.sample",
        isolation: ["provider"],
        version: "1.2.3",
        ...overrides
    };
}

function profile(
    name: string,
    create: ProfileManifestCase["create"],
    contributions: Contributions,
    runtimeOperations: readonly OperationDescriptor[],
    isolation: readonly IsolationMode[],
    requiredBindings?: readonly string[]
): ProfileManifestCase {
    return {
        name,
        create,
        contributions,
        runtimeOperations,
        isolation,
        ...(requiredBindings === undefined ? {} : { requiredBindings })
    };
}

function manifestInit(name: string, bindings: readonly string[] = []) {
    return {
        id: new FacetPackageId(`profile.${name}`),
        version: new SemVer("1.2.3"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        bindings: bindings.map(
            (binding) =>
                new BindingRequirement(
                    new BindingName(binding),
                    new FacetPackageId(`dependency.${binding}`),
                    new CompatRange("^1.0.0", "^1.0.0")
                )
        ),
        configSchema: new JsonSchema({ type: "object" })
    };
}

function contributedOperations(manifest: FacetManifest): readonly OperationDescriptor[] {
    return (manifest.contributions.get(new SlotName("operations")) ?? []).map(
        OperationDescriptor.fromData
    );
}

function operationImpacts(
    operations: readonly OperationDescriptor[]
): Readonly<Record<string, string>> {
    return Object.fromEntries(
        operations.map((operation) => [operation.name.value, operation.impact])
    );
}
