import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { RunCommitId } from "../../src/agents";
import { Digest, Revision, SemVer } from "../../src/core";
import {
    FailClosedRunPinsReservationPort,
    PackageId,
    PackagePin,
    type DefinitionPinSet,
    type RunMigrationEvidenceReference,
    type RunPinsReservationPort
} from "../../src/definition";
import { AuditRecordId, ReceiptId } from "../../src/invocations";

const encoder = new TextEncoder();

describe("RunPins integration ports", () => {
    test("fails closed when W5 reservation and migration evidence is unavailable", () => {
        const port: RunPinsReservationPort<undefined> = new FailClosedRunPinsReservationPort();
        const pins = definitionPins();
        const holder = new ActorRef("run", new ActorId("run"));
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
        expect(port.removalEvidence(undefined, pins)).toMatchObject({
            kind: "unknown",
            blockers: ["runpins-integration-unavailable"]
        });
        expect(port.verifyMigration(undefined, migrationEvidence(holder))).toBe(false);
    });
});

function definitionPins(): DefinitionPinSet {
    return {
        blueprint: { version: new SemVer("1.0.0"), digest: digest("blueprint") },
        packages: [
            new PackagePin(
                new PackageId("package"),
                new SemVer("1.0.0"),
                digest("manifest"),
                digest("code")
            )
        ]
    };
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
