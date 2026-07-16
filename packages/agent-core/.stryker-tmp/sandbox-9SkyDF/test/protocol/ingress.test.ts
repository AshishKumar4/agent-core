// @ts-nocheck
import { expect, test } from "vitest";
import { ContentRef, Digest, Revision } from "../../src/core";
import { PrincipalId, PrincipalRef, TenantId } from "../../src/identity";
import {
    CommandAuthenticator,
    commandAuthenticationMatches
} from "../../src/protocol/authentication";
import {
    CommandEnvelope,
    CommandEnvelopeCodec,
    type CommandCaller
} from "../../src/protocol/envelope";
import { CommandCommitUnknownError } from "../../src/protocol/dispatcher";
import { CommandIngress } from "../../src/protocol/ingress";
import { CounterHarness } from "./counter-fixture";
import { expectAgentCoreErrorValue } from "./error-assertion";

test("CommandIngress owns the raw envelope before asynchronous preparation", async () => {
    const harness = new CounterHarness();
    const raw = harness.envelope({ key: "copied-envelope", amount: 2 });
    const barrier = harness.pauseNextPayloadGet();
    const pending = harness.dispatch(raw);
    await barrier.started;
    raw.fill(0);
    barrier.release();

    const result = await pending;

    expect(result.outcome).toBe("committed");
    expect(harness.snapshot().value).toBe(2);
});

test("[C13-PROTOCOL-ATOMIC-EVIDENCE] oversized submitted payload is deterministic malformed evidence", async () => {
    const harness = new CounterHarness();
    const payload = new Uint8Array(1025);
    const digest = Digest.sha256(payload);
    const raw = CommandEnvelopeCodec.encode(
        new CommandEnvelope({
            command: "counter.increment",
            caller: harness.caller,
            idempotencyKey: "oversized-payload",
            expectedRevision: Revision.initial(),
            payload: ContentRef.fromDigest(digest),
            payloadDigest: digest
        })
    );

    const result = await harness.dispatch(raw, harness.caller, payload);

    expect(result.outcome).toBe("rejectedMalformed");
    expect(harness.snapshot()).toMatchObject({
        value: 0,
        identityCount: 1,
        contentGets: 0,
        contentPuts: 0
    });
});

test("injected transport authentication cannot forge the envelope caller", async () => {
    const harness = new CounterHarness();
    const ingress = new CommandIngress({
        dispatcher: harness.dispatcher,
        content: harness.content,
        authenticator: new TokenAuthenticator(harness.tenant, harness.caller),
        leaseForMilliseconds: 60_000,
        now: () => CounterHarness.now
    });
    const raw = harness.envelope({ key: "transport-authentication" });

    const forged = await ingress.accept(raw, "forged");
    const accepted = await ingress.accept(raw, "valid");

    expect(forged).toMatchObject({ outcome: "rejectedAuthentication" });
    expect(accepted).toMatchObject({ outcome: "committed" });
    expect(harness.snapshot()).toMatchObject({ value: 1, contentGets: 1 });
});

test("transport authentication absence and faults remain typed pre-dispatch outcomes", async () => {
    const harness = new CounterHarness();
    const raw = harness.envelope({ key: "transport-faults" });
    const absent = new CommandIngress({
        dispatcher: harness.dispatcher,
        content: harness.content,
        authenticator: new TokenAuthenticator(harness.tenant, harness.caller),
        leaseForMilliseconds: 60_000
    });
    const faulting = new CommandIngress({
        dispatcher: harness.dispatcher,
        content: harness.content,
        authenticator: new FaultingAuthenticator(harness.tenant),
        leaseForMilliseconds: 60_000
    });

    expect(await absent.accept(raw, "absent")).toMatchObject({
        kind: "commandOutcome",
        outcome: "rejectedAuthentication"
    });
    expect(await faulting.accept(raw, "fault")).toMatchObject({
        kind: "preDispatchFailure",
        phase: "admissionPreflight",
        commit: "notAttempted",
        retry: "mayRetry",
        cause: expect.objectContaining({ message: "transport unavailable" })
    });
});

test("authentications retain the issued caller instead of a mutable transport object", async () => {
    const tenant = new TenantId("issued-tenant");
    const caller: { kind: "principal"; principal: PrincipalRef } = {
        kind: "principal",
        principal: new PrincipalRef(tenant, new PrincipalId("issued-principal"))
    };
    const authenticator = new MutableCallerAuthenticator(caller);
    const envelope = new CommandEnvelope({
        command: "issued.command",
        caller: { kind: caller.kind, principal: caller.principal },
        idempotencyKey: "issued-key",
        payload: ContentRef.fromDigest(Digest.sha256(Uint8Array.of(1))),
        payloadDigest: Digest.sha256(Uint8Array.of(1))
    });
    const envelopeDigest = Digest.sha256(CommandEnvelopeCodec.encode(envelope));
    const authentication = await authenticator.authenticate(undefined, envelope, envelopeDigest);
    caller.principal = new PrincipalRef(tenant, new PrincipalId("mutated-principal"));

    expect(commandAuthenticationMatches(authentication, envelopeDigest, envelope, tenant)).toBe(
        true
    );
    expect(
        commandAuthenticationMatches(
            authentication,
            Digest.sha256(Uint8Array.of(2)),
            envelope,
            tenant
        )
    ).toBe(false);
});

test("forged heldContentVerifier cannot replace transport authentication", () => {
    const harness = new CounterHarness();
    Object.defineProperty(harness.dispatcher, "heldContentVerifier", {
        value: harness.content
    });
    const forgedInit = {
        dispatcher: harness.dispatcher,
        content: harness.content,
        authenticator: undefined as unknown as CommandAuthenticator<unknown>,
        leaseForMilliseconds: 60_000,
        heldContentVerifier: harness.content
    };

    expect(() => new CommandIngress(forgedInit)).toThrow(/requires a transport authenticator/);
});

