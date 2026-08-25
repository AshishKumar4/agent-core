/**
 * Measured on workerd 1.20260708.1: an `AgentCoreError` thrown inside a Durable Object and
 * propagated over RPC reaches the caller without its class, so `instanceof` proves nothing
 * across the boundary and only the message survives. Every cross-object refusal here is
 * therefore asserted on the exact reason core raised, which discriminates more sharply than
 * a shared error code would.
 */
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE_PERMIT_SPEC, buildTargetRequest, type PermitSpec } from "./permit-fixture.js";
import type { TargetMediationDurableObject, TenantAuthorityDurableObject } from "./worker.js";
import { AuthorityPermitIssuanceRequest } from "@agent-core/core/protocol";

const TARGET_KIND = "run";
const NOW_MS = BASE_PERMIT_SPEC.issuedAtMs + 1;
const EXPECTATION_MISMATCH = "Authority permit does not match the target expectation";

function spec(overrides: Partial<PermitSpec>): PermitSpec {
    return Object.freeze({ ...BASE_PERMIT_SPEC, ...overrides });
}

interface PermitActors {
    readonly tenant: DurableObjectStub<TenantAuthorityDurableObject>;
    readonly target: DurableObjectStub<TargetMediationDurableObject>;
}

/** One Tenant and one target per scenario, so no scenario inherits another's storage. */
function actors(scenario: string): PermitActors {
    return {
        tenant: env.TENANT_AUTHORITY.getByName(`tenant-${scenario}`),
        target: env.TARGET_MEDIATION.getByName(`target-${scenario}`)
    };
}

/**
 * Mints one capability and hands it to the target. Ownership of a stub passed as an RPC
 * argument transfers to the recipient and the platform disposes it when the call returns
 * (https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/#stubs-received-as-parameters-in-an-rpc-call),
 * so every step mints again rather than holding one across calls, which is what SPEC
 * section 10.2 already requires of any provider resolution.
 *
 * Measured on workerd 1.20260708.1: forwarding the un-awaited mint as an argument raises
 * `DataCloneError: Could not serialize object of type "RpcPromise"`, so this hop awaits the
 * stub. Pipelining still carries the calls the target then makes through it.
 */
async function admit(
    peers: PermitActors,
    caller: string,
    requested: PermitSpec,
    expected: PermitSpec,
    nowMs: number = NOW_MS
): Promise<string> {
    // Ownership of a stub passed over RPC transfers to the recipient, so the caller sends a
    // `dup()` and disposes the one it minted. Without that the original handle outlives the
    // call and the Tenant's disposer never runs, which is a leak rather than a lifetime.
    using capability = await peers.tenant.bindTarget(TARGET_KIND, caller);
    return peers.target.admit(capability.dup(), requested, expected, nowMs);
}

/** The lost-response half of a retry: the Tenant issues and the target admits nothing. */
async function requestOnly(
    peers: PermitActors,
    caller: string,
    requested: PermitSpec
): Promise<void> {
    using capability = await peers.tenant.bindTarget(TARGET_KIND, caller);
    await peers.target.request(capability.dup(), requested);
}

async function refusal(operation: () => Promise<string>): Promise<string> {
    try {
        await operation();
    } catch (error) {
        if (error instanceof Error) return error.message;
        throw error;
    }
    throw new TypeError("Expected a refusal");
}

