import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AgentCoreError, ByteRange, MediaHint, TenantId } from "@agent-core/core";
import {
    R2ContentObjectRepository,
    R2ContentStore,
    contentStoreFromR2Binding,
    type CloudflareErrorPort
} from "../../src/index.js";
import { contentStoreContract } from "../content-store-contract.js";

const errors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

// One deployment has one bucket, so the contract's independent stores are separate
// Tenants inside it rather than separate buckets.
let contractTenant = 0;

contentStoreContract("workerd R2", async () => {
    contractTenant += 1;
    return contentStoreFromR2Binding(
        env,
        (bindings) => bindings.CONTENT,
        new TenantId(`workerd-content-contract-${contractTenant}`),
        errors
    );
});

// The other substrate's half of this contract runs in the structural suite, over
// CloudflareSqlite on real SQLite: a Durable Object's SQL storage is reachable only inside
// that object's own I/O context, so a store built in the test isolate is refused its first
// statement and no `test()` body here can hold one.

describe("R2 content resolution on workerd", () => {
    it(
        "[C13-CONTENT-RESOLUTION] answers a window from the platform's own ranged read",
        { tags: "p1" },
        async () => {
            const store = contentStoreFromR2Binding(
                env,
                (bindings) => bindings.CONTENT,
                new TenantId("workerd-window"),
                errors
            );
            const stored = await store.put(bytes("abcdefghij"), new MediaHint("text/plain"));

            expect(await store.get(stored.ref, ByteRange.slice(3, 4))).toEqual(bytes("defg"));
            expect(await store.get(stored.ref, ByteRange.from(7))).toEqual(bytes("hij"));
            await expect(store.stat(stored.ref)).resolves.toMatchObject({
                size: 10,
                hint: { mediaType: "text/plain" }
            });
        }
    );

    it(
        "[C13-CONTENT-RESOLUTION] refuses the windows the platform clamps and the ones it rejects opaquely",
        { tags: "p0" },
        async () => {
            const tenant = new TenantId("workerd-clamping");
            const repository = new R2ContentObjectRepository(env.CONTENT, errors);
            const store = new R2ContentStore(repository, tenant, errors);
            const stored = await store.put(bytes("abcdef"));
            const key =
                (await repository.head(tenant, stored.digest.value))?.key ??
                (() => {
                    throw new TypeError("Expected a stored content object");
                })();

            // What the platform does with the same three windows, measured rather than
            // assumed. An over-long window is clamped silently: the object reports its
            // full size and the served range is shorter than the one requested.
            const clamped = await env.CONTENT.get(key, { range: { offset: 4, length: 10 } });
            expect(new TextDecoder().decode(await clamped?.arrayBuffer())).toBe("ef");
            expect(clamped?.size).toBe(6);
            expect(clamped?.range).toEqual({ offset: 4, length: 2 });

            // An offset past the object and an empty window at its end are both refused,
            // with a platform error carrying no code from this repository's taxonomy.
            for (const range of [
                { offset: 10, length: 1 },
                { offset: 6, length: 0 }
            ]) {
                const rejection = env.CONTENT.get(key, { range });
                await expect(rejection).rejects.not.toBeInstanceOf(AgentCoreError);
                await expect(rejection).rejects.toMatchObject({
                    message: expect.stringContaining("not satisfiable")
                });
            }

            // The seam answers all three definitively over the same object: the two
            // out-of-bounds windows refuse with the range code the memory and SQLite
            // stores use, and the empty window inside the object resolves to no bytes
            // rather than to the platform's rejection.
            await expect(store.get(stored.ref, ByteRange.slice(4, 10))).rejects.toMatchObject({
                code: "content.invalid-range"
            });
            await expect(store.get(stored.ref, ByteRange.slice(10, 1))).rejects.toMatchObject({
                code: "content.invalid-range"
            });
            expect(await store.get(stored.ref, ByteRange.slice(6, 0))).toEqual(new Uint8Array());
        }
    );

    it(
        "[C13-CONTENT-RESOLUTION] verifies a window against the checksum the platform stored for it",
        { tags: "p1" },
        async () => {
            const tenant = new TenantId("workerd-checksum");
            const repository = new R2ContentObjectRepository(env.CONTENT, errors);
            const stored = await repository.put(tenant, bytes("checksummed"));
            const object = await env.CONTENT.head(stored.key);
            if (object === null) throw new TypeError("Expected a stored content object");

            // The write hands R2 the SHA-256 it computed for the address, so R2 stores and
            // reports that digest for itself. It is the only thing a proper window can be
            // checked against, and this is where the platform is asked whether it has it.
            expect(object.checksums.toJSON().sha256).toBe(stored.digest);
            expect(object.customMetadata).toMatchObject({
                "agent-core-format": "1",
                "agent-core-body-sha256": stored.digest
            });
            const store = new R2ContentStore(repository, tenant, errors);
            const ref = (await store.put(bytes("checksummed"))).ref;
            expect(await store.get(ref, ByteRange.slice(0, 5))).toEqual(bytes("check"));

            // The platform enforces the digest a write declares, so bytes that disagree
            // with their address cannot be stored through this path at all.
            await expect(
                env.CONTENT.put(stored.key, bytes("tampered!!!"), { sha256: stored.digest })
            ).rejects.toMatchObject({ message: expect.stringContaining("did not match") });

            // Written around that check — same address metadata, no declared checksum — the
            // object no longer carries a SHA-256 agreeing with its address, and the seam
            // refuses it for a whole read and for a window alike rather than serving bytes
            // it cannot tie to the reference it was asked for.
            await env.CONTENT.put(stored.key, bytes("tampered!!"), {
                customMetadata: object.customMetadata ?? {}
            });
            await expect(store.get(ref)).rejects.toMatchObject({ code: "codec.invalid" });
            await expect(store.get(ref, ByteRange.slice(0, 5))).rejects.toMatchObject({
                code: "codec.invalid"
            });
        }
    );
});
