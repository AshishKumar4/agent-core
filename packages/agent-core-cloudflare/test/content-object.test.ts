import { R2ContentObjectRepository, contentObjectAddress } from "../src/index.js";
import { AgentCoreError, TenantId } from "@agent-core/core";
import { FakeR2Bucket, fakeErrors } from "./fakes.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("R2ContentObjectRepository", () => {
    test("uses deterministic tenant-scoped SHA-256 keys and conditional dedupe", async () => {
        const bucket = new FakeR2Bucket();
        const repository = new R2ContentObjectRepository(bucket, fakeErrors);

        const first = await repository.put(new TenantId("tenant/a"), bytes("content"));
        const duplicate = await repository.put(new TenantId("tenant/a"), bytes("content"));
        const otherTenant = await repository.put(new TenantId("tenant:b"), bytes("content"));

        expect(first.created).toBe(true);
        expect(duplicate.created).toBe(false);
        expect(duplicate.key).toBe(first.key);
        expect(otherTenant.digest).toBe(first.digest);
        expect(otherTenant.key).not.toBe(first.key);
        expect(first.key).toMatch(
            /^agent-core-content\/v1\/tenant-sha256\/[a-f0-9]{64}\/sha256\/[a-f0-9]{64}$/
        );
        expect(bucket.putCalls.every((call) => call.options.onlyIf.etagDoesNotMatch === "*")).toBe(
            true
        );
        expect(Object.keys(bucket.putCalls[0]?.options.customMetadata ?? {}).sort()).toEqual([
            "agent-core-body-sha256",
            "agent-core-format",
            "agent-core-tenant-sha256"
        ]);
    });

    test("detaches caller, result, and read bytes", async () => {
        const bucket = new FakeR2Bucket();
        const repository = new R2ContentObjectRepository(bucket, fakeErrors);
        const input = bytes("stable");
        const tenant = new TenantId("tenant");
        const pending = repository.put(tenant, input);
        input.fill(0);
        const stored = await pending;
        expect(new TextDecoder().decode(stored.bytes)).toBe("stable");

        stored.bytes.fill(1);
        const firstRead = await repository.get(tenant, stored.digest);
        expect(new TextDecoder().decode(firstRead?.bytes)).toBe("stable");
        firstRead?.bytes.fill(2);
        expect(new TextDecoder().decode((await repository.get(tenant, stored.digest))?.bytes)).toBe(
            "stable"
        );
    });

    test("rejects body, metadata, and checksum corruption", async () => {
        const corrupt = async (
            mutate: (bucket: FakeR2Bucket, key: string) => void
        ): Promise<void> => {
            const bucket = new FakeR2Bucket();
            const repository = new R2ContentObjectRepository(bucket, fakeErrors);
            const tenant = new TenantId("tenant");
            const stored = await repository.put(tenant, bytes("trusted"));
            mutate(bucket, stored.key);
            await expect(repository.get(tenant, stored.digest)).rejects.toMatchObject({
                code: "codec.invalid"
            });
        };

        await corrupt((bucket, key) => {
            bucket.corruptBody(key, bytes("altered"));
        });
        await corrupt((bucket, key) => {
            bucket.corruptMetadata(key, "agent-core-body-sha256", "0".repeat(64));
        });
        await corrupt((bucket, key) => {
            bucket.corruptChecksum(key, new Uint8Array(32).buffer);
        });
    });

    test("verifies an existing body after a conditional dedupe", async () => {
        const bucket = new FakeR2Bucket();
        const repository = new R2ContentObjectRepository(bucket, fakeErrors);
        const tenant = new TenantId("tenant");
        const stored = await repository.put(tenant, bytes("trusted"));
        bucket.corruptBody(stored.key, bytes("altered"));

        await expect(repository.put(tenant, bytes("trusted"))).rejects.toBeInstanceOf(
            AgentCoreError
        );
    });

    test("addresses Unicode tenant IDs exactly and validates lookups", async () => {
        const composed = await contentObjectAddress(
            new TenantId("caf\u00e9"),
            bytes("x"),
            fakeErrors
        );
        const decomposed = await contentObjectAddress(
            new TenantId("cafe\u0301"),
            bytes("x"),
            fakeErrors
        );
        expect(composed.key).not.toBe(decomposed.key);

        const repository = new R2ContentObjectRepository(new FakeR2Bucket(), fakeErrors);
        const tenant = new TenantId("tenant");
        expect(await repository.get(tenant, "a".repeat(64))).toBeUndefined();
        await expect(repository.get(tenant, "not-a-digest")).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
        await expect(repository.put("invalid" as never, bytes("x"))).rejects.toMatchObject({
            code: "operation.invalid-input"
        });
    });
});