describe("Cloudflare cross-object authority permits", { tags: "p0" }, () => {
    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] carries the exact request bytes to the Tenant under the Actor the capability was minted for", async () => {
        const peers = actors("carriage");
        const bytes = AuthorityPermitIssuanceRequest.encode(
            new AuthorityPermitIssuanceRequest(buildTargetRequest(BASE_PERMIT_SPEC))
        );

        const digest = await admit(
            peers,
            BASE_PERMIT_SPEC.targetActor,
            BASE_PERMIT_SPEC,
            BASE_PERMIT_SPEC
        );

        expect(digest).toHaveLength(64);
        const forwarded = await peers.tenant.forwarded();
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]?.caller).toBe(`${TARGET_KIND}:${BASE_PERMIT_SPEC.targetActor}`);
        expect(forwarded[0]?.idempotencyKey).toBe(BASE_PERMIT_SPEC.nonce);
        expect(new Uint8Array(forwarded[0]?.bytes ?? [])).toEqual(bytes);
        expect(await peers.tenant.heldDigest(BASE_PERMIT_SPEC.nonce)).toBe(digest);
        expect(await peers.target.consumed(BASE_PERMIT_SPEC.nonce)).toBe(digest);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] refuses a request whose target the capability does not speak for", async () => {
        const peers = actors("wrong-target");

        // A capability minted for another Actor cannot obtain this target's permit. That is
        // the whole of what the binding buys: the identity a request is judged under is the
        // one the Tenant minted, never one the payload carries.
        const failure = await refusal(() =>
            admit(peers, "run-permit-other", BASE_PERMIT_SPEC, BASE_PERMIT_SPEC)
        );

        expect(failure).toBe("The authenticated caller is not the target the request names");
        expect(await peers.tenant.heldDigest(BASE_PERMIT_SPEC.nonce)).toBeUndefined();
        expect(await peers.target.consumed(BASE_PERMIT_SPEC.nonce)).toBeUndefined();
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] retries a lost response and consumes the replayed issuance exactly once", async () => {
        const peers = actors("response-loss");

        // First the state a lost reply leaves: the Tenant has issued, the target has
        // admitted nothing. Nothing is consumed yet, which is what makes the retry the
        // interesting case rather than a duplicate of a completed call.
        await requestOnly(peers, BASE_PERMIT_SPEC.targetActor, BASE_PERMIT_SPEC);
        const issued = await peers.tenant.heldDigest(BASE_PERMIT_SPEC.nonce);
        expect(issued).toHaveLength(64);
        expect(await peers.target.retains(BASE_PERMIT_SPEC.nonce)).toBe(true);
        expect(await peers.target.consumed(BASE_PERMIT_SPEC.nonce)).toBeUndefined();

        // Now the retry. The Tenant replays that exact issuance rather than minting a new
        // one, and the target consumes it once.
        const admitted = await admit(
            peers,
            BASE_PERMIT_SPEC.targetActor,
            BASE_PERMIT_SPEC,
            BASE_PERMIT_SPEC
        );

        expect(admitted).toBe(issued);
        expect(await peers.tenant.forwarded()).toHaveLength(2);
        expect(await peers.tenant.heldDigest(BASE_PERMIT_SPEC.nonce)).toBe(issued);
        expect(await peers.target.consumed(BASE_PERMIT_SPEC.nonce)).toBe(issued);

        // A third delivery of the same nonce is refused, so the effect happened once.
        const failure = await refusal(() =>
            admit(peers, BASE_PERMIT_SPEC.targetActor, BASE_PERMIT_SPEC, BASE_PERMIT_SPEC)
        );
        expect(failure).toBe("Authority permit nonce was already used by this Actor owner");
        expect(await peers.target.consumed(BASE_PERMIT_SPEC.nonce)).toBe(issued);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] keeps a duplicated capability answering after the original handle is released", async () => {
        const peers = actors("disposed");

        // Disposing one handle must not sever a capability another holder can still reach:
        // ownership of a stub sent over RPC transfers to the recipient, so the caller sends a
        // duplicate and releases its own, and the duplicate keeps working.
        const minted = await peers.tenant.bindTarget(TARGET_KIND, BASE_PERMIT_SPEC.targetActor);
        const duplicate = minted.dup();
        minted[Symbol.dispose]();
        await expect(
            peers.target.request(duplicate.dup(), BASE_PERMIT_SPEC)
        ).resolves.toBeUndefined();

        // Workerd calls the RpcTarget disposer after the client execution context ends. The
        // structural capability test covers refusal after the final local release; this lane
        // proves that releasing the original handle does not sever its duplicate.
        duplicate[Symbol.dispose]();
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] refuses a redelivery that rebinds one idempotency key to different bytes", async () => {
        const peers = actors("rebound-key");
        const request = AuthorityPermitIssuanceRequest.encode(
            new AuthorityPermitIssuanceRequest(buildTargetRequest(BASE_PERMIT_SPEC))
        );
        const substituted = AuthorityPermitIssuanceRequest.encode(
            new AuthorityPermitIssuanceRequest(
                buildTargetRequest(spec({ itemKey: "item-permit-substituted" }))
            )
        );

        await runInDurableObject(peers.tenant, async (instance: TenantAuthorityDurableObject) => {
            const capability = instance.bindTarget(TARGET_KIND, BASE_PERMIT_SPEC.targetActor);
            await expect(
                capability.issuePermit(request, BASE_PERMIT_SPEC.nonce)
            ).resolves.toBeInstanceOf(Uint8Array);
            // A repeat of the key with the same bytes is a redelivery and is forwarded again.
            await expect(
                capability.issuePermit(request, BASE_PERMIT_SPEC.nonce)
            ).resolves.toBeInstanceOf(Uint8Array);
            // Different bytes under that key would ask the Tenant to bind one nonce to two
            // requests, so the capability refuses before the Tenant sees it.
            await expect(
                capability.issuePermit(substituted, BASE_PERMIT_SPEC.nonce)
            ).rejects.toMatchObject({ code: "authority.denied" });
            capability[Symbol.dispose]();
        });
        expect(await peers.tenant.forwarded()).toHaveLength(2);
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING] carries an authenticated Tenant denial back without an admission", async () => {
        const peers = actors("denied");
        await peers.tenant.setDecision("deny");

        const failure = await refusal(() =>
            admit(peers, BASE_PERMIT_SPEC.targetActor, BASE_PERMIT_SPEC, BASE_PERMIT_SPEC)
        );

        expect(failure).toBe("Tenant authority denied permit issuance: noMatchingAllow");
        expect(await peers.tenant.heldDigest(BASE_PERMIT_SPEC.nonce)).toBeUndefined();
        expect(await peers.target.consumed(BASE_PERMIT_SPEC.nonce)).toBeUndefined();
        // The target still retains the immutable request it recorded before asking.
        expect(await peers.target.retains(BASE_PERMIT_SPEC.nonce)).toBe(true);
    });
});

