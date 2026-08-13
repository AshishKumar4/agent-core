import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { Digest, type JsonValue } from "../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    ManagedOrigin,
    ManagedStateRecord,
    managedResourceId,
    MaterializationGeneration,
    MaterializationGenerationPointer,
    PolicySet,
    policyProjection
} from "../../src/definition";
import { TenantId } from "../../src/identity";
import { recordData } from "./record-data";

const encoder = new TextEncoder();
const tenantId = new TenantId("tenant");
const deploymentId = DeploymentId.derive(tenantId, new DeploymentKey("platform"));
const actor = new ActorRef("workspace", new ActorId("workspace"));

describe("materialization generation identity and canonicalization", () => {
    test("derives stable managed resource identities under a fixed domain", { tags: "p0" }, () => {
        expect(deploymentId.value).toBe(
            "7f260ac21be89bb250618b0b435ef208e64099f6ca54a6fa0aa444dca61dae79"
        );
        expect(managedResourceId(actor, origin(1), "policy:stable", "policy-set").value).toBe(
            "3f7065f4bec100580757e710af10fe7355c412a4bd4431569a139a6053022868"
        );
    });

    test("canonicalizes generation managed record IDs into sorted unique order", { tags: "p1" }, () => {
        const generation = MaterializationGeneration.fromActorPlan(actorPlan(origin(1)));
        const unsorted = [digest("record-low"), digest("record-high")].sort((left, right) =>
            left.value < right.value ? 1 : -1
        );

        const rebuilt = new MaterializationGeneration({
            actor,
            origin: origin(1),
            actorPlanId: generation.actorPlanId,
            managedRecordIds: unsorted
        });

        expect(rebuilt.managedRecordIds.map((id) => id.value)).toEqual(
            unsorted.map((id) => id.value).sort()
        );
        expect(rebuilt.id.equals(generation.id)).toBe(true);
    });

    test("freezes canonical desired data recursively", { tags: "p1" }, () => {
        const record = ManagedStateRecord.fromProjection(
            actor,
            origin(1),
            MaterializationGeneration.fromActorPlan(actorPlan(origin(1))).id,
            policyProjection("policy:frozen", new PolicySet({ approvals: ["observe"] }))
        );

        const desired = requireObject(record.desired);
        expect(Object.isFrozen(record.desired)).toBe(true);
        expect(Object.isFrozen(desired["placement"])).toBe(true);
        expect(Object.isFrozen(desired["approvals"])).toBe(true);
        expect(desired["maxDirectRevocationWindowMs"]).toBeNull();
    });

    test("rejects blank managed resource names", { tags: "p1" }, () => {
        expect(() => managedResourceId(actor, origin(1), "", "policy-set")).toThrow(
            /nonblank canonical/
        );
        expect(() => managedResourceId(actor, origin(1), "policy:stable", "")).toThrow(
            /nonblank canonical/
        );
    });

    test("rejects padded managed resource names", { tags: "p1" }, () => {
        // kills src/definition/generation.ts:518
        expect(() => managedResourceId(actor, origin(1), " policy:padded ", "policy-set")).toThrow(
            /Managed resource logical key must be a nonblank canonical string/
        );
        expect(() => managedResourceId(actor, origin(1), "policy:stable", " policy-set ")).toThrow(
            /Managed resource record kind must be a nonblank canonical string/
        );
    });

    test("names every malformed managed state field in its codec error", { tags: "p2" }, () => {
        const generation = MaterializationGeneration.fromActorPlan(actorPlan(origin(1)));
        const record = ManagedStateRecord.fromProjection(
            actor,
            origin(1),
            generation.id,
            policyProjection("policy:stable", PolicySet.empty())
        );
        const stateData = recordData(record);
        expect(() => ManagedStateRecord.fromData({ ...stateData, desiredDigest: 7 })).toThrow(
            "Managed state desired digest must be a string"
        );
        expect(() => ManagedStateRecord.fromData({ ...stateData, id: 7 })).toThrow(
            "Managed state ID must be a string"
        );
        expect(() => ManagedStateRecord.fromData({ ...stateData, resourceId: 7 })).toThrow(
            "Managed resource ID must be a string"
        );
        expect(() => ManagedStateRecord.fromData({ ...stateData, logicalKey: 7 })).toThrow(
            "Managed state logical key must be a string"
        );
        expect(() => ManagedStateRecord.fromData({ ...stateData, recordKind: 7 })).toThrow(
            "Managed state record kind must be a string"
        );
        expect(() =>
            ManagedStateRecord.fromData({ ...stateData, origin: undefined } as never)
        ).toThrow("Managed state origin is required");
        expect(() =>
            ManagedStateRecord.fromData({ ...stateData, actor: { id: 7, kind: "workspace" } })
        ).toThrow("Actor ID must be a string");

        const generationData = recordData(generation);
        expect(() => MaterializationGeneration.fromData({ ...generationData, id: 7 })).toThrow(
            "Materialization generation ID must be a string"
        );
        expect(() =>
            MaterializationGeneration.fromData({ ...generationData, managedRecordIds: [7] })
        ).toThrow("Materialization generation managed state ID 0 must be a string");

        const pointer = MaterializationGenerationPointer.initial(actor, deploymentId, generation.id);
        expect(() =>
            MaterializationGenerationPointer.fromData({
                ...recordData(pointer),
                deploymentId: 7
            })
        ).toThrow("Generation pointer deployment ID must be a string");
    });

    test("distinguishes non-object payloads in codec errors", { tags: "p2" }, () => {
        expect(() => ManagedStateRecord.fromData(null)).toThrow("Managed state must be an object");
        expect(() => ManagedStateRecord.fromData([])).toThrow("Managed state must be an object");
        expect(() => ManagedStateRecord.fromData("payload")).toThrow(
            "Managed state must be an object"
        );
    });

    test("rejects malformed pointer revisions with the exact subject", { tags: "p2" }, () => {
        const generation = MaterializationGeneration.fromActorPlan(actorPlan(origin(1)));
        const pointer = MaterializationGenerationPointer.initial(actor, deploymentId, generation.id);
        const data = recordData(pointer);
        for (const revision of ["1", -1, 0.5]) {
            expect(() =>
                MaterializationGenerationPointer.fromData({ ...data, revision })
            ).toThrow("Generation pointer revision must be a non-negative safe integer");
        }
    });
});

function actorPlan(materializationOrigin: ManagedOrigin): ActorPlan {
    return new ActorPlan({
        actor,
        origin: materializationOrigin,
        projections: [policyProjection("policy:stable", PolicySet.empty())]
    });
}

function origin(generation: number): ManagedOrigin {
    return new ManagedOrigin({
        tenantId,
        deploymentId,
        attestationDigest: digest("attestation"),
        blueprintDigest: digest("blueprint"),
        packageLockDigest: digest("lock"),
        configDigest: digest("config"),
        generation
    });
}

function requireObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new TypeError("Expected object");
    }
    return value as { readonly [key: string]: JsonValue };
}

function digest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}
