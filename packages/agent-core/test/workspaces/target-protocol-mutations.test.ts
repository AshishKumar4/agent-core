import { describe, expect, test } from "vitest";
import { Digest, Revision } from "../../src/core";
import { CommandCallerPolicy, CommandEnvelope, type ProtocolValueCodec } from "../../src/protocol";
import {
    AuditRecordId,
    EventId,
    InvocationId,
    RouteProjectionId,
    RouteReservationId
} from "../../src/interaction-references";
import { MemoryWorkspaceRecords } from "../../src/workspaces/memory";
import { WorkspacePersistence } from "../../src/workspaces/persistence";
import type {
    InteractionAuditPort,
    InteractionIdPort,
    InvocationAdmissionPort
} from "../../src/workspaces/ports";
import {
    ContentRetentionReference,
    type ContentRetentionPort
} from "../../src/workspaces/retention";
import {
    RouteProjection,
    RouteProjectionAuthenticator,
    RouteReservation,
    routeProjectionEnvelopeBytes,
    type RouteDelivery,
    type RouteProjectionEnvelope
} from "../../src/workspaces/route";
import {
    TARGET_PROJECTION_COMMAND,
    TargetProjectionCommandPort,
    TargetProjectionProtocol,
    createTargetProjectionProtocolCommand,
    type TargetProjectionAdmission
} from "../../src/workspaces/target-protocol";
import {
    content,
    projectionFixture,
    projectionRetention,
    reservationFixture,
    retentionFixture,
    sourceActor,
    targetActor,
    tenant
} from "./fixtures";

class SequenceIds implements InteractionIdPort {
    #next = 0;

    public reservation(): RouteReservationId {
        return new RouteReservationId(this.id("reservation"));
    }

    public projection(): RouteProjectionId {
        return new RouteProjectionId(this.id("projection"));
    }

    public invocation(): InvocationId {
        return new InvocationId(this.id("invocation"));
    }

    public eventAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-event"));
    }

    public reservationAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-reservation"));
    }

    public projectionAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-projection"));
    }

    public deliveryAudit(): AuditRecordId {
        return new AuditRecordId(this.id("audit-delivery"));
    }

    public logicalDelivery(): string {
        return this.id("logical-delivery");
    }

    private id(kind: string): string {
        this.#next += 1;
        return `${kind}-${this.#next}`;
    }
}

class NoopAudit implements InteractionAuditPort<MemoryWorkspaceRecords> {
    public appendEvent(): void {}
    public appendReservation(): void {}
    public appendProjectionRoot(): void {}
    public appendDelivery(): void {}
}

class RecordingRetention implements ContentRetentionPort<MemoryWorkspaceRecords> {
    public durable = true;
    public readonly discarded: string[] = [];

    public verify(): boolean {
        return this.durable;
    }

    public release(): void {}

    public discard(reference: ContentRetentionReference): void {
        this.discarded.push(reference.id.value);
    }
}

class TestProjectionAuthenticator extends RouteProjectionAuthenticator {
    public evidence(envelope: RouteProjectionEnvelope): Uint8Array {
        return signature(routeProjectionEnvelopeBytes(envelope));
    }

    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        const expected = signature(message);
        return (
            expected.length === evidence.length &&
            expected.every((byte, index) => byte === evidence[index])
        );
    }
}

class ForgedInvocation extends EventId {
    public override equals(): boolean {
        return true;
    }
}

class DelegatingPort extends TargetProjectionCommandPort<object> {
    public readonly caller = CommandCallerPolicy.actor("workspace");
    public readonly expectedRevision = "forbidden" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload = new ReferenceCodec<TargetProjectionAdmission>();
    public readonly resultCodec: ProtocolValueCodec<RouteDelivery> =
        new ReferenceCodec<RouteDelivery>();

    public constructor(
        private readonly allowed: boolean,
        private readonly revision: Revision | undefined
    ) {
        super();
    }

    public authorize(): boolean {
        return this.allowed;
    }

    public permitsLifecycle(): boolean {
        return !this.allowed;
    }

    public currentRevision(): Revision | undefined {
        return this.revision;
    }

    public currentLease(): undefined {
        return undefined;
    }
}

class ReferenceCodec<Value> implements ProtocolValueCodec<Value> {
    readonly #values = new Map<string, Value>();
    #next = 0;

    public encode(value: Value): Uint8Array {
        this.#next += 1;
        const key = `reference-${this.#next}`;
        this.#values.set(key, value);
        return new TextEncoder().encode(key);
    }

