// @ts-nocheck
import type { JsonValue } from "../../core";
import type { PrincipalRef } from "../../identity";
import { Command } from "../command";
import {
    Contributions,
    Contribution,
    OperationDescriptor,
    SurfaceDescriptor
} from "../contribution";
import type { FacetDataMap } from "../data";
import { canonicalFacetData, requireDataObject, requireString } from "../data";
import { EventDeclaration } from "../event";
import { BindingName, EventKind, OperationName, OperationRef, SlotName, SurfaceId } from "../id";
import { DeviceCommandId, DeviceId } from "./id";
import type { FacetManifest } from "../manifest";
import { SlotAuthorityPolicy, SlotDeclaration } from "../slot";
import {
    DetailedProfileError,
    InternalProfileFacetRuntime,
    ProfileControlContract,
    ProfileEffectContext,
    ProfileEventContract,
    ProfileOperationContract,
    facetDataWireCodec,
    profileWireCodec,
    versionedProfileWireCodec,
    type EffectDispatch,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema,
    voidProfileWireCodec
} from "../profile-runtime";

export type LiveDeviceOperation = "camera" | "location" | "sms" | "screen" | "system.run";

export const LIVE_DEVICE_OPERATIONS: readonly LiveDeviceOperation[] = Object.freeze([
    "camera",
    "location",
    "sms",
    "screen",
    "system.run"
]);

interface DeviceOperationInput<Arguments extends FacetDataMap> extends PublicProfileInput {
    readonly deviceId: DeviceId;
    readonly arguments: Arguments;
}

export type DeviceCameraInput = DeviceOperationInput<{ readonly facing: "front" | "rear" }>;
export type DeviceLocationInput = DeviceOperationInput<{ readonly accuracyMeters?: number }>;
export type DeviceSmsInput = DeviceOperationInput<{
    readonly to: string;
    readonly message: string;
}>;
export type DeviceScreenInput = DeviceOperationInput<{ readonly mode: "capture" | "stream" }>;
export type DeviceSystemRunInput = DeviceOperationInput<{
    readonly command: string;
    readonly arguments?: readonly string[];
}>;
export type DeviceLiveInput =
    | DeviceCameraInput
    | DeviceLocationInput
    | DeviceSmsInput
    | DeviceScreenInput
    | DeviceSystemRunInput;

export interface DeviceCachedInput extends PublicProfileInput {
    readonly deviceId: DeviceId;
    readonly key: string;
}

export interface DevicePairInput extends PublicProfileInput {
    readonly deviceId: DeviceId;
    readonly publicKey: string;
    readonly operatorApproval: string;
}

export interface DeviceCommandInput extends PublicProfileInput {
    readonly commandId: DeviceCommandId;
    readonly deviceId: DeviceId;
    readonly operation: LiveDeviceOperation;
    readonly arguments: JsonValue;
}

export interface DeviceCommandInvoked extends PublicProfileInput {
    readonly kind: "command.invoked";
    readonly commandId: DeviceCommandId;
    readonly operation: LiveDeviceOperation;
    readonly deviceId: DeviceId;
    readonly arguments: JsonValue;
}

export interface DeviceCommandCompleted extends PublicProfileInput {
    readonly kind: "command.completed";
    readonly commandId: DeviceCommandId;
    readonly succeeded: boolean;
    readonly result?: JsonValue;
}

export interface DeviceTransportRequest {
    readonly deviceId: DeviceId;
    readonly agentId: PrincipalRef;
    readonly operation: LiveDeviceOperation;
    readonly arguments: JsonValue;
}

export interface DeviceAdmission {
    readonly deviceId: DeviceId;
    readonly agentId: PrincipalRef;
    readonly admittedAt: number;
    readonly sequence: number;
}

export abstract class DeviceAgentBinding {
    public abstract agent(): PrincipalRef;
}

export abstract class DeviceEnvironmentSessionDependency {
    public abstract assertUsable(deviceId: DeviceId): void | Promise<void>;
}

const trustedAdmissions = new WeakSet<object>();

