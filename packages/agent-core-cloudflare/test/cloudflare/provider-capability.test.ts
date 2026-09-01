import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentCoreError, Digest } from "@agent-core/core";
import {
    PROVIDER_CAPABILITY_PATH,
    ProviderCapabilityScope,
    type CloudflareErrorPort
} from "../../src/index.js";
import { GATEWAY_BINDING, GATEWAY_CREDENTIAL, TEST_SESSION_LIMITS } from "./provider-actor.js";

const probeErrors: CloudflareErrorPort = {
    raise(code, message): never {
        throw new AgentCoreError(code, message);
    }
};

/**
 * Opens a real session and counts the answers the caller waits for. One answer is one
 * round trip: the transport underneath is a Durable Object on the far side of a workerd
 * isolate boundary, so a saved trip is measured rather than asserted.
 */
async function openCounted(
    instance: string,
    answers: { count: number }
): Promise<ProviderCapabilityScope> {
    const response = await env.PROVIDERS.getByName(instance).fetch(
        new Request(`https://agent-core-provider${PROVIDER_CAPABILITY_PATH}`, {
            headers: { Upgrade: "websocket" }
        })
    );
    const socket = response.webSocket;
    if (socket === null) throw new TypeError("Provider Actor returned no WebSocket");
    socket.accept();
    socket.addEventListener("message", () => {
        answers.count += 1;
    });
    return ProviderCapabilityScope.attach(socket, probeErrors);
}