    public decode(bytes: Uint8Array): Value {
        const value = this.#values.get(new TextDecoder().decode(bytes));
        if (value === undefined) throw new TypeError("Unknown test command reference");
        return value;
    }
}

interface TargetHarness {
    readonly records: MemoryWorkspaceRecords;
    readonly retention: RecordingRetention;
    readonly protocol: TargetProjectionProtocol<MemoryWorkspaceRecords>;
}

function createTargetHarness(
    invocations?: InvocationAdmissionPort<MemoryWorkspaceRecords>
): TargetHarness {
    const records = new MemoryWorkspaceRecords();
    const retention = new RecordingRetention();
    const protocol = new TargetProjectionProtocol(
        targetActor,
        new WorkspacePersistence<MemoryWorkspaceRecords>(
            (value) => value,
            retention,
            targetActor,
            tenant
        ),
        retention,
        { authorize: () => ({ kind: "accepted" as const }) },
        invocations ?? {
            admit: (_records, input) => ({
                kind: "accepted",
                invocation: input.reservation.invocation
            })
        },
        new NoopAudit(),
        new SequenceIds()
    );
    return { records, retention, protocol };
}

function authenticatedAdmission(suffix: string): TargetProjectionAdmission {
    const reservation = reservationFixture(suffix);
    const projection = projectionFixture(reservation);
    const envelope = { reservation, projection };
    const authenticator = new TestProjectionAuthenticator();
    return {
        projection: authenticator.authenticate(envelope, authenticator.evidence(envelope)),
        retention: projectionRetention(projection)
    };
}

function signature(message: Uint8Array): Uint8Array {
    return new TextEncoder().encode(Digest.sha256(message).value);
}

