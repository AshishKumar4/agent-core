import { AgentCoreError } from "@agent-core/core";
import {
    DurableObjectFacetHost,
    DynamicDomainName,
    type DurableObjectFacetsLike,
    type DynamicDomainStartup
} from "../src/index.js";
import { malformedInput } from "./assertions.js";
import { fakeErrors } from "./fakes.js";

/** The supervisor-side handle a startup record must not be able to carry across. */
interface SupervisorStorage {
    sql(): readonly string[];
}

interface LeakingStartup {
    readonly class: LoadedClass;
    readonly id: string;
    readonly storage: SupervisorStorage;
}

interface ClasslessStartup {
    readonly id: string;
}

/** A loaded Durable Object class, reduced to the version marker a test can observe. */
interface LoadedClass {
    readonly version: string;
}

interface FacetStub {
    readonly domain: string;
    readonly version: string;
}

/**
 * Models what the platform actually does with a facet's SQLite database across the two
 * lifecycle verbs: `abort` stops the child and keeps the database, `delete` stops it and
 * destroys it, and `get` re-invokes the startup callback only when no child is running.
 * The `stores` map is the durable side, so a test can ask whether the store outlived the
 * act rather than assert which method was called.
 */
class FakeDurableObjectFacets implements DurableObjectFacetsLike<FacetStub, LoadedClass> {
    public readonly stores = new Map<string, readonly string[]>();
    public readonly startups: Array<DynamicDomainStartup<LoadedClass>> = [];
    readonly #running = new Map<string, LoadedClass>();
    #pending: Promise<void> = Promise.resolve();

    public get(
        name: string,
        startup: () => DynamicDomainStartup<LoadedClass> | Promise<DynamicDomainStartup<LoadedClass>>
    ): FacetStub {
        const live = this.#running.get(name);
        if (live !== undefined) return { domain: name, version: live.version };
        // The platform resolves the callback before the child serves anything; the test
        // awaits `settled` at the point it needs the started state to be observable.
        const resolved = Promise.resolve(startup());
        this.#pending = this.#pending.then(async () => {
            const options = await resolved;
            this.startups.push(options);
            this.#running.set(name, options.class);
            if (!this.stores.has(name)) this.stores.set(name, []);
            this.stores.set(name, [...this.stores.get(name)!, options.class.version]);
        });
        return { domain: name, version: "starting" };
    }

    public abort(name: string, reason: AgentCoreError): void {
        void reason;
        this.#running.delete(name);
    }

    public delete(name: string): void {
        this.#running.delete(name);
        this.stores.delete(name);
    }

    public async settled(): Promise<void> {
        await this.#pending;
    }
}

const domain = new DynamicDomainName("slate-backend");

describe("Cloudflare dynamic-domain facet hosting", () => {
    test(
        "[C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY] starts a domain with its class and nothing " +
            "the supervisor could be read back through",
        { tags: "p0" },
        async () => {
            const facets = new FakeDurableObjectFacets();
            const host = new DurableObjectFacetHost(facets, fakeErrors);
            const supervisorStorage = { sql: () => ["billing", "quotas"] };

            host.open(
                domain,
                // A startup record assembled elsewhere is the one place a supervisor's own
                // handle could reach a child the supervisor is not allowed to read back from.
                () =>
                    malformedInput<DynamicDomainStartup<LoadedClass>, LeakingStartup>({
                        class: { version: "v1" },
                        id: "slate-1",
                        storage: supervisorStorage
                    })
            );
            await facets.settled();

            expect(Object.keys(facets.startups[0]!).sort()).toEqual(["class", "id"]);
            expect(facets.startups[0]).toEqual({ class: { version: "v1" }, id: "slate-1" });
        }
    );

    test(
        "[C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY] offers the hosting Actor no reader of a " +
            "domain's own store",
        { tags: "p0" },
        () => {
            // The rule is a property of the surface, not of a call: a record the hosting
            // Actor cannot read is one it cannot reconcile, export, or repair, so the seam
            // has to have no read path at all rather than an unused one.
            expect(
                Object.getOwnPropertyNames(DurableObjectFacetHost.prototype).sort()
            ).toEqual(["constructor", "open", "retire", "suspend"]);
        }
    );

    test(
        "[C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY] refuses a startup that names no loaded class",
        { tags: "p1" },
        async () => {
            const facets = new FakeDurableObjectFacets();
            const host = new DurableObjectFacetHost(facets, fakeErrors);

            host.open(domain, () =>
                malformedInput<DynamicDomainStartup<LoadedClass>, ClasslessStartup>({
                    id: "slate-1"
                })
            );

            await expect(facets.settled()).rejects.toMatchObject({
                code: "operation.invalid-input"
            });
            expect(facets.stores.has(domain.value)).toBe(false);
        }
    );

    test(
        "[C13-CLOUDFLARE-DYNAMIC-STORE-LIFECYCLE] suspending keeps a domain's store, so " +
            "re-opening it under a new class is a code update",
        { tags: "p0" },
        async () => {
            const facets = new FakeDurableObjectFacets();
            const host = new DurableObjectFacetHost(facets, fakeErrors);

            host.open(domain, () => ({ class: { version: "v1" } }));
            await facets.settled();
            host.suspend(
                domain,
                new AgentCoreError("protocol.invalid-state", "domain code updated")
            );
            host.open(domain, () => ({ class: { version: "v2" } }));
            await facets.settled();

            // Same store, second class: the durable state the old code wrote is what the
            // new code inherits, which is what makes this an update rather than a reset.
            expect(facets.stores.get(domain.value)).toEqual(["v1", "v2"]);
            expect(facets.startups.map((options) => options.class.version)).toEqual(["v1", "v2"]);
        }
    );

    test(
        "[C13-CLOUDFLARE-DYNAMIC-STORE-LIFECYCLE] retiring a domain releases its store " +
            "rather than leaving it durable and unreachable",
        { tags: "p0" },
        async () => {
            const facets = new FakeDurableObjectFacets();
            const host = new DurableObjectFacetHost(facets, fakeErrors);

            host.open(domain, () => ({ class: { version: "v1" } }));
            await facets.settled();
            host.retire(domain);

            expect(facets.stores.has(domain.value)).toBe(false);

            host.open(domain, () => ({ class: { version: "v1" } }));
            await facets.settled();
            expect(facets.stores.get(domain.value)).toEqual(["v1"]);
        }
    );

    test(
        "[C13-CLOUDFLARE-DYNAMIC-STORE-LIFECYCLE] reuses a live domain without loading again",
        { tags: "p1" },
        async () => {
            const facets = new FakeDurableObjectFacets();
            const host = new DurableObjectFacetHost(facets, fakeErrors);

            host.open(domain, () => ({ class: { version: "v1" } }));
            await facets.settled();
            const reused = host.open(domain, () => ({ class: { version: "v2" } }));

            expect(reused.version).toBe("v1");
            expect(facets.startups).toHaveLength(1);
        }
    );

    test("refuses a domain name no identity admits", { tags: "p2" }, () => {
        expect(() => new DynamicDomainName("")).toThrow(TypeError);
    });
});
