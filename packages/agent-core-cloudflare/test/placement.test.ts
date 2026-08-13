import { AgentCoreError } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import {
    ActorPlacement,
    PlacementResolver,
    SqliteApplicationMigrator,
    SqlitePlacementRegistry,
    UnimplementedPlacementMigration,
    actorObjectName,
    cloudflareRuntimeMigrations,
    placementRegistryMigration
} from "../src/index.js";
import type { SynchronousResultGuard, SynchronousSqlitePort } from "../src/index.js";
import { FakeDurableObjectNamespace, fakeErrors } from "./fakes.js";
import { NodeSqlite } from "./node-sqlite.js";

interface FakeStub {
    readonly name: string;
    readonly jurisdiction: string | undefined;
}

const PLACEMENT_MIGRATION_VERSION = cloudflareRuntimeMigrations.length + 1;

/** A real database: the pin ledger's whole value is that it survives the isolate. */
function registryDatabase(): NodeSqlite {
    const database = new NodeSqlite();
    new SqliteApplicationMigrator(database, fakeErrors, [
        ...cloudflareRuntimeMigrations,
        placementRegistryMigration(PLACEMENT_MIGRATION_VERSION)
    ]).migrate();
    return database;
}

function fixture() {
    const namespace = new FakeDurableObjectNamespace<FakeStub>((name, jurisdiction) => ({
        name,
        jurisdiction
    }));
    const registry = new SqlitePlacementRegistry(registryDatabase(), fakeErrors);
    const resolver = new PlacementResolver<unknown, FakeStub>(registry, fakeErrors, {
        now: () => 1000
    });
    const actor = new ActorRef("workspace", new ActorId("42"));
    return { namespace, registry, resolver, actor };
}

describe("Actor placement jurisdiction encoding", () => {
    const name = actorObjectName({ kind: "run", id: new ActorId("unicode-probe") });

    test("accepts a jurisdiction containing well-formed surrogate pairs", () => {
        const placement = new ActorPlacement(name, "region-\u{1F1EA}\u{1F1FA}", 0, 0);
        expect(placement.jurisdiction).toBe("region-🇪🇺");
    });

    test.each([
        ["a lone high surrogate at the end", "eu\ud800"],
        ["a high surrogate followed by a non-low unit", "eu\ud800a"],
        ["a lone low surrogate", "eu\udc00"]
    ])("rejects %s: ill-formed Unicode never names a jurisdiction", (_case, jurisdiction) => {
        expect(() => new ActorPlacement(name, jurisdiction, 0, 0)).toThrow(
            "Actor placement jurisdiction must be non-empty well-formed Unicode"
        );
    });
});

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
        const registry = new SqlitePlacementRegistry(registryDatabase(), fakeErrors);
        const name = actorObjectName({ kind: "run", id: new ActorId("7") });
        const placement = new ActorPlacement(name, "eu", 1000, 0);

        expect(await registry.get(name)).toBeUndefined();
        expect(await registry.pin(placement)).toBe(placement);
        expect(await registry.get(name)).toEqual(placement);

        expect(await registry.pin(new ActorPlacement(name, "eu", 2000, 0))).toEqual(placement);
        // A concurrent conflicting writer also observes the original pin, never a second one.
        expect(await registry.pin(new ActorPlacement(name, "us", 3000, 0))).toEqual(placement);
    });

    test(
        "a pin outlives the isolate that installed it, so a later isolate cannot re-pin",
        { tags: "p0" },
        async () => {
            const database = registryDatabase();
            const name = actorObjectName({ kind: "run", id: new ActorId("7") });
            await new SqlitePlacementRegistry(database, fakeErrors).pin(
                new ActorPlacement(name, "eu", 1000, 0)
            );

            // A second isolate holds no pins of its own; it reads the durable ledger and
            // observes the first pin, instead of first-pinning the Actor somewhere else.
            const later = new SqlitePlacementRegistry(database, fakeErrors);
            expect(await later.get(name)).toEqual(new ActorPlacement(name, "eu", 1000, 0));
            expect(await later.pin(new ActorPlacement(name, "us", 2000, 0))).toEqual(
                new ActorPlacement(name, "eu", 1000, 0)
            );
        }
    );

    test("pins the default namespace durably and distinguishably", { tags: "p1" }, async () => {
        const database = registryDatabase();
        const name = actorObjectName({ kind: "run", id: new ActorId("7") });
        await new SqlitePlacementRegistry(database, fakeErrors).pin(
            new ActorPlacement(name, undefined, 1000, 0)
        );

        // The default namespace is a placement decision, not an absent pin.
        const pin = await new SqlitePlacementRegistry(database, fakeErrors).get(name);
        expect(pin?.jurisdiction).toBeUndefined();
        expect(pin?.pinnedAt).toBe(1000);
    });

    test("refuses to pin without its own installed ledger", { tags: "p1" }, async () => {
        const database = new NodeSqlite();
        new SqliteApplicationMigrator(database, fakeErrors, cloudflareRuntimeMigrations).migrate();
        const registry = new SqlitePlacementRegistry(database, fakeErrors);

        // An Actor object carries the runtime migrations only, so a registry constructed
        // there has no table and cannot keep a private pin.
        await expect(
            registry.pin(
                new ActorPlacement(
                    actorObjectName({ kind: "run", id: new ActorId("7") }),
                    "eu",
                    0,
                    0
                )
            )
        ).rejects.toThrow();
    });

    test("rejects a corrupt stored pin instead of resolving one", { tags: "p2" }, async () => {
        const name = actorObjectName({ kind: "run", id: new ActorId("7") });
        const database = registryDatabase();
        database.run(
            `INSERT INTO agent_core_actor_placements (actor_name, jurisdiction, pinned_at, epoch)
                VALUES (?, ?, ?, ?)`,
            [name, "", 0, 0]
        );
        await expect(
            new SqlitePlacementRegistry(database, fakeErrors).get(name)
        ).rejects.toMatchObject({ code: "codec.invalid" });

        const scripted: SynchronousSqlitePort = {
            all: () => [{ jurisdiction: new Uint8Array([1]), pinned_at: 0, epoch: 0 }],
            run: () => {},
            transaction: <Result>(
                operation: () => Result,
                ..._guard: SynchronousResultGuard<Result>
            ): Result => operation()
        };
        await expect(
            new SqlitePlacementRegistry(scripted, fakeErrors).get(name)
        ).rejects.toMatchObject({ code: "codec.invalid" });
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
