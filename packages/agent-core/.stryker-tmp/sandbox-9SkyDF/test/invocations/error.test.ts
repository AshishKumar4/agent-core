// @ts-nocheck
import { describe, expect, test } from "vitest";
import { ActorId, ActorRef } from "../../src/actors";
import { TenantId } from "../../src/identity";
import {
    AuditRecord,
    AuditRecordId,
    CorrelationId,
    InvocationError,
    MemoryInvocationPersistence,
    WriteRecordId,
    createInvocationMemoryState,
    validateAuditAppend
} from "../../src/invocations";
import { invocationCodecs, prepared } from "./fixture";

describe("invocation operational error taxonomy", () => {
    test("[C13-ADV-STALE-RECOVERY-OWNER] uses AgentCoreError for append conflicts and missing persisted evidence", () => {
        const state = createInvocationMemoryState();
        const persistence = new MemoryInvocationPersistence(invocationCodecs);
        const invocation = prepared("duplicate-error");
        persistence.insertPrepared(state, invocation);
        expectFailure(
            () => persistence.insertPrepared(state, invocation),
            "store.duplicate-record"
        );

        const audit = new AuditRecord({
            id: new AuditRecordId("missing-cause-audit"),
            actor: new ActorRef("run", new ActorId("error-actor")),
            tenant: new TenantId("error-tenant"),
            correlation: new CorrelationId("error-correlation"),
            cause: new AuditRecordId("missing-cause"),
            kind: {
                kind: "write",
                id: new WriteRecordId("missing-cause-write"),
                outcome: "committed"
            }
        });
        expectFailure(
            () => validateAuditAppend(audit, { get: () => undefined }),
            "audit.missing-cause"
        );
    });
});

function expectFailure(operation: () => unknown, failure: InvocationError["failure"]): void {
    try {
        operation();
        throw new TypeError("Expected InvocationError");
    } catch (error) {
        expect(error).toBeInstanceOf(InvocationError);
        expect((error as InvocationError).code).toBe("invocation.invalid");
        expect((error as InvocationError).failure).toBe(failure);
    }
}
