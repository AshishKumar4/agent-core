import { DeviceConsentFinalAdmissionPort } from "../../src/composition";
import { Digest, JsonSchema, isObjectRecord, type JsonValue } from "../../src/core";
import {
    DEVICE_OPERATION_CONTRACTS,
    BindingName,
    DeviceAgentBinding,
    DeviceBackend,
    DeviceConsentBackend,
    DeviceEnvironmentSessionDependency,
    DeviceId,
    FacetRef,
    MemoryDeviceConsentBackend,
    OperationDescriptor,
    OperationName,
    Operation,
    ProfileEffectContext,
    type DeviceAdmission,
    type DeviceTransportRequest,
    type FacetData,
    type OperationContext,
    type ProtectedOperationRequest,
    type ReverseDeviceTransportBackend
} from "../../src/facets";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    ClaimWorkerId,
    EffectAttemptId,
    ItemClaim,
    ItemClaimId,
    InvocationId,
    type CanonicalBatchInvocationRequest
} from "../../src/invocations";
import { OperationRequestKey } from "../../src/operations";
import { describe, expect, test } from "vitest";
import { CanonicalBatchHarness } from "./canonical-batch-harness";
import { admissionFor, prepared } from "../invocations/fixture";

const target = new FacetRef("profile:device");
const phone = new DeviceId("phone");
const agent = new PrincipalRef(new TenantId("tenant"), new PrincipalId("agent"));
const binding = new BindingName("device");

function defined<Value>(value: Value | undefined): Value {
    if (value === undefined) throw new TypeError("Expected a defined value");
    return value;
}

