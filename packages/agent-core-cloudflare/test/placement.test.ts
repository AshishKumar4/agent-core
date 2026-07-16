import { AgentCoreError } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import {
    ActorPlacement,
    MemoryPlacementRegistry,
    PlacementResolver,
    UnimplementedPlacementMigration,
    actorObjectName
} from "../src/index.js";
import { FakeDurableObjectNamespace, fakeErrors } from "./fakes.js";

interface FakeStub {
    readonly name: string;
    readonly jurisdiction: string | undefined;
}

function fixture(): {
    readonly namespace: FakeDurableObjectNamespace<FakeStub>;
    readonly registry: MemoryPlacementRegistry;
    readonly resolver: PlacementResolver<unknown, FakeStub>;
    readonly actor: ActorRef;
} {
    const namespace = new FakeDurableObjectNamespace<FakeStub>((name, jurisdiction) => ({
        name,
        jurisdiction
    }));
    const registry = new MemoryPlacementRegistry();
    const resolver = new PlacementResolver<unknown, FakeStub>(registry, fakeErrors, {
        now: () => 1000
    });
    const actor = new ActorRef("workspace", new ActorId("42"));
    return { namespace, registry, resolver, actor };
}

describe("Actor placement pinning", () => {
    test("first resolution pins the jurisdiction and later resolutions read that pin", async () => {
        const { namespace, registry, resolver, actor } = fixture();

        const first = await resolver.resolve(namespace, actor, { namespaceJurisdiction: "eu" });
        const again = await resolver.resolve(namespace, actor, { namespaceJurisdiction: "eu" });
        const absent = await resolver.resolve(namespace, actor);

        expect(first.jurisdiction).toBe("eu");
        expect(again).toBe(first);
        expect(absent).toBe(first);
        const pin = await registry.get(actorObjectName({ kind: actor.kind, id: actor.id }));
        expect(pin?.jurisdiction).toBe("eu");
        expect(pin?.epoch).toBe(0);
        expect(pin?.pinnedAt).toBe(1000);
    });

    test("rejects a conflicting jurisdiction and never produces a second object", async () => {
        const { namespace, resolver, actor } = fixture();

        await resolver.resolve(namespace, actor, { namespaceJurisdiction: "eu" });
        const conflict = resolver.resolve(namespace, actor, { namespaceJurisdiction: "us" });

        await expect(conflict).rejects.toBeInstanceOf(AgentCoreError);
        await expect(conflict).rejects.toMatchObject({ code: "protocol.invalid-state" });
        // The conflicting jurisdiction was never selected on the namespace: no second object.
        expect(namespace.selectedJurisdictions).toEqual(["eu"]);
    });

    test("pins to the default namespace and rejects a later jurisdiction request", async () => {
        const { namespace, resolver, actor } = fixture();

        const defaultStub = await resolver.resolve(namespace, actor);
        expect(defaultStub.jurisdiction).toBeUndefined();

        const conflict = resolver.resolve(namespace, actor, { namespaceJurisdiction: "eu" });
        await expect(conflict).rejects.toMatchObject({ code: "protocol.invalid-state" });
        expect(namespace.selectedJurisdictions).toEqual([]);
    });

    test("registry round-trips a pin and re-pins the same jurisdiction idempotently", async () => {
        const registry = new MemoryPlacementRegistry();
        const name = actorObjectName({ kind: "run", id: new ActorId("7") });
        const placement = new ActorPlacement(name, "eu", 1000, 0);

        expect(await registry.get(name)).toBeUndefined();
        const pinned = await registry.pin(placement);
        expect(pinned).toBe(placement);
        expect(await registry.get(name)).toBe(placement);

        const rePin = await registry.pin(new ActorPlacement(name, "eu", 2000, 0));
        expect(rePin).toBe(placement);
        // A concurrent conflicting writer also observes the original pin, never a second one.
        const loser = await registry.pin(new ActorPlacement(name, "us", 3000, 0));
        expect(loser).toBe(placement);
    });

    test("ActorPlacement validates its shape", () => {
        const name = actorObjectName({ kind: "run", id: new ActorId("7") });
        expect(() => new ActorPlacement("not-a-name", "eu", 0, 0)).toThrow(TypeError);
        expect(() => new ActorPlacement(name, "", 0, 0)).toThrow(TypeError);
        expect(() => new ActorPlacement(name, "eu", -1, 0)).toThrow(TypeError);
        expect(() => new ActorPlacement(name, "eu", 0, -1)).toThrow(TypeError);
        expect(new ActorPlacement(name, undefined, 0, 0).jurisdiction).toBeUndefined();
        expect(new ActorPlacement(name, "eu", 0, 0).migratedTo("us", 5)).toMatchObject({
            jurisdiction: "us",
            epoch: 1,
            pinnedAt: 5
        });
    });

    test("fenced placement migration is a defined but unimplemented contract", async () => {
        const migration = new UnimplementedPlacementMigration(fakeErrors);
        const rejection = migration.migrate({
            actor: new ActorRef("run", new ActorId("7")),
            toJurisdiction: "us",
            sourceLeaseEpoch: 3
        });
        await expect(rejection).rejects.toBeInstanceOf(AgentCoreError);
        await expect(rejection).rejects.toThrow("not implemented");
    });
});
