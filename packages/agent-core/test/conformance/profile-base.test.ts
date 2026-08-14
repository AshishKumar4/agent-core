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
import { objectsAt, readArtifact, stringAt, stringsAt } from "../quality/artifacts";

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
    test(
        "[C13-OWNERSHIP-MAP] covers every tracked path without depending on candidate worktree authorization",
        { tags: "p1" },
        async () => {
            await expect(validateCompleteOwnership()).resolves.toBeGreaterThan(200);
        }
    );

    test(
        "[P11-BASE-COMPOSITION] composes every profile exclusively from standard contribution and Operation primitives",
        { tags: "p1" },
        () => {
            for (const [contributions, operations] of profiles) {
                expect(contributions).toBeInstanceOf(Contributions);
                expect(
                    operations.every((operation) => operation instanceof OperationDescriptor)
                ).toBe(true);
                expect(
                    contributions.entries.every(
                        (entry) => entry.constructor.name === "Contribution"
                    )
                ).toBe(true);
            }
        }
    );

    test(
        "[P11-BASE-CONTRACT] exposes closed executable Operation schemas and explicit empty Event contracts",
        { tags: "p1" },
        () => {
            for (const [, operations] of profiles) {
                for (const operation of operations) {
                    operation.input.assertValid();
                    operation.output.assertValid();
                }
            }
            expect(ENVIRONMENT_EVENTS).toEqual([]);
            expect(SINGLE_TENANT_EVENTS).toEqual([]);
        }
    );

    test(
        "[P11-BASE-EVIDENCE] keeps implementation status out of executable profile contracts",
        { tags: "p1" },
        () => {
            for (const [contributions, operations] of profiles) {
                for (const operation of operations) {
                    const data = operation.toData();
                    expect(data).not.toHaveProperty("status");
                    expect(data).not.toHaveProperty("implemented");
                    expect(data).not.toHaveProperty("verified");
                }
                for (const contribution of contributions.entries) {
                    expect(contribution.toData()).not.toHaveProperty("status");
                }
            }
        }
    );

    test(
        "[P11-BASE-TESTS] gives every verified profile atom unique executable evidence",
        { tags: "p1" },
        async () => {
            const requirements = objectsAt(
                await readArtifact("artifacts/conformance/profiles-cloudflare.json"),
                "requirements"
            );
            const selectors = new Set<string>();
            for (const requirement of requirements) {
                const id = stringAt(requirement, "id");
                if (!id.startsWith("P11-") || stringAt(requirement, "status") !== "verified")
                    continue;
                const requirementSelectors = stringsAt(requirement, "testSelectors");
                expect(requirementSelectors.length).toBeGreaterThan(0);
                for (const selector of requirementSelectors) {
                    expect(selector).toContain(`[${id}]`);
                    expect(selectors.has(selector)).toBe(false);
                    selectors.add(selector);
                }
            }
        }
    );
});