export abstract class DeviceConsentBackend<Transaction = unknown> {
    #sequence = 0;

    public admit(
        transaction: Transaction,
        deviceId: DeviceId,
        agentId: PrincipalRef
    ): DeviceAdmission {
        const admittedAt = this.assertLive(transaction, deviceId, agentId);
        if (!Number.isSafeInteger(admittedAt) || admittedAt < 0) {
            throw new DeviceError("consent.invalid", "Device consent admission time is invalid");
        }
        if (this.#sequence === Number.MAX_SAFE_INTEGER) {
            throw new DeviceError(
                "consent.exhausted",
                "Device consent admission sequence is exhausted"
            );
        }
        this.#sequence += 1;
        const admission = Object.freeze({
            deviceId,
            agentId,
            admittedAt,
            sequence: this.#sequence
        });
        trustedAdmissions.add(admission);
        return admission;
    }

    protected abstract assertLive(
        transaction: Transaction,
        deviceId: DeviceId,
        agentId: PrincipalRef
    ): number;
}

export interface ReverseDeviceTransportBackend {
    /**
     * Delivers an admitted command to the paired device carrying its canonical effect
     * identity. The provider MUST treat `dispatch.idempotencyKey` as the dedup key for
     * the command and MUST be able to answer a reconciliation query addressed by
     * `dispatch.attempt` identity, so a crash-after-send retry neither delivers twice
     * nor stays indeterminate (SPEC §7.4).
     */
    send(
        request: DeviceTransportRequest,
        admission: DeviceAdmission,
        dispatch: EffectDispatch
    ): Promise<JsonValue>;
    pair(deviceId: DeviceId, publicKey: string, operatorApproval: string): Promise<void>;
}

export interface DeviceResultCacheBackend {
    read(deviceId: DeviceId, key: string): JsonValue | undefined;
}

export class DeviceBackend {
    public constructor(
        private readonly environment: DeviceEnvironmentSessionDependency,
        private readonly transport: ReverseDeviceTransportBackend,
        private readonly cache: DeviceResultCacheBackend
    ) {}

    public pair(input: DevicePairInput): Promise<void> {
        requireNonblank(input.publicKey, "Device public key");
        requireNonblank(input.operatorApproval, "Operator approval");
        return this.transport.pair(input.deviceId, input.publicKey, input.operatorApproval);
    }

    public async execute(
        operation: LiveDeviceOperation,
        input: DeviceLiveInput,
        context: ProfileEffectContext
    ): Promise<JsonValue> {
        if (!LIVE_DEVICE_OPERATIONS.includes(operation)) {
            throw new DeviceError(
                "command.invalid",
                "Device operation is outside the typed command surface"
            );
        }
        await this.environment.assertUsable(input.deviceId);
        const admission = context.targetAdmission;
        if (
            !isDeviceAdmission(admission) ||
            !trustedAdmissions.has(admission) ||
            !admission.deviceId.equals(input.deviceId)
        ) {
            throw new DeviceError(
                "consent.invalid",
                "Device consent admission does not match the exact request pair"
            );
        }
        const agentId = admission.agentId;
        const command = Object.freeze({
            deviceId: input.deviceId,
            agentId,
            operation,
            arguments: canonicalFacetData(input.arguments)
        });
        return this.transport.send(command, admission, context.dispatch());
    }

    public readCached(input: DeviceCachedInput): JsonValue | undefined {
        const value = this.cache.read(input.deviceId, input.key);
        return value === undefined ? undefined : canonicalFacetData(value);
    }
}

const idProperty = { type: "string", minLength: 1 } as const;
const jsonOutput = schema({});

