// @ts-nocheck
import { readFile } from "node:fs/promises";
import {
    APPROVAL_GATEWAY_CONTRIBUTIONS,
    APPROVAL_GATEWAY_OPERATIONS,
    DEVICE_CONTRIBUTIONS,
    DEVICE_OPERATIONS,
    ENVIRONMENT_CONTRIBUTIONS,
    ENVIRONMENT_EVENTS,
    ENVIRONMENT_OPERATIONS,
    FILESYSTEM_CONTRIBUTIONS,
    FILESYSTEM_OPERATIONS,
    MCP_CONTRIBUTIONS,
    MCP_OPERATIONS,
    MEMORY_CONTRIBUTIONS,
    MEMORY_OPERATIONS,
    SELF_CONTRIBUTIONS,
    SELF_OPERATIONS,
    SHELL_CONTRIBUTIONS,
    SHELL_OPERATIONS,
    SINGLE_TENANT_CONTRIBUTIONS,
    SINGLE_TENANT_EVENTS,
    SINGLE_TENANT_OPERATIONS,
    SLATE_CONTRIBUTIONS,
    SLATE_OPERATIONS,
    TASK_CONTRIBUTIONS,
    TASK_OPERATIONS,
    WEB_CONTRIBUTIONS,
    WEB_OPERATIONS,
    Contributions,
    OperationDescriptor
} from "../../src/facets";
import { describe, expect, test } from "vitest";
import { validateCompleteOwnership } from "../../scripts/quality/ownership.mjs";

const profiles = [
    [FILESYSTEM_CONTRIBUTIONS, FILESYSTEM_OPERATIONS],
    [SHELL_CONTRIBUTIONS, SHELL_OPERATIONS],
    [MEMORY_CONTRIBUTIONS, MEMORY_OPERATIONS],
    [TASK_CONTRIBUTIONS, TASK_OPERATIONS],
    [WEB_CONTRIBUTIONS, WEB_OPERATIONS],
    [MCP_CONTRIBUTIONS, MCP_OPERATIONS],
    [APPROVAL_GATEWAY_CONTRIBUTIONS, APPROVAL_GATEWAY_OPERATIONS],
    [SELF_CONTRIBUTIONS, SELF_OPERATIONS],
    [ENVIRONMENT_CONTRIBUTIONS, ENVIRONMENT_OPERATIONS],
    [DEVICE_CONTRIBUTIONS, DEVICE_OPERATIONS],
    [SLATE_CONTRIBUTIONS, SLATE_OPERATIONS],
    [SINGLE_TENANT_CONTRIBUTIONS, SINGLE_TENANT_OPERATIONS]
] as const;

describe("Profile base conformance", () => {
    test("[C13-OWNERSHIP-MAP] covers every tracked path without depending on candidate worktree authorization", async () => {
        await expect(validateCompleteOwnership()).resolves.toBeGreaterThan(200);
    });

    test("[P11-BASE-COMPOSITION] composes every profile exclusively from standard contribution and Operation primitives", () => {
        for (const [contributions, operations] of profiles) {
            expect(contributions).toBeInstanceOf(Contributions);
            expect(operations.every((operation) => operation instanceof OperationDescriptor)).toBe(
                true
            );
            expect(
                contributions.entries.every((entry) => entry.constructor.name === "Contribution")
            ).toBe(true);
        }
    });

    test("[P11-BASE-CONTRACT] exposes closed executable Operation schemas and explicit empty Event contracts", () => {
        for (const [, operations] of profiles) {
            for (const operation of operations) {
                operation.input.assertValid();
                operation.output.assertValid();
            }
        }
        expect(ENVIRONMENT_EVENTS).toEqual([]);
        expect(SINGLE_TENANT_EVENTS).toEqual([]);
    });

    test("[P11-BASE-EVIDENCE] keeps implementation status out of executable profile contracts", () => {
        for (const [contributions, operations] of profiles) {
            for (const operation of operations) {
                const data = operation.toData() as Record<string, unknown>;
                expect(data).not.toHaveProperty("status");
                expect(data).not.toHaveProperty("implemented");
                expect(data).not.toHaveProperty("verified");
            }
            for (const contribution of contributions.entries) {
                expect(contribution.toData()).not.toHaveProperty("status");
            }
        }
    });

    test("[P11-BASE-TESTS] gives every verified profile atom unique executable evidence", async () => {
        const fragment = JSON.parse(
            await readFile(
                new URL("../../artifacts/conformance/profiles-cloudflare.json", import.meta.url),
                "utf8"
            )
        ) as {
            requirements: Array<{
                id: string;
                status: string;
                testSelectors: string[];
            }>;
        };
        const selectors = new Set<string>();
        for (const requirement of fragment.requirements) {
            if (!requirement.id.startsWith("P11-") || requirement.status !== "verified") continue;
            expect(requirement.testSelectors.length).toBeGreaterThan(0);
            for (const selector of requirement.testSelectors) {
                expect(selector).toContain(`[${requirement.id}]`);
                expect(selectors.has(selector)).toBe(false);
                selectors.add(selector);
            }
        }
    });
});
