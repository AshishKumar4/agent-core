import { CompatRange, Digest, SemVer, type JsonValue } from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import { PrincipalId, PrincipalRef, TenantId } from "../../../src/identity";
import {
    BindingName,
    BindingRequirement,
    DEVICE_COMMANDS,
    DEVICE_COMMAND_EVENTS,
    DEVICE_COMMAND_EVENT_CONTRACTS,
    DEVICE_COMMAND_SURFACE,
    DEVICE_CONTRIBUTIONS,
    DEVICE_ENVIRONMENT_BINDING,
    DEVICE_OPERATIONS,
    DEVICE_OPERATION_CONTRACTS,
    DEVICE_PAIR_CONTROL,
    DeviceBackend,
    DeviceCommandId,
    DeviceConsentBackend,
    DeviceEnvironmentSessionDependency,
    DeviceError,
    DeviceFacet,
    DeviceId,
    FacetPackageId,
    MemoryDeviceConsentBackend,
    OperationName,
    ProfileEffectContext,
    VersionedProfileWireCodec,
    createDeviceManifest,
    type DeviceAdmission,
    type DeviceTransportRequest,
    type EffectDispatch,
    type FacetManifest,
    type InternalProfileFacetRuntime,
    type Operation,
    type OperationContext,
    type ReverseDeviceTransportBackend
} from "../../../src/facets";
import { EffectAttemptId, InvocationId } from "../../../src/invocations";
import { describe, expect, test } from "vitest";
import { denyingRuntime, operationDeclarationEvidence, recordingRuntime } from "./harness";

operationDeclarationEvidence("Device", DEVICE_OPERATIONS, {
    camera: "externalSend",
    location: "externalSend",
    sms: "externalSend",
    screen: "externalSend",
    "system.run": "externalSend",
    readCached: "observe"
});

describe("Device protected Environment profile", () => {
    test("[P11-DEVICE-LIVE-IMPACT] routes live and cached Operations through mediation", async () => {
        const agent = principal("agent");
        const consent = new MemoryDeviceConsentBackend(() => 10);
        consent.grant(deviceId("phone"), agent, 20);
        const transport = new TestDeviceTransport();
        const { runtime, admission } = recordingRuntime("device", undefined, (_request, input) =>
            consent.admit(undefined, inputDevice(input), agent)
        );
        const device = new DeviceFacet(
            runtime,
            new DeviceBackend(new LiveSession(), transport, { read: () => ({ cached: true }) })
        );

        await device.pair({
            deviceId: deviceId("phone"),
            publicKey: "key",
            operatorApproval: "approved"
        });
        await device.camera(cameraInput());
        await device.location({ deviceId: deviceId("phone"), arguments: { accuracyMeters: 5 } });
        await device.sms({
            deviceId: deviceId("phone"),
            arguments: { to: "+15550000", message: "hello" }
        });
        await device.screen({ deviceId: deviceId("phone"), arguments: { mode: "capture" } });
        await device.systemRun({
            deviceId: deviceId("phone"),
            arguments: { command: "status", arguments: ["--json"] }
        });
        await device.readCached({ deviceId: deviceId("phone"), key: "last" });

        expect(admission.calls.map((call) => [call.kind, call.name])).toEqual([
            ["control", "device.pair"],
            ["invoke", "camera"],
            ["invoke", "location"],
            ["invoke", "sms"],
            ["invoke", "screen"],
            ["invoke", "system.run"],
            ["invoke", "readCached"]
        ]);
        expect(transport.sent.every((request) => request.agentId.equals(agent))).toBe(true);
    });

    test("denial prevents pairing and reverse transport", async () => {
        const transport = new TestDeviceTransport();
        const device = new DeviceFacet(
            denyingRuntime("device").runtime,
            new DeviceBackend(new LiveSession(), transport, { read: () => undefined })
        );
        await expect(device.camera(cameraInput())).rejects.toMatchObject({
            code: "authority.denied"
        });
        expect(transport.sent).toEqual([]);
    });

    test("[P11-DEVICE-PAIRING] passes the admitted device key and operator approval to reverse transport", async () => {
        const agent = principal("rewrite-agent");
        const consent = new MemoryDeviceConsentBackend(() => 1);
        consent.grant(deviceId("rewritten-phone"), agent, 2);
        const transport = new TestDeviceTransport();
        const cacheReads: Array<readonly string[]> = [];
        const rewrite = (kind: "invoke" | "emit" | "control", name: string, input: JsonValue) => {
            if (kind === "control" && name === "device.pair") {
                return {
                    deviceId: "rewritten-phone",
                    publicKey: "rewritten-key",
                    operatorApproval: "rewritten-approval"
                };
            }
            if (kind === "invoke" && name === "camera") {
                return { deviceId: "rewritten-phone", arguments: { facing: "rear" } };
            }
            if (kind === "invoke" && name === "readCached") {
                return { deviceId: "rewritten-phone", key: "rewritten-cache" };
            }
            return input;
        };
        const { runtime } = recordingRuntime("device-rewrite", rewrite, (_request, input) =>
            consent.admit(undefined, inputDevice(input), agent)
        );
        const facet = new DeviceFacet(
            runtime,
            new DeviceBackend(new LiveSession(), transport, {
                read(device, key) {
                    cacheReads.push([device.value, key]);
                    return { rewritten: true };
                }
            })
        );

        await facet.pair({
            deviceId: deviceId("caller-phone"),
            publicKey: "caller-key",
            operatorApproval: "caller-approval"
        });
        await facet.camera({
            deviceId: deviceId("caller-phone"),
            arguments: { facing: "front" }
        });
        await expect(
            facet.readCached({ deviceId: deviceId("caller-phone"), key: "caller-cache" })
        ).resolves.toEqual({ rewritten: true });

        expect(transport.paired).toEqual([
            ["rewritten-phone", "rewritten-key", "rewritten-approval"]
        ]);
        expect(transport.sent[0]).toMatchObject({
            deviceId: deviceId("rewritten-phone"),
            operation: "camera",
            arguments: { facing: "rear" }
        });
        expect(cacheReads).toEqual([["rewritten-phone", "rewritten-cache"]]);
    });
});

