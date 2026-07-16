// @ts-nocheck
import { describe, expect, test } from "vitest";
import { AgentId, AgentProfileId } from "../../src/agents";
import { GrantId } from "../../src/authority";
import { EnvironmentId, EnvironmentSessionId, ProviderId } from "../../src/environments";
import { ProtectionDomain, TaskId } from "../../src/facets";
import { EventId, SubscriptionId, WorkspaceId } from "../../src/workspaces";

describe("retained context values", () => {
    test("keeps context identifiers nominally distinct", () => {
        const ids = [
            new AgentId("agent"),
            new AgentProfileId("profile"),
            new GrantId("grant"),
            new EnvironmentId("environment"),
            new EnvironmentSessionId("session"),
            new ProviderId("provider"),
            new EventId("event"),
            new SubscriptionId("subscription"),
            new TaskId("task"),
            new WorkspaceId("workspace")
        ];

        expect(ids.map((id) => id.value)).toEqual([
            "agent",
            "profile",
            "grant",
            "environment",
            "session",
            "provider",
            "event",
            "subscription",
            "task",
            "workspace"
        ]);
        expect(
            ids.every((id, index) => ids.findIndex((candidate) => candidate.equals(id)) === index)
        ).toBe(true);
    });

    test("enforces protection-domain invariants", () => {
        const backend = new ProtectionDomain("backend", "control", "may-hold-secrets");

        expect(backend.canHoldSecrets).toBe(true);
        expect(backend.equals(new ProtectionDomain("backend", "control", "may-hold-secrets"))).toBe(
            true
        );
        expect(backend.equals(new ProtectionDomain("backend", "other", "no-secrets"))).toBe(false);
        expect(() => new ProtectionDomain("frontend", "ui", "may-hold-secrets")).toThrow(
            "Frontend protection domains cannot hold secrets"
        );
        expect(() => new ProtectionDomain("backend", "", "no-secrets")).toThrow(
            "Protection domain label"
        );
        expect(() => new ProtectionDomain("backend", "x".repeat(129), "no-secrets")).toThrow(
            "Protection domain label"
        );
    });
});