function liveOperation<Name extends LiveDeviceOperation, Input extends DeviceLiveInput>(
    name: Name,
    argumentsSchema: FacetDataMap
): ProfileOperationContract<Name, Input, JsonValue> {
    const inputSchema = strictObjectSchema({ deviceId: idProperty, arguments: argumentsSchema }, [
        "deviceId",
        "arguments"
    ]);
    return new ProfileOperationContract(
        name,
        new OperationDescriptor(new OperationName(name), "externalSend", inputSchema, jsonOutput),
        versionedProfileWireCodec(
            (input) => ({ deviceId: input.deviceId.value, arguments: input.arguments }),
            (data) => {
                const object = requireDataObject(data, `Device ${name} input`);
                return {
                    deviceId: new DeviceId(requireString(object["deviceId"], "Device ID")),
                    arguments: requireDataObject(object["arguments"]!, `Device ${name} arguments`)
                } as Input;
            }
        ),
        facetDataWireCodec<JsonValue>(),
        "output"
    );
}

export const DEVICE_OPERATION_CONTRACTS = Object.freeze({
    camera: liveOperation<"camera", DeviceCameraInput>("camera", {
        type: "object",
        properties: { facing: { enum: ["front", "rear"] } },
        required: ["facing"],
        additionalProperties: false
    }),
    location: liveOperation<"location", DeviceLocationInput>("location", {
        type: "object",
        properties: { accuracyMeters: { type: "number", minimum: 0 } },
        additionalProperties: false
    }),
    sms: liveOperation<"sms", DeviceSmsInput>("sms", {
        type: "object",
        properties: { to: idProperty, message: { type: "string", minLength: 1 } },
        required: ["to", "message"],
        additionalProperties: false
    }),
    screen: liveOperation<"screen", DeviceScreenInput>("screen", {
        type: "object",
        properties: { mode: { enum: ["capture", "stream"] } },
        required: ["mode"],
        additionalProperties: false
    }),
    systemRun: liveOperation<"system.run", DeviceSystemRunInput>("system.run", {
        type: "object",
        properties: {
            command: { type: "string", minLength: 1 },
            arguments: { type: "array", items: { type: "string" } }
        },
        required: ["command"],
        additionalProperties: false
    }),
    readCached: new ProfileOperationContract<
        "readCached",
        DeviceCachedInput,
        JsonValue | undefined
    >(
        "readCached",
        new OperationDescriptor(
            new OperationName("readCached"),
            "observe",
            strictObjectSchema({ deviceId: idProperty, key: idProperty }, ["deviceId", "key"]),
            schema({ anyOf: [{}, { type: "null" }] })
        ),
        versionedProfileWireCodec(
            (input) => ({ deviceId: input.deviceId.value, key: input.key }),
            (data) => {
                const object = requireDataObject(data, "Device cache input");
                return {
                    deviceId: new DeviceId(requireString(object["deviceId"], "Device ID")),
                    key: requireString(object["key"], "Device cache key")
                };
            }
        ),
        profileWireCodec(
            (value) => value ?? null,
            (data) => (data === null ? undefined : data)
        ),
        "output"
    )
});

export const DEVICE_OPERATIONS: readonly OperationDescriptor[] = Object.freeze(
    Object.values(DEVICE_OPERATION_CONTRACTS).map((contract) => contract.descriptor)
);

export const DEVICE_PAIR_CONTROL = new ProfileControlContract<"device.pair", DevicePairInput, void>(
    "device.pair",
    strictObjectSchema(
        {
            deviceId: idProperty,
            publicKey: idProperty,
            operatorApproval: idProperty
        },
        ["deviceId", "publicKey", "operatorApproval"]
    ),
    schema({ type: "null" }),
    profileWireCodec(
        (input) => ({ ...input, deviceId: input.deviceId.value }),
        (data) => {
            const object = requireDataObject(data, "Device pair input");
            return {
                deviceId: new DeviceId(requireString(object["deviceId"], "Device ID")),
                publicKey: requireString(object["publicKey"], "Device public key"),
                operatorApproval: requireString(object["operatorApproval"], "Operator approval")
            };
        }
    ),
    voidProfileWireCodec
);

export const DEVICE_COMMAND_SURFACE = new SurfaceDescriptor(
    new SurfaceId("device.commands"),
    "Device commands",
    "Invokes typed commands on a paired device."
);
export const DEVICE_COMMAND_SLOT = new SlotDeclaration(
    new SlotName("device.commands"),
    schema({ type: "object" }),
    new SlotAuthorityPolicy(["installed"], ["scope.read"])
);

