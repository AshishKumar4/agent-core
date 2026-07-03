import { describe, expect, test } from "vitest";
import { AgentCoreError } from "../../src/errors";
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
import { FacetSet } from "../../src/facets";
import { TenantId } from "../../src/identity";
import { ContentRef, Revision } from "../../src/record";
import { WorkspaceId } from "../../src/workspaces";

const environmentId = new EnvironmentId("environment-dev");
const otherEnvironmentId = new EnvironmentId("environment-other");
const workspaceId = new WorkspaceId("workspace-environment");
const tenantId = new TenantId("tenant-environment");
const provider = new ProviderDescriptor(
    new ProviderId("provider-local"),
    "1",
    new ContentRef("content:provider-local")
);

class TestEnvironmentSession extends EnvironmentSession {
    public constructor(id = new EnvironmentSessionId("session-environment-dev")) {
        super(id, environmentId);
    }

    protected createFacets(): FacetSet {
        return FacetSet.empty();
    }
}

class TestEnvironmentProvider implements EnvironmentProvider {
    public readonly opened: EnvironmentId[] = [];

    public constructor(public readonly descriptor: ProviderDescriptor) {
    }

    public openSession(environment: Environment): Promise<EnvironmentSession> {
        this.opened.push(environment.id);
        return Promise.resolve(new TestEnvironmentSession());
    }
}

function environment(revision = Revision.initial()): Environment {
    return new Environment(
        environmentId,
        workspaceId,
        tenantId,
        "active",
        provider,
        revision
    );
}

function runtime(providerInstance = new TestEnvironmentProvider(provider)): EnvironmentRuntime {
    return new EnvironmentRuntime(
        environment(),
        new MemoryEnvironmentProviderRegistry([providerInstance])
    );
}

describe("EnvironmentRuntime", () => {
    test("opens sessions for the environment", async () => {
        const providerInstance = new TestEnvironmentProvider(provider);
        const env = runtime(providerInstance);

        const session = await env.openSession();

        expect(session.environmentId.equals(environmentId)).toBe(true);
        expect(providerInstance.opened.map(id => id.value)).toEqual(["environment-dev"]);
        expect(session.use(env.pin()).facets).toEqual([]);
    });

    test("rotation advances environment revision without invalidating existing sessions", async () => {
        const env = runtime();
        const pin = env.pin();
        const session = await env.openSession(pin);

        const rotated = env.rotate();

        expect(rotated.revision.value).toBe(1);
        expect(session.use(pin).facets).toEqual([]);
        expect((await env.openSession()).environmentId.equals(environmentId)).toBe(true);
    });

    test("rejects wrong-environment and closed sessions", async () => {
        const env = runtime();
        const session = await env.openSession();

        expect(() => session.use({ environmentId: otherEnvironmentId }))
            .toThrow(new AgentCoreError("environment.stale-session", "Environment session does not match the requested Environment"));

        await session.close();
        expect(() => session.use({ environmentId }))
            .toThrow(new AgentCoreError("environment.closed-session", "Environment session is closed"));
    });
});