describe("Cloudflare provider capability RPC", () => {
    it(
        "pipelines a Binding and the call through it into one round trip",
        { tags: "p1" },
        async () => {
            const answers = { count: 0 };
            using scope = await openCounted("pipelined", answers);

            // The Binding promise is never awaited: Cap'n Web delivers `invoke` against
            // it, so both calls leave before either answer arrives. Awaiting first would
            // make `capability` an ordinary promise with no `invoke` on it at all.
            using capability = scope.endpoint
                .authenticate({ credential: GATEWAY_CREDENTIAL })
                .binding(GATEWAY_BINDING);
            const sealed = await capability.invoke("seal", { payload: "alpha" });

            expect(sealed).toMatchObject({ holder: "holder-1" });
            // One answer for the whole authenticate → binding → invoke chain: neither
            // later call ever waited on an earlier one's reply.
            expect(answers.count).toBe(1);
        }
    );

    it(
        "spends the round trips when the same calls are awaited in turn",
        { tags: "p1" },
        async () => {
            const answers = { count: 0 };
            using scope = await openCounted("sequential", answers);

            // The control: the same work over the same transport, with each link of
            // the authenticate → binding → invoke chain resolved before it is used.
            // Each await is a round trip the pipelined form does not spend.
            const directory = await scope.endpoint.authenticate({
                credential: GATEWAY_CREDENTIAL
            });
            using capability = await directory.binding(GATEWAY_BINDING);
            const sealed = await capability.invoke("seal", { payload: "alpha" });

            expect(sealed).toMatchObject({ holder: "holder-1" });
            expect(answers.count).toBe(3);
        }
    );

    it("keeps the provider's key on the provider's side of the boundary", async () => {
        using scope = await openCounted("custody", { count: 0 });
        using capability = scope.endpoint
            .authenticate({ credential: GATEWAY_CREDENTIAL })
            .binding(GATEWAY_BINDING);

        const first = await capability.invoke("seal", { payload: "alpha" });
        const second = await capability.invoke("seal", { payload: "beta" });
        const unkeyed = Digest.sha256(new TextEncoder().encode("alpha")).value;

        expect(first).toMatchObject({ sealed: expect.stringMatching(/^[a-f0-9]{64}$/u) });
        // A seal the caller could recompute would mean the key never took part.
        expect(first).not.toMatchObject({ sealed: unkeyed });
        // Same holder, same operation, different payload: only the seal can differ.
        expect(second).not.toEqual(first);
    });

    it("releases the provider's lease when the holder disposes its stub", async () => {
        const stub = env.PROVIDERS.getByName("release");
        using scope = await openCounted("release", { count: 0 });

        // One authenticate, one directory: two capabilities minted from it, so the
        // second is in hand before the first one's holder releases anything.
        const directory = await scope.endpoint.authenticate({
            credential: GATEWAY_CREDENTIAL
        });
        {
            using capability = directory.binding(GATEWAY_BINDING);
            expect(await capability.invoke("uses", {})).toMatchObject({ holder: "holder-1" });
        }

        // The release rides the same ordered session, so a later call on it is delivered
        // behind the release and needs no polling to observe the effect.
        using next = directory.binding(GATEWAY_BINDING);
        expect(await next.invoke("uses", {})).toMatchObject({ holder: "holder-1" });
        const releases = await runInDurableObject(stub, (instance) => instance.releasedHolders);
        expect(releases.length).toBeGreaterThan(0);
    });

    it("refuses an unauthenticated peer everything but authenticate, and cuts the session", async () => {
        const stub = env.PROVIDERS.getByName("unauthenticated");
        using scope = await ProviderCapabilityScope.open(stub, probeErrors);

        // The endpoint exposes one method; a credential it rejects is the whole of what
        // an unauthenticated peer can do, and the directory it returns is unreachable.
        const rejected = scope.endpoint.authenticate({ credential: "not-the-credential" });
        await expect(rejected).rejects.toMatchObject({ code: "authority.denied" });
        // The refusal ended the session: nothing further crosses in either direction.
        await expect(
            scope.endpoint.authenticate({ credential: GATEWAY_CREDENTIAL })
        ).rejects.toMatchObject({ code: expect.any(String) });
    });

    it("refuses an invoke the admission has since revoked, and ends the session", async () => {
        const stub = env.PROVIDERS.getByName("stale-epoch");
        using scope = await openCounted("stale-epoch", { count: 0 });
        using capability = scope.endpoint
            .authenticate({ credential: GATEWAY_CREDENTIAL })
            .binding(GATEWAY_BINDING);
        expect(await capability.invoke("uses", {})).toMatchObject({ holder: "holder-1" });

        // Re-mediation, not remember-when-issued: the epoch moves under the session, so
        // the very next invoke is refused and the lease released. A refusal also shuts
        // the socket, and the cut is what the holder observes first — the reject it
        // would have carried cannot cross a session that no longer exists.
        await expect(capability.invoke("stale-epoch", {})).rejects.toBeInstanceOf(Error);
        const released = await runInDurableObject(stub, (instance) => instance.releasedHolders);
        expect(released).toEqual(["holder-1"]);
        // The socket is gone: nothing further crosses in either direction.
        await expect(capability.invoke("uses", {})).rejects.toBeInstanceOf(Error);
    });

    it("collapses a provider-internal failure to a code with no stack or cause", async () => {
        using scope = await openCounted("taxonomy", { count: 0 });
        using capability = scope.endpoint
            .authenticate({ credential: GATEWAY_CREDENTIAL })
            .binding(GATEWAY_BINDING);

        // An operation the handle throws on: the raw failure names an operation string
        // and nothing secret, but the boundary's taxonomy decides what crosses, and the
        // disclosed error's message is exactly its code — no cause, no provider frames.
        const failure = await capability.invoke("nonexistent", {}).then(
            () => null,
            (error: Error) => error
        );
        if (!(failure instanceof Error)) throw new TypeError("expected a failure");
        // SAFETY: the wire error is reconstructed by the transport, so all that exists
        // to read is what the disclosed taxonomy chose to carry; `code` is one of those.
        const disclosed = failure as { code?: string };
        expect(disclosed.code).toBe("invocation.invalid");
        expect(failure.message).toBe("invocation.invalid");
        expect(failure.cause).toBeUndefined();
        // The raw message named the operation; the crossing one does not.
        expect(failure.message).not.toMatch(/nonexistent/iu);
        expect(failure.stack).not.toMatch(/signing|SIGNING_KEY|provider-actor/iu);
    });

    it("refuses a plain request without breaking the caller's stub", async () => {
        const stub = env.PROVIDERS.getByName("upgrade");
        const refused = await stub.fetch(`https://agent-core-provider${PROVIDER_CAPABILITY_PATH}`);
        expect(refused.status).toBe(400);

        // A thrown refusal would leave this stub permanently broken, so the next session
        // on it is what proves the refusal was a response.
        using scope = await ProviderCapabilityScope.open(stub, probeErrors);
        using capability = scope.endpoint
            .authenticate({ credential: GATEWAY_CREDENTIAL })
            .binding(GATEWAY_BINDING);
        expect(await capability.invoke("uses", {})).toMatchObject({ uses: 0 });
    });

    it(
        "caps a session's call budget, concurrency, and idle deadline on the injected clock",
        { tags: "p1" },
        async () => {
            const stub = env.PROVIDERS.getByName("ceilings");
            using scope = await openCounted("ceilings", { count: 0 });

            // The fixture's limits: 2 calls total, 1 concurrent, 30s idle. Each of the
            // ceilings must refuse — and a refusal releases the session leases — without
            // waiting on a wall clock.
            expect(TEST_SESSION_LIMITS.maxCalls).toBe(2);
            expect(TEST_SESSION_LIMITS.maxConcurrentCalls).toBe(1);
            const capability = scope.endpoint
                .authenticate({ credential: GATEWAY_CREDENTIAL })
                .binding(GATEWAY_BINDING);
            expect(await capability.invoke("uses", {})).toMatchObject({ holder: "holder-1" });
            expect(await capability.invoke("uses", {})).toMatchObject({ holder: "holder-1" });
            // Budget spent: the third call is refused and the session is cut, so even a
            // fresh capability on the same socket carries no authority.
            await expect(capability.invoke("uses", {})).rejects.toBeTruthy();
            await expect(
                scope.endpoint
                    .authenticate({ credential: GATEWAY_CREDENTIAL })
                    .binding(GATEWAY_BINDING)
                    .invoke("uses", {})
            ).rejects.toBeTruthy();

            // The idle timer runs on the injected clock; advancing it reclaims a session
            // without a wall-clock wait.
            await runInDurableObject(stub, (instance) => {
                instance.clock.advance(TEST_SESSION_LIMITS.idleMs + 1);
            });
        }
    );
});