export const DEVICE_COMMANDS: readonly Command[] = Object.freeze(
    LIVE_DEVICE_OPERATIONS.map(
        (operation) =>
            new Command({
                name: operation,
                title: operation,
                arguments: DEVICE_OPERATIONS.find(
                    (descriptor) => descriptor.name.value === operation
                )!.input,
                operation: new OperationRef(`profile.device:${operation}`),
                binding: new BindingName("device"),
                surfaces: [new SlotName("device.commands")]
            })
    )
);

export const DEVICE_COMMAND_EVENTS = Object.freeze({
    invoked: new EventDeclaration(
        new EventKind("command.invoked"),
        "A typed device command was invoked.",
        strictObjectSchema(
            {
                commandId: idProperty,
                operation: { enum: LIVE_DEVICE_OPERATIONS },
                deviceId: idProperty,
                arguments: {}
            },
            ["commandId", "operation", "deviceId", "arguments"]
        ),
        "workspace"
    ),
    completed: new EventDeclaration(
        new EventKind("command.completed"),
        "A typed device command completed.",
        strictObjectSchema(
            {
                commandId: idProperty,
                succeeded: { type: "boolean" },
                result: {}
            },
            ["commandId", "succeeded"]
        ),
        "workspace"
    )
});

export const DEVICE_COMMAND_EVENT_CONTRACTS = Object.freeze({
    invoked: new ProfileEventContract<"command.invoked", DeviceCommandInvoked>(
        "command.invoked",
        DEVICE_COMMAND_EVENTS.invoked,
        profileWireCodec(
            (event) => ({
                commandId: event.commandId.value,
                operation: event.operation,
                deviceId: event.deviceId.value,
                arguments: event.arguments
            }),
            (data) => {
                const event = requireDataObject(data, "Device command invoked Event");
                return {
                    kind: "command.invoked",
                    commandId: new DeviceCommandId(
                        requireString(event["commandId"], "Device command ID")
                    ),
                    operation: requireLiveOperation(event["operation"]),
                    deviceId: new DeviceId(requireString(event["deviceId"], "Device ID")),
                    arguments: event["arguments"]!
                };
            }
        )
    ),
    completed: new ProfileEventContract<"command.completed", DeviceCommandCompleted>(
        "command.completed",
        DEVICE_COMMAND_EVENTS.completed,
        profileWireCodec(
            (event) => ({
                commandId: event.commandId.value,
                succeeded: event.succeeded,
                ...(event.result === undefined ? {} : { result: event.result })
            }),
            (data) => {
                const event = requireDataObject(data, "Device command completed Event");
                const succeeded = requireBoolean(
                    event["succeeded"],
                    "Device command completion state"
                );
                return {
                    kind: "command.completed",
                    commandId: new DeviceCommandId(
                        requireString(event["commandId"], "Device command ID")
                    ),
                    succeeded,
                    ...(event["result"] === undefined ? {} : { result: event["result"] })
                };
            }
        )
    )
});

export const DEVICE_CONTRIBUTIONS = new Contributions([
    new Contribution(
        new SlotName("operations"),
        DEVICE_OPERATIONS.map((operation) => operation.toData())
    ),
    new Contribution(
        new SlotName("commands"),
        DEVICE_COMMANDS.map((command) => command.toData())
    ),
    new Contribution(
        new SlotName("events"),
        Object.values(DEVICE_COMMAND_EVENTS).map((event) => event.toData())
    ),
    new Contribution(new SlotName("slots"), [DEVICE_COMMAND_SLOT.toData()]),
    new Contribution(new SlotName("surfaces"), [DEVICE_COMMAND_SURFACE.toData()])
]);