describe("Device transport admission and declarations", () => {
    test("[P11-DEVICE-ENVIRONMENT] checks the exact Environment before transport", async () => {
        const agent = principal("environment-agent");
        const phone = deviceId("environment-phone");
        const checked: DeviceId[] = [];
        const consent = new MemoryDeviceConsentBackend(() => 1);
        const admission = grantAndAdmit(consent, phone, agent, 2);
        const transport = new TestDeviceTransport();
        const backend = new DeviceBackend(
            new RecordingSession((device) => checked.push(device)),
            transport,
            { read: () => undefined }
        );

        await backend.execute(
            "camera",
            { deviceId: phone, arguments: { facing: "front" } },
            effectContext(admission)
        );

        expect(checked).toEqual([phone]);
        expect(transport.sent.map((request) => request.deviceId)).toEqual([phone]);
    });

    test("[P11-DEVICE-CONSENT-ABSENT] rejects absent, forged, and wrong-device admission evidence", async () => {
        const agent = principal("bound-agent");
        const consent = new MemoryDeviceConsentBackend(() => 1);
        const admission = grantAndAdmit(consent, deviceId("bound-phone"), agent, 2);
        const transport = new TestDeviceTransport();
        const backend = new DeviceBackend(new LiveSession(), transport, { read: () => undefined });

        for (const context of [
            effectContext(undefined),
            effectContext({ ...admission }),
            effectContext(admission)
        ]) {
            await expect(backend.execute("camera", cameraInput(), context)).rejects.toMatchObject({
                detailCode: "consent.invalid"
            });
        }
        expect(transport.sent).toEqual([]);
    });

    test("[P11-DEVICE-CONSENT-PAIR] admits only the exact Device and Agent pair", () => {
        const now = 10;
        const agent = principal("live-agent", "tenant-a");
        const other = principal("live-agent", "tenant-b");
        const phone = deviceId("live-phone");
        const consent = new MemoryDeviceConsentBackend(() => now);
        consent.grant(phone, agent, 12);

        expect(consent.admit(undefined, phone, agent).agentId.equals(agent)).toBe(true);
        expect(() => consent.admit(undefined, phone, other)).toThrow(
            expect.objectContaining({ detailCode: "consent.denied" })
        );
    });

    test("[P11-DEVICE-CONSENT-LIVE] rejects expired consent", () => {
        let now = 10;
        const agent = principal("expiring-agent");
        const phone = deviceId("expiring-phone");
        const consent = new MemoryDeviceConsentBackend(() => now);
        consent.grant(phone, agent, 12);
        now = 12;
        expect(() => consent.admit(undefined, phone, agent)).toThrow(
            expect.objectContaining({ detailCode: "consent.denied" })
        );
    });

    test("[P11-DEVICE-CONSENT-ISOLATION] rejects another Device under the same Agent", () => {
        const agent = principal("isolated-agent");
        const consent = new MemoryDeviceConsentBackend(() => 1);
        consent.grant(deviceId("authorized-phone"), agent, 2);
        expect(() => consent.admit(undefined, deviceId("other-phone"), agent)).toThrow(
            expect.objectContaining({ detailCode: "consent.denied" })
        );
    });

    test("[P11-DEVICE-CONSENT-FINAL-CHECK] returns exact immutable target admission evidence", () => {
        const consent = new MemoryDeviceConsentBackend(() => 1);
        const device = deviceId("final-phone");
        const boundAgent = principal("final-agent");
        const admission = grantAndAdmit(consent, device, boundAgent, 2);

        expect(admission.deviceId).toBe(device);
        expect(admission.agentId).toBe(boundAgent);
        expect(Object.isFrozen(admission)).toBe(true);
    });

    test("[P11-DEVICE-CONSENT-REVOCATION] rejects consent revoked before target admission", () => {
        const consent = new MemoryDeviceConsentBackend(() => 1);
        const device = deviceId("revoked-phone");
        const boundAgent = principal("revoked-agent");
        consent.grant(device, boundAgent, 2);
        consent.revoke(device, boundAgent);

        expect(() => consent.admit(undefined, device, boundAgent)).toThrow(
            expect.objectContaining({ detailCode: "consent.denied" })
        );
    });

    test("[P11-DEVICE-CONSENT-ADMITTED] preserves a target admission across later revocation", async () => {
        const consent = new MemoryDeviceConsentBackend(() => 1);
        const device = deviceId("admitted-phone");
        const boundAgent = principal("admitted-agent");
        const admission = grantAndAdmit(consent, device, boundAgent, 2);
        consent.revoke(device, boundAgent);
        const transport = new TestDeviceTransport();
        const backend = new DeviceBackend(new LiveSession(), transport, { read: () => undefined });

        await backend.execute(
            "camera",
            { deviceId: device, arguments: { facing: "front" } },
            effectContext(admission)
        );

        expect(transport.admissions).toEqual([admission]);
    });

    test("[P11-DEVICE-CACHED-READ] remains observe and requires no live admission", () => {
        const backend = new DeviceBackend(new LiveSession(), new TestDeviceTransport(), {
            read: (_device, key) => (key === "present" ? { nested: true } : undefined)
        });
        expect(DEVICE_OPERATION_CONTRACTS.readCached.descriptor.impact).toBe("observe");
        expect(backend.readCached({ deviceId: deviceId("phone"), key: "missing" })).toBeUndefined();
        expect(backend.readCached({ deviceId: deviceId("phone"), key: "present" })).toEqual({
            nested: true
        });
    });

    test("declares typed commands and standard Events", () => {
        expect(DEVICE_COMMANDS.map((command) => command.name)).toEqual([
            "camera",
            "location",
            "sms",
            "screen",
            "system.run"
        ]);
        expect(Object.values(DEVICE_COMMAND_EVENTS).map((event) => event.kind.value)).toEqual([
            "command.invoked",
            "command.completed"
        ]);
        expect(DEVICE_CONTRIBUTIONS.entries.map((entry) => entry.slot.value)).toEqual([
            "commands",
            "events",
            "operations",
            "slots",
            "surfaces"
        ]);
    });

    test("[P11-DEVICE-SCHEMA-VERSION] all six input codecs reject unknown major versions", () => {
        for (const contract of Object.values(DEVICE_OPERATION_CONTRACTS)) {
            expect(contract.inputCodec).toBeInstanceOf(VersionedProfileWireCodec);
            const codec = contract.inputCodec as VersionedProfileWireCodec<unknown>;
            expect(() => codec.decodeVersion({ major: 2, minor: 0 }, {})).toThrow(
                expect.objectContaining({ code: "codec.unknown-major", detailCode: "wire.input" })
            );
        }
    });

    test("validates command identities, pairing, operation membership, and consent clocks", async () => {
        const transport = new TestDeviceTransport();
        const backend = new DeviceBackend(new LiveSession(), transport, { read: () => undefined });
        expect(new DeviceCommandId("camera-request").value).toBe("camera-request");
        expect(() => new DeviceCommandId(" camera-request")).toThrow(TypeError);
        expect(() => new DeviceId(" ")).toThrow(TypeError);
        expect(() =>
            backend.pair({ deviceId: deviceId("phone"), publicKey: " ", operatorApproval: "ok" })
        ).toThrow(expect.objectContaining({ detailCode: "command.invalid" }));
        await expect(
            backend.execute("outside" as never, cameraInput(), effectContext(undefined))
        ).rejects.toMatchObject({ detailCode: "command.invalid" });

        const invalidClock = new (class extends DeviceConsentBackend {
            protected assertLive(): number {
                return -1;
            }
        })();
        expect(() => invalidClock.admit(undefined, deviceId("phone"), principal("agent"))).toThrow(
            expect.objectContaining({ detailCode: "consent.invalid" })
        );
    });
});

