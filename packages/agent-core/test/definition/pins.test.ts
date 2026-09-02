import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { RunCommitId } from "../../src/agents";
import { Digest, Revision, SemVer, canonicalTupleKey } from "../../src/core";
import {
    DeferredManagedRecord,
    DeploymentId,
    DeploymentKey,
    FailClosedRunPinsReservationPort,
    PackageId,
    PackagePin,
    PackagePinHolder,
    PackageRetentionObligation,
    RecordedRunPinsReservationPort,
    type DefinitionPinSet,
    type PinHolderKind,
    type RunMigrationEvidenceReference,
    type RunPinsReservationPort
} from "../../src/definition";
import { TenantId } from "../../src/identity";
import { AuditRecordId, ReceiptId } from "../../src/invocations";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));

describe("RunPins integration ports", () => {
    test(
        "fails closed when W5 reservation and migration evidence is unavailable",
        { tags: "p0" },
        () => {
            const port: RunPinsReservationPort<undefined> = new FailClosedRunPinsReservationPort();
            const pins = definitionPins();
            const holder = new PackagePinHolder("run", "run");
            expect(() =>
                port.reserve(undefined, {
                    holder,
                    pins,
                    sourceRevision: Revision.initial(),
                    idempotencyKey: "reserve-run"
                })
            ).toThrow(/unavailable/);
            expect(
                port.release(undefined, {
                    id: digest("reservation"),
                    revision: Revision.initial()
                })
            ).toBe(false);
            const evidence = port.removalEvidence(undefined, pins);
            expect(evidence.kind).toBe("unknown");
            expect(evidence.conclusive).toBe(false);
            expect(evidence.holders).toEqual([]);
            expect(port.verifyMigration(undefined, migrationEvidence(runActor()))).toBe(false);
        }
    );
});

/**
 * SPEC 5.2 keeps a Package release resolvable while any Run, Turn, Session, tree
 * checkpoint, or Snapshot pins it. Each holder is exercised alone, with no Run reservation
 * anywhere in the port, so a check that consulted Runs would answer clear and fail here.
 */
