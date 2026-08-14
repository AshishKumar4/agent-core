import { describe, expect, test } from "vitest";
import { WorkspaceId as IdentityWorkspaceId } from "../../src/identity";
import * as interaction from "../../src/interaction-references";
import * as invocationReferences from "../../src/invocation-references";
import * as invocations from "../../src/invocations";
import {
    AuditRecordId as InvocationAuditRecordId,
    CorrelationId as InvocationCorrelationId,
    InvocationId as InvocationInvocationId,
    ReceiptId,
    RouteProjectionId as InvocationRouteProjectionId,
    RouteReservationId as InvocationRouteReservationId
} from "../../src/invocations";
import {
    AuditRecordId as WorkspaceAuditRecordId,
    CorrelationId as WorkspaceCorrelationId,
    EventId as WorkspaceEventId,
    InvocationId as WorkspaceInvocationId,
    RouteProjectionId as WorkspaceRouteProjectionId,
    RouteReservationId as WorkspaceRouteReservationId,
    SubscriptionId as WorkspaceSubscriptionId,
    WorkspaceId
} from "../../src/workspaces";

describe("canonical interaction identities", () => {
    test("re-exports one frozen constructor through W6 and W7 barrels", { tags: "p1" }, () => {
        expect(InvocationAuditRecordId).toBe(interaction.AuditRecordId);
        expect(InvocationCorrelationId).toBe(interaction.CorrelationId);
        expect(InvocationInvocationId).toBe(interaction.InvocationId);
        expect(InvocationRouteProjectionId).toBe(interaction.RouteProjectionId);
        expect(InvocationRouteReservationId).toBe(interaction.RouteReservationId);
        expect(WorkspaceAuditRecordId).toBe(interaction.AuditRecordId);
        expect(WorkspaceCorrelationId).toBe(interaction.CorrelationId);
        expect(WorkspaceEventId).toBe(interaction.EventId);
        expect(WorkspaceInvocationId).toBe(interaction.InvocationId);
        expect(WorkspaceRouteProjectionId).toBe(interaction.RouteProjectionId);
        expect(WorkspaceRouteReservationId).toBe(interaction.RouteReservationId);
        expect(WorkspaceSubscriptionId).toBe(interaction.SubscriptionId);

        for (const Type of Object.values(interaction)) {
            expect(Object.isFrozen(new Type("canonical-id"))).toBe(true);
        }
    });

    test(
        "every interaction and invocation reference ID names its exact subject",
        { tags: "p2" },
        () => {
            const cases = [
                { label: "Event ID", make: () => new interaction.EventId("") },
                { label: "Subscription ID", make: () => new interaction.SubscriptionId("") },
                { label: "Invocation ID", make: () => new interaction.InvocationId("") },
                { label: "Correlation ID", make: () => new interaction.CorrelationId("") },
                {
                    label: "Route reservation ID",
                    make: () => new interaction.RouteReservationId("")
                },
                { label: "Route projection ID", make: () => new interaction.RouteProjectionId("") },
                { label: "Audit record ID", make: () => new interaction.AuditRecordId("") },
                { label: "Approval ID", make: () => new invocationReferences.ApprovalId("") },
                { label: "Receipt ID", make: () => new invocationReferences.ReceiptId("") },
                {
                    label: "Effect attempt ID",
                    make: () => new invocationReferences.EffectAttemptId("")
                },
                { label: "Item claim ID", make: () => new invocationReferences.ItemClaimId("") },
                {
                    label: "Claim worker ID",
                    make: () => new invocationReferences.ClaimWorkerId("")
                },
                { label: "Write record ID", make: () => new invocationReferences.WriteRecordId("") }
            ] as const;
            for (const { label, make } of cases) {
                expect(make, label).toThrow(
                    new TypeError(`${label} must contain between 1 and 256 characters`)
                );
            }
        }
    );

    test("keeps W2 WorkspaceId and W6 ReceiptId distinct", { tags: "p1" }, () => {
        expect(WorkspaceId).toBe(IdentityWorkspaceId);
        for (const [name, Type] of Object.entries(invocationReferences)) {
            if (!isInvocationExport(name)) {
                throw new TypeError(`Missing invocation export ${name}`);
            }
            expect(invocations[name]).toBe(Type);
            expect(Object.isFrozen(new Type("canonical-id"))).toBe(true);
        }
        expect(new WorkspaceId("same").equals(new IdentityWorkspaceId("same"))).toBe(true);
        expect(new interaction.InvocationId("same").equals(new ReceiptId("same"))).toBe(false);
    });
});

function isInvocationExport(name: string): name is keyof typeof invocations {
    return Object.hasOwn(invocations, name);
}