describe("Device target-local consent admission", () => {
    test(
        "[P11-DEVICE-CONSENT-PAIR] admits only live consent for the exact Device and Agent pair",
        { tags: "p0" },
        () => {
            const consent = new MemoryDeviceConsentBackend(() => 1);
            const port = admissionPort(consent);
            const otherAgent = new PrincipalRef(
                new TenantId("tenant"),
                new PrincipalId("other-agent")
            );

            consent.grant(phone, otherAgent, 2);
            expect(port.admit({}, request("camera", phone), admissionContext())).toMatchObject({
                kind: "denied"
            });
            consent.grant(phone, agent, 2);
            expect(port.admit({}, request("camera", phone), admissionContext())).toMatchObject({
                kind: "admitted",
                evidence: { deviceId: phone, agentId: agent }
            });
        }
    );

    test(
        "[P11-DEVICE-CONSENT-LIVE] rejects exact-pair consent at its expiration boundary",
        { tags: "p0" },
        () => {
            let now = 1;
            const consent = new MemoryDeviceConsentBackend(() => now);
            consent.grant(phone, agent, 2);
            const port = admissionPort(consent);

            expect(port.admit({}, request("camera", phone), admissionContext()).kind).toBe(
                "admitted"
            );
            now = 2;
            expect(port.admit({}, request("camera", phone), admissionContext())).toMatchObject({
                kind: "denied",
                reason: expect.stringContaining("absent")
            });
        }
    );

    test(
        "[P11-DEVICE-CONSENT-ISOLATION] never applies one Device consent to another Device",
        { tags: "p0" },
        () => {
            const consent = new MemoryDeviceConsentBackend(() => 1);
            consent.grant(new DeviceId("other-phone"), agent, 2);

            expect(
                admissionPort(consent).admit({}, request("camera", phone), admissionContext())
            ).toMatchObject({
                kind: "denied"
            });
        }
    );

    test(
        "[P11-DEVICE-CONSENT-FINAL-CHECK] returns target-local immutable evidence for the exact pair",
        { tags: "p0" },
        () => {
            const consent = new MemoryDeviceConsentBackend(() => 1);
            consent.grant(phone, agent, 2);

            const result = admissionPort(consent).admit(
                {},
                request("camera", phone),
                admissionContext()
            );
            expect(result).toMatchObject({
                kind: "admitted",
                evidence: { deviceId: phone, agentId: agent, admittedAt: 1, sequence: 1 }
            });
            if (result.kind !== "admitted") throw new TypeError("Expected Device admission");
            expect(Object.isFrozen(result.evidence)).toBe(true);
        }
    );

    test(
        "[P11-DEVICE-CONSENT-ABSENT] commits a final W6 denial without an EffectAttempt",
        { tags: "p0" },
        async () => {
            const harness = deviceHarness(new MemoryDeviceConsentBackend(() => 1));
            const invocation = new InvocationId("device-consent-absent");
            let executed = false;

            const result = await harness.port.invoke(
                request("camera", phone, invocation, async () => {
                    executed = true;
                    return null;
                })
            );
            const evidence = harness.transactions.transact((transaction) => ({
                attempts: harness.persistence.attemptsForItem(transaction, invocation, 0),
                receipt: harness.ledger.currentReceipt(transaction, invocation, 0)
            }));

            expect(result.items[0]).toMatchObject({
                kind: "terminal",
                receipt: { outcome: "deniedPreEffect" }
            });
            expect(evidence.attempts).toEqual([]);
            expect(evidence.receipt).toMatchObject({ outcome: "deniedPreEffect" });
            expect(executed).toBe(false);
        }
    );

    test(
        "[P11-DEVICE-CONSENT-REVOCATION] denies without an EffectAttempt when revocation wins final admission",
        { tags: "p0" },
        async () => {
            const consent = new MemoryDeviceConsentBackend(() => 1);
            consent.grant(phone, agent, 2);
            const harness = deviceHarness(consent);
            const invocation = new InvocationId("device-consent-revoked");
            const issued = deferred<void>();
            const release = deferred<void>();
            harness.permits.onIssue = async () => {
                issued.resolve(undefined);
                await release.promise;
            };

            const running = harness.port.invoke(request("camera", phone, invocation));
            await issued.promise;
            consent.revoke(phone, agent);
            release.resolve(undefined);
            await expect(running).resolves.toMatchObject({
                items: [{ kind: "terminal", receipt: { outcome: "deniedPreEffect" } }]
            });
            expect(
                harness.transactions.transact((transaction) =>
                    harness.persistence.attemptsForItem(transaction, invocation, 0)
                )
            ).toEqual([]);
        }
    );

    test(
        "[P11-DEVICE-CONSENT-ADMITTED] keeps an external effect admitted after its EffectAttempt despite revocation",
        { tags: "p0" },
        async () => {
            const consent = new MemoryDeviceConsentBackend(() => 1);
            consent.grant(phone, agent, 2);
            const harness = deviceHarness(consent);
            const invocation = new InvocationId("device-consent-admitted");
            const started = deferred<void>();
            const release = deferred<void>();

            const running = harness.port.invoke(
                request("camera", phone, invocation, async (_itemIndex, context) => {
                    expect(context.targetAdmission).toMatchObject({
                        deviceId: phone,
                        agentId: agent
                    });
                    started.resolve(undefined);
                    await release.promise;
                    return { sent: true };
                })
            );
            await started.promise;
            expect(
                harness.transactions.transact((transaction) =>
                    harness.persistence.attemptsForItem(transaction, invocation, 0)
                )
            ).toHaveLength(1);
            consent.revoke(phone, agent);
            release.resolve(undefined);

            await expect(running).resolves.toMatchObject({
                items: [{ kind: "succeeded", output: { sent: true } }]
            });
        }
    );

    test(
        "[P11-DEVICE-CACHED-READ] keeps cached observe reads outside live consent admission",
        { tags: "p1" },
        () => {
            const port = admissionPort(new MemoryDeviceConsentBackend(() => 1));
            expect(port.admit({}, request("readCached", phone), admissionContext())).toEqual({
                kind: "admitted"
            });
        }
    );

    test(
        "fails closed for substituted targets, operations, and malformed canonical inputs",
        { tags: "p0" },
        () => {
            const consent = new MemoryDeviceConsentBackend(() => 1);
            const port = admissionPort(consent);
            const base = request("camera", phone);
            const cases = [
                {
                    ...base,
                    request: { ...base.request, facet: new FacetRef("profile:other") }
                },
                {
                    ...base,
                    request: {
                        ...base.request,
                        descriptor: new OperationDescriptor(
                            new OperationName("unknown"),
                            "externalSend",
                            new JsonSchema({}),
                            new JsonSchema({})
                        )
                    }
                },
                { ...base, request: { ...base.request, inputs: [] } },
                { ...base, request: { ...base.request, inputs: [null] } },
                { ...base, request: { ...base.request, inputs: [[]] } },
                { ...base, request: { ...base.request, inputs: [{}] } },
                {
                    ...base,
                    request: { ...base.request, inputs: [defined(base.request.inputs[0]), {}] }
                }
            ];

            for (const candidate of cases) {
                expect(port.admit({}, candidate, admissionContext())).toMatchObject({
                    kind: "denied"
                });
            }
        }
    );

    test("preserves target consent infrastructure failures", { tags: "p1" }, () => {
        const consent = new (class extends DeviceConsentBackend<object> {
            protected assertLive(): number {
                throw new TypeError("consent store unavailable");
            }
        })();
        expect(() =>
            admissionPort(consent).admit({}, request("camera", phone), admissionContext())
        ).toThrow("consent store unavailable");
    });

    test(
        "[P11-DEVICE-CONSENT-ADMITTED] does not let revocation cancel transport after W6 admission commits",
        { tags: "p0" },
        async () => {
            const consent = new MemoryDeviceConsentBackend(() => 1);
            consent.grant(phone, agent, 2);
            const final = admissionPort(consent).admit(
                {},
                request("camera", phone),
                admissionContext()
            );
            expect(final.kind).toBe("admitted");
            if (final.kind !== "admitted") throw new TypeError("Expected Device admission");
            if (!isDeviceAdmission(final.evidence)) {
                throw new TypeError("Expected exact Device admission evidence");
            }
            consent.revoke(phone, agent);
            const transport = new TestTransport();
            const backend = new DeviceBackend(new LiveSession(), transport, {
                read: () => undefined
            });

            await backend.execute(
                "camera",
                { deviceId: phone, arguments: { facing: "front" } },
                effectContext(final.evidence)
            );

            expect(transport.sent).toHaveLength(1);
            expect(transport.admissions[0]).toBe(final.evidence);
        }
    );
});