describe("Device effect identity to reverse transport", () => {
    test("[P11-DEVICE-DISPATCH] delivers the canonical effect identity derived from the context", async () => {
        const agent = principal("dispatch-agent");
        const phone = deviceId("dispatch-phone");
        const consent = new MemoryDeviceConsentBackend(() => 1);
        const admission = grantAndAdmit(consent, phone, agent, 2);
        const transport = new TestDeviceTransport();
        const backend = new DeviceBackend(new LiveSession(), transport, { read: () => undefined });
        const context = effectContext(admission);

        await backend.execute(
            "camera",
            { deviceId: phone, arguments: { facing: "front" } },
            context
        );

        const delivered = transport.dispatched[0]!;
        const expected = context.dispatch();
        expect(Object.isFrozen(delivered)).toBe(true);
        expect(delivered.idempotencyKey).toBe(expected.idempotencyKey);
        expect(delivered.attempt?.id.equals(expected.attempt!.id)).toBe(true);
        expect(delivered.attempt?.ordinal).toBe(expected.attempt!.ordinal);
        expect(delivered.attempt?.intentDigest.equals(expected.attempt!.intentDigest)).toBe(true);
    });

    test("[P11-DEVICE-CRASH-RETRY] a crash-after-send retry reuses the key so the provider dedups instead of re-delivering", async () => {
        const agent = principal("crash-agent");
        const phone = deviceId("crash-phone");
        const consent = new MemoryDeviceConsentBackend(() => 1);
        const admission = grantAndAdmit(consent, phone, agent, 2);
        const transport = new DedupDeviceTransport();
        const backend = new DeviceBackend(new LiveSession(), transport, { read: () => undefined });
        const context = effectContext(admission);
        const input = { deviceId: phone, arguments: { facing: "front" } } as const;

        await expect(backend.execute("camera", input, context)).rejects.toThrow("crash after send");
        const retry = await backend.execute("camera", input, context);

        expect(transport.attempts.map((dispatch) => dispatch.idempotencyKey)).toEqual([
            "device-test-key",
            "device-test-key"
        ]);
        expect(
            transport.attempts.every((dispatch) =>
                dispatch.attempt!.id.equals(new EffectAttemptId("device-test-attempt"))
            )
        ).toBe(true);
        expect(transport.deliveries).toBe(1);
        expect(retry).toEqual({ operation: "camera" });
    });
});