test("exact authentication precedes unknown-command malformed and replay", async () => {
    const harness = new CounterHarness();
    const payload = harness.payloadBytes();
    const digest = Digest.sha256(payload);
    const raw = CommandEnvelopeCodec.encode(
        new CommandEnvelope({
            command: "unknown.command",
            caller: harness.caller,
            idempotencyKey: "unknown-before-auth",
            expectedRevision: Revision.initial(),
            payload: ContentRef.fromDigest(digest),
            payloadDigest: digest
        })
    );
    const ingress = new CommandIngress({
        dispatcher: harness.dispatcher,
        content: harness.content,
        authenticator: new TokenAuthenticator(harness.tenant, harness.caller),
        leaseForMilliseconds: 60_000,
        now: () => CounterHarness.now
    });

    const forged = await ingress.accept(raw, "forged");
    const malformed = await ingress.accept(raw, "valid");
    const duplicate = await ingress.accept(raw, "valid");

    expect(forged).toMatchObject({ outcome: "rejectedAuthentication" });
    expect(malformed).toMatchObject({ outcome: "rejectedMalformed" });
    expect(duplicate).toMatchObject({
        outcome: "duplicate",
        reply: malformed.kind === "commandOutcome" ? malformed.reply : undefined
    });
    expect(harness.snapshot()).toMatchObject({
        value: 0,
        identityCount: 1,
        contentGets: 0
    });
});

test("reference mismatch is rejected without touching transient content", async () => {
    const harness = new CounterHarness();
    const payload = harness.payloadBytes();
    const payloadDigest = Digest.sha256(payload);
    const raw = CommandEnvelopeCodec.encode(
        new CommandEnvelope({
            command: "counter.increment",
            caller: harness.caller,
            idempotencyKey: "reference-mismatch",
            expectedRevision: Revision.initial(),
            payload: ContentRef.fromDigest(Digest.sha256(Uint8Array.of(9))),
            payloadDigest
        })
    );

    expect(await harness.dispatch(raw)).toMatchObject({ outcome: "rejectedMalformed" });
    expect(harness.snapshot()).toMatchObject({ contentGets: 0, contentPuts: 0 });
});

test.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid payload lease duration %s",
    (leaseForMilliseconds) => {
        const harness = new CounterHarness();
        expect(
            () =>
                new CommandIngress({
                    dispatcher: harness.dispatcher,
                    content: harness.content,
                    authenticator: new TokenAuthenticator(harness.tenant, harness.caller),
                    leaseForMilliseconds: leaseForMilliseconds as number
                })
        ).toThrow("positive safe integer");
    }
);

test("rejects unsafe lease expiry", async () => {
    const harness = new CounterHarness();
    const ingress = new CommandIngress({
        dispatcher: harness.dispatcher,
        content: harness.content,
        authenticator: new TokenAuthenticator(harness.tenant, harness.caller),
        leaseForMilliseconds: Number.MAX_SAFE_INTEGER,
        now: () => new Date("2026-07-07T12:00:00.000Z")
    });
    const result = await ingress.accept(harness.envelope({ key: "unsafe-expiry" }), "valid");
    expect(result).toMatchObject({
        kind: "preDispatchFailure",
        phase: "admissionPreflight",
        commit: "notAttempted",
        cause: expect.objectContaining({ message: "Command payload lease expiry is invalid" })
    });
    if (result.kind === "preDispatchFailure") {
        expectAgentCoreErrorValue(result.cause, "protocol.invalid-state");
    }
});

test.each(["authUnknown", "contentUnknown"] as const)(
    "%s before command transaction remains notAttempted and does not poison Actor",
    async (fault) => {
        const harness = new CounterHarness();
        harness.setFault(fault);

        expect(await harness.accept(harness.envelope({ key: fault }))).toMatchObject({
            kind: "preDispatchFailure",
            phase: "admissionPreflight",
            commit: "notAttempted",
            retry: "mayRetry",
            cause: expect.any(CommandCommitUnknownError)
        });

        harness.setFault(undefined);
        expect(
            await harness.dispatch(harness.envelope({ key: `${fault}-recovered` }))
        ).toMatchObject({ outcome: "committed" });
    }
);

class TokenAuthenticator extends CommandAuthenticator<string> {
    public constructor(
        tenant: TenantId,
        private readonly caller: CommandCaller
    ) {
        super(tenant);
    }

    protected authenticateTransport(token: string): CommandCaller | undefined {
        if (token === "valid") return this.caller;
        if (token === "forged") {
            const tenant =
                this.caller.kind === "principal"
                    ? this.caller.principal.tenantId
                    : new TenantId("forged-tenant");
            return {
                kind: "principal",
                principal: new PrincipalRef(tenant, new PrincipalId("forged-transport"))
            };
        }
        return undefined;
    }
}

class FaultingAuthenticator extends CommandAuthenticator<string> {
    public constructor(tenant: TenantId) {
        super(tenant);
    }

    protected authenticateTransport(): CommandCaller {
        throw new TypeError("transport unavailable");
    }
}

class MutableCallerAuthenticator extends CommandAuthenticator<undefined> {
    public constructor(private readonly caller: CommandCaller) {
        if (caller.kind !== "principal") throw new TypeError("test caller must be principal");
        super(caller.principal.tenantId);
    }

    protected authenticateTransport(): CommandCaller {
        return this.caller;
    }
}