describe("TargetProjectionProtocol mutation coverage", () => {
    test(
        "replay without the stored projection index is an exact duplicate conflict",
        {
            tags: "p0"
        },
        () => {
            const harness = createTargetHarness();
            const input = authenticatedAdmission("missing-stored");
            const first = harness.protocol.admit(harness.records, input);
            expect(first.state.kind).toBe("delivered");

            const snapshot = harness.records.snapshot();
            const withoutProjectionIndex = new MemoryWorkspaceRecords({
                ...snapshot,
                uniques: snapshot.uniques.filter(
                    (unique) => unique.namespace !== "route.projection"
                )
            });

            expect(() => harness.protocol.admit(withoutProjectionIndex, input)).toThrow(
                expect.objectContaining({
                    code: "protocol.duplicate",
                    message: "Route retry conflicts with the admitted authenticated projection"
                })
            );
        }
    );

    test(
        "replay keeps a retention that is already listed for the stored projection",
        {
            tags: "p0"
        },
        () => {
            const harness = createTargetHarness();
            const input = authenticatedAdmission("retention-idempotent");
            const projection = projectionFixture(input.projection.envelope.reservation);
            const first = harness.protocol.admit(harness.records, input);

            const extra = retentionFixture({
                actor: targetActor,
                id: "retention-extra-unmatched",
                recordKind: "routeProjection",
                recordId: projection.id.value,
                content: content("retention-extra-unmatched")
            });
            harness.records.insertRecord({
                kind: "contentRetention",
                id: extra.id.value,
                bytes: ContentRetentionReference.encode(extra)
            });

            const replay = harness.protocol.admit(harness.records, input);
            expect(replay).toEqual(first);
            expect(harness.retention.discarded).toEqual([]);
        }
    );

    test(
        "replay discards a redundant retention that the stored projection never listed",
        {
            tags: "p0"
        },
        () => {
            const harness = createTargetHarness();
            const input = authenticatedAdmission("retention-redundant");
            const projection = projectionFixture(input.projection.envelope.reservation);
            const first = harness.protocol.admit(harness.records, input);

            const replacement = projectionRetention(
                projection,
                targetActor,
                "retention-replacement"
            );
            const replay = harness.protocol.admit(harness.records, {
                projection: input.projection,
                retention: replacement
            });
            expect(replay).toEqual(first);
            expect(harness.retention.discarded).toEqual(["retention-replacement"]);
        }
    );

    test(
        "non-durable target retention is rejected with the exact invalid-state error",
        {
            tags: "p0"
        },
        () => {
            const harness = createTargetHarness();
            harness.retention.durable = false;
            const input = authenticatedAdmission("retention-not-durable");

            expect(() => harness.protocol.admit(harness.records, input)).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Target projection retention is not durable"
                })
            );
            expect(harness.retention.discarded).toEqual([input.retention.id.value]);
        }
    );

    test(
        "invocation admission must return the reservation's own Invocation ID instance",
        {
            tags: "p0"
        },
        () => {
            const substituted = createTargetHarness({
                admit: (_records, input) => ({
                    kind: "accepted",
                    invocation: new EventId(input.reservation.invocation.value)
                })
            });
            expect(() =>
                substituted.protocol.admit(
                    substituted.records,
                    authenticatedAdmission("invocation-not-instance")
                )
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Invocation admission substituted the stable route Invocation ID"
                })
            );
            expect(substituted.records.listRecords("routeDelivery")).toEqual([]);

            const forged = createTargetHarness({
                admit: (_records, input) => ({
                    kind: "accepted",
                    invocation: new ForgedInvocation(input.reservation.invocation.value)
                })
            });
            expect(() =>
                forged.protocol.admit(forged.records, authenticatedAdmission("invocation-forged"))
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.invalid-state",
                    message: "Invocation admission substituted the stable route Invocation ID"
                })
            );
            expect(forged.records.listRecords("routeDelivery")).toEqual([]);
        }
    );

    test(
        "replay with conflicting projection content of equal encoded length is rejected",
        {
            tags: "p0"
        },
        () => {
            const harness = createTargetHarness();
            const input = authenticatedAdmission("conflicting-bytes");
            harness.protocol.admit(harness.records, input);

            const reservation = input.projection.envelope.reservation;
            const changedContent = content("conflicting-bytes-changed");
            const changedReservation = new RouteReservation({
                ...reservation.init,
                projectionRef: changedContent.ref,
                projectionDigest: changedContent.digest
            });
            const changedProjection = projectionFixture(changedReservation);
            const authenticator = new TestProjectionAuthenticator();
            const envelope = { reservation: changedReservation, projection: changedProjection };
            const conflicting = authenticator.authenticate(
                envelope,
                authenticator.evidence(envelope)
            );

            const storedEncoding = RouteProjection.codec.encode(
                projectionFixture(reservation).authenticate(input.projection.digest)
            );
            const conflictingEncoding = RouteProjection.codec.encode(
                changedProjection.authenticate(conflicting.digest)
            );
            expect(conflictingEncoding.byteLength).toBe(storedEncoding.byteLength);
            expect(conflictingEncoding).not.toEqual(storedEncoding);

            expect(() =>
                harness.protocol.admit(harness.records, {
                    projection: conflicting,
                    retention: projectionRetention(changedProjection)
                })
            ).toThrow(
                expect.objectContaining({
                    code: "protocol.duplicate",
                    message: "Route retry conflicts with the admitted authenticated projection"
                })
            );
        }
    );

    test(
        "projection targeting another Actor is denied with the exact authority error",
        {
            tags: "p0"
        },
        () => {
            const harness = createTargetHarness();
            const wrongTarget = reservationFixture("wrong-target-denied", { target: sourceActor });
            const projection = projectionFixture(wrongTarget);
            const authenticator = new TestProjectionAuthenticator();
            const envelope = { reservation: wrongTarget, projection };

            expect(() =>
                harness.protocol.admit(harness.records, {
                    projection: authenticator.authenticate(
                        envelope,
                        authenticator.evidence(envelope)
                    ),
                    retention: projectionRetention(projection)
                })
            ).toThrow(
                expect.objectContaining({
                    name: "AgentCoreError",
                    code: "authority.denied",
                    message: "Authenticated route projection targets another Actor"
                })
            );
        }
    );

    test(
        "command evidence delegates authorization, lifecycle, and revision to its port",
        {
            tags: "p1"
        },
        () => {
            const harness = createTargetHarness();
            const admission = authenticatedAdmission("delegation");
            const envelope = new CommandEnvelope({
                command: TARGET_PROJECTION_COMMAND,
                caller: { kind: "actor", actor: targetActor },
                idempotencyKey: "delegation-idempotency",
                payload: admission.retention.content,
                payloadDigest: admission.retention.digest
            });
            const revision = new Revision(7);

            const granting = createTargetProjectionProtocolCommand(
                harness.protocol,
                new DelegatingPort(true, revision)
            );
            expect(granting.authorize({}, envelope, admission)).toBe(true);
            expect(granting.permitsLifecycle({}, envelope, admission)).toBe(false);
            expect(granting.currentRevision({}, envelope, admission)).toBe(revision);

            const denying = createTargetProjectionProtocolCommand(
                harness.protocol,
                new DelegatingPort(false, undefined)
            );
            expect(denying.authorize({}, envelope, admission)).toBe(false);
            expect(denying.permitsLifecycle({}, envelope, admission)).toBe(true);
            expect(denying.currentRevision({}, envelope, admission)).toBeUndefined();
        }
    );
});