export class DeviceFacet<Receipt> {
    public static readonly operations = DEVICE_OPERATIONS;
    public static readonly commands = DEVICE_COMMANDS;
    public static readonly events = Object.freeze(Object.values(DEVICE_COMMAND_EVENTS));

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly backend: DeviceBackend
    ) {}

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({
            manifest,
            runtime: this.runtime,
            operations: [
                this.runtime.operation(DEVICE_OPERATION_CONTRACTS.camera, (input, context) =>
                    this.backend.execute("camera", input, context)
                ),
                this.runtime.operation(DEVICE_OPERATION_CONTRACTS.location, (input, context) =>
                    this.backend.execute("location", input, context)
                ),
                this.runtime.operation(DEVICE_OPERATION_CONTRACTS.sms, (input, context) =>
                    this.backend.execute("sms", input, context)
                ),
                this.runtime.operation(DEVICE_OPERATION_CONTRACTS.screen, (input, context) =>
                    this.backend.execute("screen", input, context)
                ),
                this.runtime.operation(DEVICE_OPERATION_CONTRACTS.systemRun, (input, context) =>
                    this.backend.execute("system.run", input, context)
                ),
                this.runtime.operation(DEVICE_OPERATION_CONTRACTS.readCached, (input) =>
                    this.backend.readCached(input)
                )
            ],
            surfaces: [this.runtime.surface(DEVICE_COMMAND_SURFACE)]
        });
    }

    public pair(input: DevicePairInput): Promise<void> {
        return this.runtime.control(DEVICE_PAIR_CONTROL, input, (admitted) =>
            this.backend.pair(admitted)
        );
    }

    public camera(input: DeviceCameraInput): Promise<JsonValue> {
        return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.camera, input, (admitted, context) =>
            this.backend.execute("camera", admitted, context)
        );
    }

    public location(input: DeviceLocationInput): Promise<JsonValue> {
        return this.runtime.invoke(
            DEVICE_OPERATION_CONTRACTS.location,
            input,
            (admitted, context) => this.backend.execute("location", admitted, context)
        );
    }

    public sms(input: DeviceSmsInput): Promise<JsonValue> {
        return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.sms, input, (admitted, context) =>
            this.backend.execute("sms", admitted, context)
        );
    }

    public screen(input: DeviceScreenInput): Promise<JsonValue> {
        return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.screen, input, (admitted, context) =>
            this.backend.execute("screen", admitted, context)
        );
    }

    public systemRun(input: DeviceSystemRunInput): Promise<JsonValue> {
        return this.runtime.invoke(
            DEVICE_OPERATION_CONTRACTS.systemRun,
            input,
            (admitted, context) => this.backend.execute("system.run", admitted, context)
        );
    }

    public readCached(input: DeviceCachedInput): Promise<JsonValue | undefined> {
        return this.runtime.invoke(DEVICE_OPERATION_CONTRACTS.readCached, input, (admitted) =>
            this.backend.readCached(admitted)
        );
    }

    public async command(input: DeviceCommandInput): Promise<JsonValue> {
        const source = await this.invokeCommand(input);
        await this.runtime.emit<"command.invoked", DeviceCommandInvoked>(
            DEVICE_COMMAND_EVENT_CONTRACTS.invoked,
            Object.freeze({
                kind: "command.invoked",
                commandId: input.commandId,
                operation: input.operation,
                deviceId: input.deviceId,
                arguments: canonicalFacetData(input.arguments)
            }),
            source.receipt
        );
        await this.runtime.emit<"command.completed", DeviceCommandCompleted>(
            DEVICE_COMMAND_EVENT_CONTRACTS.completed,
            Object.freeze({
                kind: "command.completed",
                commandId: input.commandId,
                succeeded: true,
                result: source.output
            }),
            source.receipt
        );
        return source.output;
    }

    private invokeCommand(input: DeviceCommandInput) {
        const encoded = { deviceId: input.deviceId.value, arguments: input.arguments };
        switch (input.operation) {
            case "camera":
                return this.invokeLiveCommand(
                    DEVICE_OPERATION_CONTRACTS.camera,
                    DEVICE_OPERATION_CONTRACTS.camera.decodeInput(encoded),
                    "camera"
                );
            case "location":
                return this.invokeLiveCommand(
                    DEVICE_OPERATION_CONTRACTS.location,
                    DEVICE_OPERATION_CONTRACTS.location.decodeInput(encoded),
                    "location"
                );
            case "sms":
                return this.invokeLiveCommand(
                    DEVICE_OPERATION_CONTRACTS.sms,
                    DEVICE_OPERATION_CONTRACTS.sms.decodeInput(encoded),
                    "sms"
                );
            case "screen":
                return this.invokeLiveCommand(
                    DEVICE_OPERATION_CONTRACTS.screen,
                    DEVICE_OPERATION_CONTRACTS.screen.decodeInput(encoded),
                    "screen"
                );
            case "system.run":
                return this.invokeLiveCommand(
                    DEVICE_OPERATION_CONTRACTS.systemRun,
                    DEVICE_OPERATION_CONTRACTS.systemRun.decodeInput(encoded),
                    "system.run"
                );
        }
    }

    private invokeLiveCommand<Name extends LiveDeviceOperation, Input extends DeviceLiveInput>(
        contract: ProfileOperationContract<Name, Input, JsonValue, "output">,
        input: Input,
        operation: Name
    ) {
        return this.runtime.invokeWithReceipt(contract, input, (admitted, context) =>
            this.backend.execute(operation, admitted, context)
        );
    }
}