describe("Device consent boundaries and error identity", () => {
    test(
        "rejects a forged admission copy even for the exact requested Device pair",
        { tags: "p0" },
        async () => {
            const agent = principal("forged-agent");
            const phone = deviceId("forged-phone");
            const consent = new MemoryDeviceConsentBackend(() => 1);
            const admission = grantAndAdmit(consent, phone, agent, 2);
            const transport = new TestDeviceTransport();
            const backend = new DeviceBackend(new LiveSession(), transport, {
                read: () => undefined
            });

            await expect(
                backend.execute(
                    "camera",
                    { deviceId: phone, arguments: { facing: "front" } },
                    effectContext({ ...admission })
                )
            ).rejects.toMatchObject({ detailCode: "consent.invalid" });
            expect(transport.sent).toEqual([]);
        }
    );

    test("admits a consent clock at the epoch boundary and sequences admissions", {
        tags: "p1"
    }, () => {
        const epochClock = new (class extends DeviceConsentBackend {
            protected assertLive(): number {
                return 0;
            }
        })();
        const first = epochClock.admit(undefined, deviceId("epoch-phone"), principal("epoch"));
        expect(first.admittedAt).toBe(0);
        expect(first.sequence).toBe(1);
        expect(
            epochClock.admit(undefined, deviceId("epoch-phone"), principal("epoch")).sequence
        ).toBe(2);
    });

    test("rejects consent grants expiring now, in the past, or at non-integer instants", {
        tags: "p1"
    }, () => {
        const agent = principal("grant-agent");
        const phone = deviceId("grant-phone");
        const consent = new MemoryDeviceConsentBackend(() => 10);
        for (const expiresAt of [10, 9, Number.POSITIVE_INFINITY, Number.NaN]) {
            expect(() => consent.grant(phone, agent, expiresAt)).toThrow(
                expect.objectContaining({
                    detailCode: "consent.invalid",
                    message: "Device consent expiration must be in the future"
                })
            );
        }
        consent.grant(phone, agent, 11);
        expect(consent.admit(undefined, phone, agent).admittedAt).toBe(10);
    });

    test("requires canonical pairing credentials before reverse transport", {
        tags: "p1"
    }, () => {
        const backend = new DeviceBackend(new LiveSession(), new TestDeviceTransport(), {
            read: () => undefined
        });
        expect(() =>
            backend.pair({
                deviceId: deviceId("phone"),
                publicKey: "key ",
                operatorApproval: "approved"
            })
        ).toThrow(
            expect.objectContaining({
                detailCode: "command.invalid",
                message: "Device public key must be canonical"
            })
        );
        expect(() =>
            backend.pair({
                deviceId: deviceId("phone"),
                publicKey: "key",
                operatorApproval: " approved"
            })
        ).toThrow(
            expect.objectContaining({
                detailCode: "command.invalid",
                message: "Operator approval must be canonical"
            })
        );
    });

    test("maps consent denial to authority.denied and every other detail to invalid input", {
        tags: "p0"
    }, () => {
        const denied = new DeviceError("consent.denied", "denied");
        expect(denied.code).toBe("authority.denied");
        expect(denied.name).toBe("DeviceError");
        expect(denied.detail).toEqual({ code: "consent.denied" });
        for (const detailCode of [
            "consent.invalid",
            "consent.exhausted",
            "command.invalid"
        ] as const) {
            expect(new DeviceError(detailCode, "invalid").code).toBe("operation.invalid-input");
        }
        const invalidClock = new (class extends DeviceConsentBackend {
            protected assertLive(): number {
                return -1;
            }
        })();
        expect(() => invalidClock.admit(undefined, deviceId("phone"), principal("agent"))).toThrow(
            "Device consent admission time is invalid"
        );
    });

    test("names Device identifiers in canonical identity errors", { tags: "p2" }, () => {
        expect(() => new DeviceId("")).toThrow(
            "Device ID must contain between 1 and 256 characters"
        );
        expect(() => new DeviceCommandId("")).toThrow(
            "Device command ID must contain between 1 and 256 characters"
        );
    });
});

