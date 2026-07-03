import { describe, expect, test } from "vitest";
import {
    AgentId,
    BindingSet,
    EnvironmentPin,
    RunCreationRequest,
    RunEnvironmentResolver,
    RunId
} from "../../src/agents";
import {
    AuthoritySummary,
    BindingName,
    Facet,
    FacetContext,
    FacetDescription,
    FacetId,
    FacetSet,
    FacetVersion
} from "../../src/facets";
import {
    Environment,
    EnvironmentId,
    EnvironmentRuntime,
    EnvironmentSession,
    EnvironmentSessionId,
    MemoryEnvironmentProviderRegistry,
    ProviderDescriptor,
    ProviderId,
    type EnvironmentProvider
} from "../../src/environments";
import { NoopTelemetry } from "../../src/observability";
import { TenantId } from "../../src/identity";
import { ContentRef, Revision } from "../../src/record";
import { WorkspaceId } from "../../src/workspaces";
import { testOperationContext } from "../helpers/context";

const environmentId = new EnvironmentId("environment-run");
const workspaceId = new WorkspaceId("workspace-run-environment");
const tenantId = new TenantId("tenant-run-environment");
const provider = new ProviderDescriptor(
    new ProviderId("provider-run"),
    "1",
    new ContentRef("content:provider-run")
);
const environmentBinding = new BindingName("env.dev.fs");

class EnvironmentFacet extends Facet {
    public constructor() {
        super(new FacetContext(
            new FacetId("facet-environment-run"),
            environmentBinding,
            testOperationContext("environment-run", environmentBinding),
            new NoopTelemetry()
        ));
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Environment filesystem",
            "Environment-scoped filesystem facet.",
            new FacetVersion("1"),
            AuthoritySummary.scoped("Accesses an environment filesystem")
        );
    }
}

class EnvironmentSessionWithFacet extends EnvironmentSession {
    public constructor() {
        super(new EnvironmentSessionId("session-environment-run"), environmentId);
    }

    protected createFacets(): FacetSet {
        return FacetSet.of([new EnvironmentFacet()]);
    }
}

class EnvironmentProviderWithFacet implements EnvironmentProvider {
    public constructor(public readonly descriptor: ProviderDescriptor) {
    }

    public openSession(_environment: Environment): Promise<EnvironmentSession> {
        return Promise.resolve(new EnvironmentSessionWithFacet());
    }
}

function environmentRuntime(): EnvironmentRuntime {
    return new EnvironmentRuntime(
        new Environment(
            environmentId,
            workspaceId,
            tenantId,
            "active",
            provider,
            Revision.initial()
        ),
        new MemoryEnvironmentProviderRegistry([new EnvironmentProviderWithFacet(provider)])
    );
}

function runWithEnvironmentPin() {
    return new RunCreationRequest({
        id: new RunId("run-environment"),
        inputRef: new ContentRef("content:run-input"),
        environmentPin: new EnvironmentPin(environmentId)
    }).create(
        workspaceId,
        tenantId,
        new AgentId("agent-environment"),
        undefined,
        undefined,
        Revision.initial()
    );
}

describe("RunEnvironmentResolver", () => {
    test("merges environment session Facets and preserves environment pin across rotation", async () => {
        const runtime = environmentRuntime();
        const resolver = new RunEnvironmentResolver([runtime]);
        const run = runWithEnvironmentPin();

        const beforeRotation = await resolver.resolve(run, BindingSet.empty());
        runtime.rotate();
        const afterRotation = await resolver.resolve(run, BindingSet.empty());

        expect(beforeRotation.bindings.resolve(environmentBinding)?.id.value).toBe("facet-environment-run");
        expect(afterRotation.bindings.resolve(environmentBinding)?.id.value).toBe("facet-environment-run");
        expect(runtime.pin().environmentId.equals(environmentId)).toBe(true);
    });
});
