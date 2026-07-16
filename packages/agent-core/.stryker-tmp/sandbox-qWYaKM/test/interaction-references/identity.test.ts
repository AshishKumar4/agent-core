// @ts-nocheck
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
    test("re-exports one frozen constructor through W6 and W7 barrels", () => {
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

    test("keeps W2 WorkspaceId and W6 ReceiptId distinct", () => {
        expect(WorkspaceId).toBe(IdentityWorkspaceId);
        for (const [name, Type] of Object.entries(invocationReferences)) {
            expect(invocations[name as keyof typeof invocations]).toBe(Type);
            expect(Object.isFrozen(new Type("canonical-id"))).toBe(true);
        }
        expect(new WorkspaceId("same").equals(new IdentityWorkspaceId("same"))).toBe(true);
        expect(new interaction.InvocationId("same").equals(new ReceiptId("same"))).toBe(false);
    });
});
