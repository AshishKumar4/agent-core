import { AgentCoreError } from "@agent-core/core";
import {
    cloudflareRuntimeMigrations,
    createCloudflareDurableObjectClass,
    type AuthoritativeDurableObjectHost,
    type CloudflareDurableObjectAlarmStorage,
    type CloudflareDurableObjectClass,
    type CloudflareDurableObjectRuntime,
    type SqliteApplicationMigration
} from "../src/index.js";
import { FakeWebSocket, fakeErrors } from "./fakes.js";
import { NodeDurableObjectStorage } from "./node-sqlite.js";

type Environment = Record<string, never>;

const CHANNEL = "continuity";
const ARMED_AT = 1_700_000_000_000;
const request = new Request("https://object/work");

/** The schema release N+1 applies, which release N does not declare. */
const releaseNextMigration: SqliteApplicationMigration = Object.freeze({
    version: cloudflareRuntimeMigrations.length + 1,
    name: "release-next-projection",
    statements: Object.freeze(["CREATE TABLE release_next_projection (id INTEGER) STRICT"])
});

/** The schema a second release beyond N applies, for a two-release rollback. */
const releaseAfterNextMigration: SqliteApplicationMigration = Object.freeze({
    version: cloudflareRuntimeMigrations.length + 2,
    name: "release-after-next-projection",
    statements: Object.freeze(["CREATE TABLE release_after_next_projection (id INTEGER) STRICT"])
});

/** The exact refusal release N raises for the marker release N+1 left behind. */
const UNDECLARED_MARKER = `SQLite migration ${releaseNextMigration.version} marker ${releaseNextMigration.name} is not declared by this runtime`;

/**
 * The platform's storage and its single alarm outlive every deployment of the code above
 * them, so one substrate serves every release in a scenario.
 */
class DurableSubstrate
    extends NodeDurableObjectStorage
    implements CloudflareDurableObjectAlarmStorage
{
    #armedAt: number | null = null;

    public async getAlarm(): Promise<number | null> {
        return this.#armedAt;
    }

    public async setAlarm(scheduledTime: number): Promise<void> {
        this.#armedAt = scheduledTime;
    }

    public async deleteAlarm(): Promise<void> {
        this.#armedAt = null;
    }
}

/** Durable work a release both arms and resumes: one alarm claim and one view revision. */
class ContinuityHost implements AuthoritativeDurableObjectHost {
    public constructor(private readonly runtime: CloudflareDurableObjectRuntime<Environment>) {}

    public async repairAlarm(): Promise<void> {
        await this.runtime.alarms.setAlarm(ARMED_AT);
    }

    public fetch(): Response {
        const revision = this.runtime.revisions.currentRevision(CHANNEL) + 1;
        this.runtime.revisions.append(CHANNEL, revision, new Uint8Array([revision]));
        return new Response(String(revision));
    }

    public alarm(): void {}

    public webSocketMessage(): void {}

    public webSocketClose(): void {}

    public webSocketError(): void {}
}

function release(
    migrations: readonly SqliteApplicationMigration[]
): CloudflareDurableObjectClass<Environment> {
    return createCloudflareDurableObjectClass<Environment>({
        errors: fakeErrors,
        migrations,
        host: { create: (runtime) => new ContinuityHost(runtime) }
    });
}

/** One platform substrate and the object state above it, shared by every release below. */
function substrate() {
    const storage = new DurableSubstrate();
    return {
        storage,
        state: {
            storage,
            blockConcurrencyWhile: async <Result>(callback: () => Promise<Result>) => callback(),
            acceptWebSocket(): void {}
        }
    };
}

describe("Cloudflare release rollback", () => {
    test(
        "[C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY] keeps durable work across N to N+1 and back to N",
        { tags: "p0" },
        async () => {
            const { storage, state } = substrate();
            const ReleaseN = release([]);
            const ReleaseNext = release([releaseNextMigration]);

            expect(await (await new ReleaseN(state, {}).fetch(request)).text()).toBe("1");
            expect(await storage.getAlarm()).toBe(ARMED_AT);
            expect(await (await new ReleaseNext(state, {}).fetch(request)).text()).toBe("2");

            // The rollback: release N meets a marker it never declared. Construction is
            // what an operator needs in order to reach the object at all, so it succeeds,
            // and the refusal lands on every operation with its own typed reason.
            const rolledBack = new ReleaseN(state, {});
            let refusal: unknown;
            try {
                await rolledBack.fetch(request);
            } catch (failure) {
                refusal = failure;
            }
            expect(refusal).toBeInstanceOf(AgentCoreError);
            expect(refusal).toMatchObject({
                code: "schema.unreadable",
                message: UNDECLARED_MARKER
            });
            await expect(rolledBack.alarm()).rejects.toMatchObject({ code: "schema.unreadable" });
            await expect(
                rolledBack.webSocketMessage(new FakeWebSocket(), "message")
            ).rejects.toMatchObject({ code: "schema.unreadable" });
            await expect(
                rolledBack.webSocketClose(new FakeWebSocket(), 1000, "done", true)
            ).rejects.toMatchObject({ code: "schema.unreadable" });
            await expect(
                rolledBack.webSocketError(new FakeWebSocket(), new TypeError("socket"))
            ).rejects.toMatchObject({ code: "schema.unreadable" });

            // Refusing left the durable work exactly as release N+1 had it, so rolling
            // forward again resumes rather than restarts: recovery needs no repair step.
            expect(await storage.getAlarm()).toBe(ARMED_AT);
            expect(await (await new ReleaseNext(state, {}).fetch(request)).text()).toBe("3");
        }
    );

    test(
        "[C13-CLOUDFLARE-ROLLBACK-WINDOW] refuses a two-release rollback the same way and recovers by rolling forward",
        { tags: "p0" },
        async () => {
            const { storage, state } = substrate();
            const ReleaseN = release([]);
            const ReleaseAfterNext = release([releaseNextMigration, releaseAfterNextMigration]);

            expect(await (await new ReleaseAfterNext(state, {}).fetch(request)).text()).toBe("1");

            const rolledBack = new ReleaseN(state, {});
            await expect(rolledBack.fetch(request)).rejects.toMatchObject({
                code: "schema.unreadable",
                message: UNDECLARED_MARKER
            });

            expect(await storage.getAlarm()).toBe(ARMED_AT);
            expect(await (await new ReleaseAfterNext(state, {}).fetch(request)).text()).toBe("2");
        }
    );

    test("[C13-CLOUDFLARE-ROLLBACK-WINDOW] admits a release that declares every applied marker", async () => {
        const { state } = substrate();
        const ReleaseNext = release([releaseNextMigration]);

        expect(await (await new ReleaseNext(state, {}).fetch(request)).text()).toBe("1");
        // A second deployment of the same release declares the markers it finds, so it
        // serves; only an undeclared marker refuses.
        expect(await (await new ReleaseNext(state, {}).fetch(request)).text()).toBe("2");
    });
});