export class MemoryDeviceConsentBackend extends DeviceConsentBackend {
    readonly #consents = new Map<string, number>();

    public constructor(private readonly now: () => number = Date.now) {
        super();
    }

    public grant(deviceId: DeviceId, agentId: PrincipalRef, expiresAt: number): void {
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
            throw new DeviceError(
                "consent.invalid",
                "Device consent expiration must be in the future"
            );
        }
        this.#consents.set(pairKey(deviceId, agentId), expiresAt);
    }

    public revoke(deviceId: DeviceId, agentId: PrincipalRef): void {
        this.#consents.delete(pairKey(deviceId, agentId));
    }

    protected assertLive(_transaction: unknown, deviceId: DeviceId, agentId: PrincipalRef): number {
        const now = this.now();
        const expiration = this.#consents.get(pairKey(deviceId, agentId));
        if (expiration === undefined || expiration <= now) {
            throw new DeviceError(
                "consent.denied",
                `Live consent is absent for device ${deviceId}`
            );
        }
        return now;
    }
}

function isDeviceAdmission(value: unknown): value is DeviceAdmission {
    return (
        typeof value === "object" &&
        value !== null &&
        "deviceId" in value &&
        value.deviceId instanceof DeviceId &&
        "agentId" in value &&
        typeof value.agentId === "object" &&
        value.agentId !== null
    );
}

export type DeviceErrorCode =
    "consent.denied" | "consent.invalid" | "consent.exhausted" | "command.invalid";

export class DeviceError extends DetailedProfileError<DeviceErrorCode> {
    public constructor(detailCode: DeviceErrorCode, message: string) {
        super(
            detailCode === "consent.denied" ? "authority.denied" : "operation.invalid-input",
            detailCode,
            message
        );
        this.name = "DeviceError";
    }
}

function pairKey(deviceId: DeviceId, agentId: PrincipalRef): string {
    return JSON.stringify([deviceId.value, agentId.tenantId.value, agentId.principalId.value]);
}

function requireNonblank(value: string, subject: string): void {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new DeviceError("command.invalid", `${subject} must be canonical`);
    }
}

function requireBoolean(value: JsonValue | undefined, subject: string): boolean {
    if (typeof value !== "boolean") throw new TypeError(`${subject} is invalid`);
    return value;
}

function requireLiveOperation(value: JsonValue | undefined): LiveDeviceOperation {
    if (
        typeof value === "string" &&
        LIVE_DEVICE_OPERATIONS.includes(value as LiveDeviceOperation)
    ) {
        return value as LiveDeviceOperation;
    }
    throw new TypeError("Device command operation is invalid");
}
