import { Digest, type JsonValue } from "../../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../../src/identity";
import {
    DEVICE_COMMANDS,
    DEVICE_COMMAND_EVENTS,
    DEVICE_CONTRIBUTIONS,
    DEVICE_OPERATIONS,
    DEVICE_OPERATION_CONTRACTS,
    DeviceBackend,
    DeviceCommandId,
    DeviceConsentBackend,
    DeviceEnvironmentSessionDependency,
    DeviceFacet,
    DeviceId,
    MemoryDeviceConsentBackend,
    ProfileEffectContext,
    VersionedProfileWireCodec,
    type DeviceAdmission,
    type DeviceTransportRequest,
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
        admission: DeviceAdmission
    ): Promise<JsonValue> {
        this.sent.push(request);
        this.admissions.push(admission);
        return { operation: request.operation };
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