function admissionPort(consent: DeviceConsentBackend<object>) {
    return new DeviceConsentFinalAdmissionPort(
        target,
        new (class extends DeviceAgentBinding {
            public agent(): PrincipalRef {
                return agent;
            }
        })(),
        consent
    );
}

function admissionContext() {
    const invocation = prepared("device-final-admission");
    const claim = new ItemClaim(
        new ItemClaimId("claim:device-final-admission:0"),
        invocation.header.id,
        0,
        0,
        {
            kind: "system",
            actor: invocation.header.actor,
            worker: new ClaimWorkerId("worker:device-final-admission")
        },
        new Date(2)
    );
    return {
        invocation,
        claim,
        authorityAdmission: admissionFor(invocation.header.id.value, 0, 0),
        admittedAt: new Date(1)
    };
}

function request(
    operation: "camera" | "readCached",
    device: DeviceId,
    invocation = new InvocationId(`device-${operation}`),
    execute: CanonicalBatchInvocationRequest<ProtectedOperationRequest>["request"]["execute"] = async () =>
        null
): CanonicalBatchInvocationRequest<ProtectedOperationRequest> {
    const contract =
        operation === "camera"
            ? DEVICE_OPERATION_CONTRACTS.camera
            : DEVICE_OPERATION_CONTRACTS.readCached;
    const input =
        operation === "camera"
            ? { deviceId: device.value, arguments: { facing: "front" } }
            : { deviceId: device.value, key: "last" };
    return {
        invocation,
        request: {
            requestKey: new OperationRequestKey(`device-${operation}`),
            facet: target,
            descriptor: contract.descriptor,
            cardinality: { kind: "single" },
            inputs: [input],
            authorization: {
                facet: target,
                binding,
                operation: new TestDeviceOperation(contract.descriptor),
                input,
                resultMode: "output"
            },
            interceptions: [[]],
            execute
        }
    };
}

function deviceHarness(consent: DeviceConsentBackend<object>) {
    return new CanonicalBatchHarness<ProtectedOperationRequest>(
        false,
        target,
        DEVICE_OPERATION_CONTRACTS.camera.descriptor,
        admissionPort(consent)
    );
}

class TestDeviceOperation extends Operation {
    public constructor(public readonly descriptor: OperationDescriptor) {
        super();
    }

    public async execute(_context: OperationContext, input: FacetData): Promise<FacetData> {
        return input;
    }
}

class LiveSession extends DeviceEnvironmentSessionDependency {
    public assertUsable(): void {}
}

class TestTransport implements ReverseDeviceTransportBackend {
    public readonly sent: DeviceTransportRequest[] = [];
    public readonly admissions: DeviceAdmission[] = [];

    public async pair(): Promise<void> {}

    public async send(
        request: DeviceTransportRequest,
        admission: DeviceAdmission
    ): Promise<JsonValue> {
        this.sent.push(request);
        this.admissions.push(admission);
        return { sent: true };
    }
}

function isDeviceAdmission(admission: unknown): admission is DeviceAdmission {
    return (
        isObjectRecord(admission) &&
        admission["deviceId"] instanceof DeviceId &&
        admission["deviceId"].equals(phone) &&
        admission["agentId"] instanceof PrincipalRef &&
        admission["agentId"].equals(agent) &&
        admission["admittedAt"] === 1 &&
        admission["sequence"] === 1
    );
}

function effectContext(admission: DeviceAdmission): ProfileEffectContext {
    if (!isObjectRecord(admission)) throw new TypeError("Expected Device admission object");
    return new ProfileEffectContext(
        new AbortController().signal,
        new InvocationId("device-admitted"),
        0,
        "device-admitted-key",
        new EffectAttemptId("device-admitted-attempt"),
        0,
        Digest.sha256(new TextEncoder().encode("device-admitted")),
        admission
    );
}

function deferred<Value>() {
    let accept: ((value: Value | PromiseLike<Value>) => void) | undefined;
    const promise = new Promise<Value>((resolve) => {
        accept = resolve;
    });
    return {
        promise,
        resolve(value: Value | PromiseLike<Value>): void {
            if (accept === undefined) throw new TypeError("Deferred promise was not initialized");
            accept(value);
        }
    };
}