describe("Device wire codecs", () => {
    test("decodes live, cached, and pairing inputs into typed identities", { tags: "p1" }, () => {
        const camera = DEVICE_OPERATION_CONTRACTS.camera.decodeInput({
            deviceId: "phone",
            arguments: { facing: "front" }
        });
        expect(camera.deviceId.value).toBe("phone");
        expect(camera.arguments).toEqual({ facing: "front" });

        const cached = DEVICE_OPERATION_CONTRACTS.readCached.decodeInput({
            deviceId: "phone",
            key: "last"
        });
        expect(cached.deviceId.value).toBe("phone");
        expect(cached.key).toBe("last");
        expect(DEVICE_OPERATION_CONTRACTS.readCached.encodeOutput(undefined)).toBeNull();
        expect(DEVICE_OPERATION_CONTRACTS.readCached.decodeOutput(null)).toBeUndefined();
        expect(DEVICE_OPERATION_CONTRACTS.readCached.decodeOutput({ cached: true })).toEqual({
            cached: true
        });

        const pair = DEVICE_PAIR_CONTROL.decodeInput({
            deviceId: "phone",
            publicKey: "key",
            operatorApproval: "approved"
        });
        expect(pair.deviceId.value).toBe("phone");
        expect(pair.publicKey).toBe("key");
        expect(pair.operatorApproval).toBe("approved");
    });

    test("names decode subjects in wire errors", { tags: "p2" }, () => {
        expect(() => DEVICE_OPERATION_CONTRACTS.camera.decodeInput(null)).toThrow(
            "Device camera input must be an object"
        );
        expect(() =>
            DEVICE_OPERATION_CONTRACTS.readCached.decodeInput({ deviceId: 1, key: "last" })
        ).toThrow("Device ID must be a string");
        expect(() =>
            DEVICE_OPERATION_CONTRACTS.readCached.decodeInput({ deviceId: "phone", key: 1 })
        ).toThrow("Device cache key must be a string");
        expect(() =>
            DEVICE_PAIR_CONTROL.decodeInput({
                deviceId: 1,
                publicKey: "key",
                operatorApproval: "approved"
            })
        ).toThrow("Device ID must be a string");
        expect(() =>
            DEVICE_PAIR_CONTROL.decodeInput({
                deviceId: "phone",
                publicKey: 1,
                operatorApproval: "approved"
            })
        ).toThrow("Device public key must be a string");
        expect(() =>
            DEVICE_PAIR_CONTROL.decodeInput({
                deviceId: "phone",
                publicKey: "key",
                operatorApproval: 1
            })
        ).toThrow("Operator approval must be a string");
    });

    test("round-trips command Event payloads with exact kinds and optional results", {
        tags: "p1"
    }, () => {
        const invoked = DEVICE_COMMAND_EVENT_CONTRACTS.invoked;
        const encodedInvoked = invoked.encodePayload({
            kind: "command.invoked",
            commandId: new DeviceCommandId("cmd-1"),
            operation: "camera",
            deviceId: deviceId("phone"),
            arguments: { facing: "front" }
        });
        expect(encodedInvoked).toEqual({
            commandId: "cmd-1",
            operation: "camera",
            deviceId: "phone",
            arguments: { facing: "front" }
        });
        const decodedInvoked = invoked.decodePayload(encodedInvoked);
        expect(decodedInvoked.kind).toBe("command.invoked");
        expect(decodedInvoked.commandId.value).toBe("cmd-1");
        expect(decodedInvoked.operation).toBe("camera");
        expect(decodedInvoked.deviceId.value).toBe("phone");
        expect(decodedInvoked.arguments).toEqual({ facing: "front" });

        const completed = DEVICE_COMMAND_EVENT_CONTRACTS.completed;
        expect(
            completed.encodePayload({
                kind: "command.completed",
                commandId: new DeviceCommandId("cmd-1"),
                succeeded: true,
                result: { ok: true }
            })
        ).toEqual({ commandId: "cmd-1", succeeded: true, result: { ok: true } });
        expect(
            completed.encodePayload({
                kind: "command.completed",
                commandId: new DeviceCommandId("cmd-1"),
                succeeded: false
            })
        ).toEqual({ commandId: "cmd-1", succeeded: false });

        const decodedCompleted = completed.decodePayload({
            commandId: "cmd-1",
            succeeded: true,
            result: 5
        });
        expect(decodedCompleted.kind).toBe("command.completed");
        expect(decodedCompleted.commandId.value).toBe("cmd-1");
        expect(decodedCompleted.succeeded).toBe(true);
        expect(decodedCompleted.result).toBe(5);
        const withoutResult = completed.decodePayload({ commandId: "cmd-1", succeeded: true });
        expect(Object.hasOwn(withoutResult, "result")).toBe(false);
    });

    test("rejects command Event payloads outside the typed surface", { tags: "p1" }, () => {
        const invoked = DEVICE_COMMAND_EVENT_CONTRACTS.invoked;
        expect(() => invoked.decodePayload(null)).toThrow(
            "Device command invoked Event must be an object"
        );
        expect(() =>
            invoked.decodePayload({ operation: "camera", deviceId: "phone", arguments: {} })
        ).toThrow("Device command ID must be a string");
        expect(() =>
            invoked.decodePayload({
                commandId: "cmd-1",
                operation: "bogus",
                deviceId: "phone",
                arguments: {}
            })
        ).toThrow("Device command operation is invalid");
        expect(() =>
            invoked.decodePayload({
                commandId: "cmd-1",
                operation: 5,
                deviceId: "phone",
                arguments: {}
            })
        ).toThrow("Device command operation is invalid");
        expect(() =>
            invoked.decodePayload({
                commandId: "cmd-1",
                operation: "camera",
                deviceId: 1,
                arguments: {}
            })
        ).toThrow("Device ID must be a string");

        const completed = DEVICE_COMMAND_EVENT_CONTRACTS.completed;
        expect(() => completed.decodePayload(null)).toThrow(
            "Device command completed Event must be an object"
        );
        expect(() => completed.decodePayload({ succeeded: true })).toThrow(
            "Device command ID must be a string"
        );
        expect(() => completed.decodePayload({ commandId: "cmd-1", succeeded: "yes" })).toThrow(
            "Device command completion state is invalid"
        );
    });
});