describe("SPEC 5.2 pin holder retention", () => {
    for (const [holderKind, holderId] of [
        ["turn", "turn:retaining"],
        ["session", "environment-session:retaining"],
        ["tree-checkpoint", "checkpoint:retaining"],
        ["snapshot", "snapshot:retaining"]
    ] as const satisfies readonly (readonly [PinHolderKind, string])[]) {
        test(
            `[C13-BLUEPRINT-RUN-PINS] defers removing a release a ${holderKind} pins with no Run holding it`,
            { tags: "p0" },
            () => {
                const port = new RecordedRunPinsReservationPort<undefined>();
                const pins = definitionPins();
                port.reserve(undefined, {
                    holder: new PackagePinHolder(holderKind, holderId),
                    pins,
                    sourceRevision: Revision.initial(),
                    idempotencyKey: `reserve-${holderKind}`
                });

                const evidence = port.removalEvidence(undefined, pins);
                expect(evidence.kind).toBe("blocked");
                expect(evidence.permitsChange).toBe(false);
                expect(evidence.holders.map((holder) => holder.kind)).toEqual([holderKind]);
                expect(evidence.holders.map((holder) => holder.id)).toEqual([holderId]);

                // The deferral is a pending obligation naming its record, reason, and
                // discharging condition, not an opaque refusal (SPEC 9.3).
                const deferral = evidence.deferral(heldRecord(), release());
                const obligation = deferral.obligations[0]!;
                expect(deferral.answerable).toBe(true);
                expect(deferral.obligations).toHaveLength(1);
                expect(obligation).toBeInstanceOf(PackageRetentionObligation);
                expect(obligation.kind).toBe("retention");
                expect(obligation.record).toBe(
                    canonicalTupleKey("definition.package-retention-record.v1", [
                        "acme.deploy",
                        "1.4.0"
                    ])
                );
                expect(obligation.reason).toBe(
                    `${new PackagePinHolder(holderKind, holderId).key} pins that Package release`
                );
                expect(obligation.condition).toBe(
                    "no Run, Turn, Session, tree checkpoint, or Snapshot pins that release or a Run explicitly migrates"
                );
                expect(obligation.held.change).toBe("remove");
                expect(obligation.held.logicalKey).toBe("facet-install:acme.deploy");
            }
        );
    }

    test(
        "[C13-BLUEPRINT-RUN-PINS] removes only once the last pin holder of any kind releases",
        { tags: "p0" },
        () => {
            const port = new RecordedRunPinsReservationPort<undefined>();
            const pins = definitionPins();
            const held = (["turn", "session", "tree-checkpoint", "snapshot"] as const).map(
                (kind) => ({
                    kind,
                    reservation: port.reserve(undefined, {
                        holder: new PackagePinHolder(kind, `${kind}:last-release`),
                        pins,
                        sourceRevision: Revision.initial(),
                        idempotencyKey: `discharge-${kind}`
                    })
                })
            );

            for (let index = 0; index < held.length; index += 1) {
                const remaining = held.slice(index);
                expect(
                    port.removalEvidence(undefined, pins).holders.map((one) => one.kind)
                ).toEqual(remaining.map((entry) => entry.kind).toSorted());
                expect(port.release(undefined, held[index]!.reservation)).toBe(true);
            }

            // Every holder released: the deferral discharges rather than standing forever,
            // so a host that never removes is not credited with satisfying the rule.
            const discharged = port.removalEvidence(undefined, pins);
            expect(discharged.kind).toBe("clear");
            expect(discharged.permitsChange).toBe(true);
            expect(discharged.deferral(heldRecord(), release()).obligations).toEqual([]);
            expect(port.release(undefined, held[0]!.reservation)).toBe(false);
        }
    );

    test(
        "[C13-BLUEPRINT-RUN-PINS] reserves idempotently per holder and answers only the pinned release",
        { tags: "p1" },
        () => {
            const port = new RecordedRunPinsReservationPort<undefined>();
            const pins = definitionPins();
            const request = {
                holder: new PackagePinHolder("snapshot", "snapshot:idempotent"),
                pins,
                sourceRevision: Revision.initial(),
                idempotencyKey: "reserve-once"
            };
            const first = port.reserve(undefined, request);
            expect(port.reserve(undefined, request).id.value).toBe(first.id.value);
            expect(() =>
                port.reserve(undefined, {
                    ...request,
                    holder: new PackagePinHolder("turn", "turn:collides")
                })
            ).toThrow(/belongs to another pin holder/);

            // Another release of the same Package is a different pin: retention answers the
            // exact release, never the Package name.
            const otherVersion: DefinitionPinSet = {
                blueprint: pins.blueprint,
                packages: [
                    new PackagePin(
                        new PackageId("acme.deploy"),
                        new SemVer("1.5.0"),
                        digest("manifest"),
                        digest("code")
                    )
                ]
            };
            expect(port.removalEvidence(undefined, otherVersion).kind).toBe("clear");
            expect(port.removalEvidence(undefined, pins).kind).toBe("blocked");
        }
    );

    test(
        "[C13-BLUEPRINT-RUN-PINS] verifies exactly the Run migrations it processed",
        { tags: "p1" },
        () => {
            const port = new RecordedRunPinsReservationPort<undefined>();
            const pins = definitionPins();
            const reservation = port.reserve(undefined, {
                holder: new PackagePinHolder("run", "run:migrating"),
                pins,
                sourceRevision: Revision.initial(),
                idempotencyKey: "reserve-migrating"
            });
            const evidence = migrationEvidence(runActor());

            expect(port.verifyMigration(undefined, evidence)).toBe(false);
            expect(
                port.release(undefined, reservation, {
                    ...evidence,
                    toPinsDigest: evidence.fromPinsDigest
                })
            ).toBe(false);
            expect(port.release(undefined, reservation, evidence)).toBe(true);
            expect(port.verifyMigration(undefined, evidence)).toBe(true);
            expect(port.removalEvidence(undefined, pins).kind).toBe("clear");
        }
    );
});

function heldRecord(): DeferredManagedRecord {
    return new DeferredManagedRecord({
        kind: "remove",
        current: {
            actor: runActor(),
            tenantId,
            deploymentId,
            resourceId: digest("managed-resource"),
            logicalKey: "facet-install:acme.deploy",
            recordKind: "facet-install",
            desiredDigest: digest("desired"),
            revision: Revision.initial()
        }
    });
}

function release(): PackagePin {
    return definitionPins().packages[0]!;
}

function definitionPins(): DefinitionPinSet {
    return {
        blueprint: { version: new SemVer("1.0.0"), digest: digest("blueprint") },
        packages: [
            new PackagePin(
                new PackageId("acme.deploy"),
                new SemVer("1.4.0"),
                digest("manifest"),
                digest("code")
            )
        ]
    };
}

function runActor(): ActorRef {
    return new ActorRef("run", new ActorId("run"));
}

function migrationEvidence(run: ActorRef): RunMigrationEvidenceReference {
    return {
        run,
        commitId: new RunCommitId("commit"),
        receiptId: new ReceiptId("receipt"),
        auditId: new AuditRecordId("audit"),
        fromPinsDigest: digest("from"),
        toPinsDigest: digest("to"),
        revision: Revision.initial()
    };
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}