describe("Cloudflare authority permit consumption", { tags: "p0" }, () => {
    it(
        "[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] retains the request beside the consumption and survives losing the instance",
        { timeout: 20_000 },
        async () => {
            const peers = actors("durable");
            const digest = await admit(
                peers,
                BASE_PERMIT_SPEC.targetActor,
                BASE_PERMIT_SPEC,
                BASE_PERMIT_SPEC
            );

            await evictDurableObject(peers.target);

            // The target comes back in a new isolate. SPEC section 10.3 requires consumption to
            // retain rather than replace the immutable request, and both records are read out of
            // durable SQLite rather than out of anything the lost isolate was holding.
            expect(await peers.target.consumed(BASE_PERMIT_SPEC.nonce)).toBe(digest);
            expect(await peers.target.retains(BASE_PERMIT_SPEC.nonce)).toBe(true);
            expect(await peers.tenant.heldDigest(BASE_PERMIT_SPEC.nonce)).toBe(digest);
        }
    );

    it.each([
        { field: "target-fence", expected: { targetFence: 2 } },
        { field: "path-epoch", expected: { tenantEpoch: 8 } },
        { field: "item-key", expected: { itemKey: "item-permit-elsewhere" } },
        { field: "arguments", expected: { recipient: "elsewhere@example.test" } }
    ])(
        "[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] refuses an issued permit the target expectation disagrees with on $field",
        async ({ field, expected }) => {
            const peers = actors(`mismatch-${field}`);

            const failure = await refusal(() =>
                admit(peers, BASE_PERMIT_SPEC.targetActor, BASE_PERMIT_SPEC, spec(expected))
            );

            expect(failure).toBe(EXPECTATION_MISMATCH);
            expect(await peers.target.consumed(BASE_PERMIT_SPEC.nonce)).toBeUndefined();
        }
    );

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] refuses a permit whose window has closed", async () => {
        const peers = actors("expired");
        const shortLived = spec({ expiresAtMs: BASE_PERMIT_SPEC.issuedAtMs + 10 });

        const failure = await refusal(() =>
            admit(peers, shortLived.targetActor, shortLived, shortLived, shortLived.expiresAtMs + 1)
        );

        expect(failure).toBe("Authority permit is not valid at the target admission time");
        expect(await peers.target.consumed(shortLived.nonce)).toBeUndefined();
    });

    it("[C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION] writes nothing to the target's consumption table when the admission is refused", async () => {
        const peers = actors("rollback");

        const failure = await refusal(() =>
            admit(peers, BASE_PERMIT_SPEC.targetActor, BASE_PERMIT_SPEC, spec({ targetFence: 3 }))
        );

        expect(failure).toBe(EXPECTATION_MISMATCH);
        // Read the target's storage from inside the object: a refused admission must write
        // no consumption row, and the store must still serve afterwards.
        await runInDurableObject(peers.target, (instance: TargetMediationDurableObject) => {
            const rows = instance.sqlite.all(
                "SELECT count(*) AS total FROM authority_permit_consumptions",
                []
            );
            expect(rows[0]?.["total"]).toBe(0);
        });
        expect(await peers.target.consumed(BASE_PERMIT_SPEC.nonce)).toBeUndefined();
    });
});