describe("Device internal runtime and typed command flow", () => {
    test("asInternalRuntime registers the six declared operations and command surface", {
        tags: "p1"
    }, async () => {
        const agent = principal("internal-agent");
        const phone = deviceId("internal-phone");
        const consent = new MemoryDeviceConsentBackend(() => 1);
        const admitted = grantAndAdmit(consent, phone, agent, 2);
        const transport = new TestDeviceTransport();
        const facet = new DeviceFacet(
            recordingRuntime("device").runtime,
            new DeviceBackend(new LiveSession(), transport, {
                read: (_device, key) => (key === "present" ? { cached: true } : undefined)
            })
        );

        const internal = facet.asInternalRuntime(deviceManifest());

        expect(internal.surface(DEVICE_COMMAND_SURFACE.id)?.descriptor).toBe(
            DEVICE_COMMAND_SURFACE
        );
        const invocations = [
            ["camera", { facing: "front" }],
            ["location", { accuracyMeters: 5 }],
            ["sms", { to: "+15550000", message: "hello" }],
            ["screen", { mode: "capture" }],
            ["system.run", { command: "status" }]
        ] as const;
        for (const [name, operationArguments] of invocations) {
            await expect(
                requireOperation(internal, name).execute(operationContext(admitted), {
                    deviceId: phone.value,
                    arguments: operationArguments
                })
            ).resolves.toEqual({ operation: name });
        }
        expect(transport.sent.map((request) => request.operation)).toEqual([
            "camera",
            "location",
            "sms",
            "screen",
            "system.run"
        ]);
        await expect(
            requireOperation(internal, "readCached").execute(operationContext(undefined), {
                deviceId: phone.value,
                key: "present"
            })
        ).resolves.toEqual({ cached: true });
    });

    test("command() routes every typed operation and emits invoked/completed evidence", {
        tags: "p1"
    }, async () => {
        const agent = principal("command-agent");
        const phone = deviceId("command-phone");
        const consent = new MemoryDeviceConsentBackend(() => 1);
        consent.grant(phone, agent, 1000);
        const transport = new TestDeviceTransport();
        const { runtime, admission } = recordingRuntime("device-command", undefined, (_request, input) =>
            consent.admit(undefined, inputDevice(input), agent)
        );
        const facet = new DeviceFacet(
            runtime,
            new DeviceBackend(new LiveSession(), transport, { read: () => undefined })
        );
        const commands = [
            ["camera", { facing: "front" }],
            ["location", { accuracyMeters: 5 }],
            ["sms", { to: "+15550000", message: "hello" }],
            ["screen", { mode: "capture" }],
            ["system.run", { command: "status" }]
        ] as const;

        for (const [operation, commandArguments] of commands) {
            await expect(
                facet.command({
                    commandId: new DeviceCommandId(`command-${operation}`),
                    deviceId: phone,
                    operation,
                    arguments: commandArguments
                })
            ).resolves.toEqual({ operation });
        }

        expect(transport.sent.map((request) => request.operation)).toEqual([
            "camera",
            "location",
            "sms",
            "screen",
            "system.run"
        ]);
        expect(admission.calls.map((call) => [call.kind, call.name])).toEqual(
            commands.flatMap(([operation]) => [
                ["invoke", operation],
                ["emit", "command.invoked"],
                ["emit", "command.completed"]
            ])
        );
        const [invokedCall, completedCall] = admission.calls.slice(1, 3);
        expect(invokedCall?.input).toEqual({
            commandId: "command-camera",
            operation: "camera",
            deviceId: phone.value,
            arguments: { facing: "front" }
        });
        expect(completedCall?.input).toEqual({
            commandId: "command-camera",
            succeeded: true,
            result: { operation: "camera" }
        });
        expect(invokedCall?.receipt).toBeDefined();
        expect(invokedCall?.receipt).toBe(completedCall?.receipt);
    });
});

class LiveSession extends DeviceEnvironmentSessionDependency {
    public assertUsable(): void {}
}

class RecordingSession extends DeviceEnvironmentSessionDependency {
    public constructor(private readonly check: (deviceId: DeviceId) => void) {
        super();
    }
    public assertUsable(deviceId: DeviceId): void {
        this.check(deviceId);
    }
}

class TestDeviceTransport implements ReverseDeviceTransportBackend {
    public readonly sent: DeviceTransportRequest[] = [];
    public readonly admissions: DeviceAdmission[] = [];
    public readonly dispatched: EffectDispatch[] = [];
    public readonly paired: Array<readonly string[]> = [];

    public async pair(
        deviceId: DeviceId,
        publicKey: string,
        operatorApproval: string
    ): Promise<void> {
        this.paired.push([deviceId.value, publicKey, operatorApproval]);
    }

    public async send(
        request: DeviceTransportRequest,
        admission: DeviceAdmission,
        dispatch: EffectDispatch
    ): Promise<JsonValue> {
        this.sent.push(request);
        this.admissions.push(admission);
        this.dispatched.push(dispatch);
        return { operation: request.operation };
    }
}

/**
 * A reverse transport that dedups on the canonical idempotency key: the first send
 * delivers then crashes before the outcome is recorded; a retry carrying the same key
 * returns the prior result without re-delivering (SPEC §7.4).
 */
class DedupDeviceTransport implements ReverseDeviceTransportBackend {
    public readonly attempts: EffectDispatch[] = [];
    public deliveries = 0;
    readonly #results = new Map<string, JsonValue>();

    public async pair(): Promise<void> {}

    public async send(
        request: DeviceTransportRequest,
        _admission: DeviceAdmission,
        dispatch: EffectDispatch
    ): Promise<JsonValue> {
        this.attempts.push(dispatch);
        const prior = this.#results.get(dispatch.idempotencyKey);
        if (prior !== undefined) return prior;
        this.deliveries += 1;
        this.#results.set(dispatch.idempotencyKey, { operation: request.operation });
        throw new DeviceError("command.invalid", "crash after send");
    }
}

function cameraInput() {
    return { deviceId: deviceId("phone"), arguments: { facing: "front" } } as const;
}

function deviceId(value: string): DeviceId {
    return new DeviceId(value);
}

function principal(value: string, tenant = "tenant"): PrincipalRef {
    return new PrincipalRef(new TenantId(tenant), new PrincipalId(value));
}

function inputDevice(input: JsonValue): DeviceId {
    if (input === null || Array.isArray(input) || typeof input !== "object") {
        throw new TypeError("Expected Device input");
    }
    const value = (input as Record<string, JsonValue>)["deviceId"];
    if (typeof value !== "string") throw new TypeError("Expected Device ID");
    return new DeviceId(value);
}

function effectContext(admission: unknown): ProfileEffectContext {
    return new ProfileEffectContext(
        new InvocationId("device-test-invocation"),
        0,
        "device-test-key",
        new EffectAttemptId("device-test-attempt"),
        0,
        Digest.sha256(new TextEncoder().encode("device-test")),
        admission
    );
}

function grantAndAdmit(
    consent: MemoryDeviceConsentBackend,
    deviceId: DeviceId,
    agentId: PrincipalRef,
    expiresAt: number
): DeviceAdmission {
    consent.grant(deviceId, agentId, expiresAt);
    return consent.admit(undefined, deviceId, agentId);
}

function deviceManifest(): FacetManifest {
    return createDeviceManifest({
        id: new FacetPackageId("profile.device"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        bindings: [
            new BindingRequirement(
                new BindingName(DEVICE_ENVIRONMENT_BINDING),
                new FacetPackageId("dependency.environment"),
                new CompatRange("^1.0.0", "^1.0.0")
            )
        ]
    });
}

function requireOperation(internal: InternalProfileFacetRuntime, name: string): Operation {
    const operation = internal.operation(new OperationName(name));
    if (operation === undefined) throw new TypeError(`Operation ${name} is not registered`);
    return operation;
}

function operationContext(targetAdmission: unknown): OperationContext {
    return {
        invocation: new InvocationId("device-internal-invocation"),
        itemIndex: 0,
        idempotencyKey: "device-internal-key",
        attempt: {
            id: new EffectAttemptId("device-internal-attempt"),
            ordinal: 0,
            intentDigest: Digest.sha256(new TextEncoder().encode("device-internal"))
        },
        targetAdmission,
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    };
}
