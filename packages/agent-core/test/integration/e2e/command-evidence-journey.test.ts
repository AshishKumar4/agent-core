import { describe, expect, test } from "vitest";
import { Digest, decodeCanonicalJson } from "../../../src/core";
import { CounterHarness, type CounterFixtureFactory } from "../../protocol/counter-fixture";
import { SqliteCounterHarness } from "../../protocol/sqlite-counter-fixture";
import { commandOutcome } from "./journey-support";

/*
 * The command journey end to end: an envelope is built, admitted by the real ingress,
 * dispatched by the real dispatcher, and settles as a durable audit and write chain
 * that a replay of the same envelope reuses byte for byte.
 */
function commandEvidenceJourney(name: string, create: CounterFixtureFactory): void {
    describe(`command to durable evidence (${name})`, () => {
        test(
            "settles an accepted envelope as a committed write under a host-created Invocation root",
            { tags: "p1" },
            async () => {
                const harness = create();
                const raw = harness.envelope({ key: "journey-committed", amount: 5 });

                const result = commandOutcome(await harness.accept(raw));
                const snapshot = harness.snapshot();

                expect(result.outcome).toBe("committed");
                expect(decodeCanonicalJson(result.reply)).toEqual({ value: 5, revision: 1 });
                expect(snapshot).toMatchObject({
                    value: 5,
                    identityCount: 1,
                    contentGets: 1,
                    contentPuts: 0
                });
                expect(snapshot.revision.value).toBe(1);
                expect(snapshot.writes).toHaveLength(1);
                expect(snapshot.audits.size).toBe(2);

                const root = [...snapshot.audits.values()].find(
                    (record) => record.kind.kind === "invocation"
                );
                const audit = snapshot.audits.get(result.write.audit.value);
                expect(root?.cause).toBeUndefined();
                expect(root?.tenant.equals(harness.tenant)).toBe(true);
                expect(audit?.cause?.equals(root!.id)).toBe(true);
                expect(audit?.correlation.equals(root!.correlation)).toBe(true);
                expect(audit?.kind).toMatchObject({
                    kind: "write",
                    outcome: "committed",
                    id: result.write.id
                });

                expect(result.write.envelopeDigest.equals(Digest.sha256(raw))).toBe(true);
                expect(result.write.command).toBe("counter.increment");
                expect(result.write.idempotencyKey).toBe("journey-committed");
                expect(result.write.caller).toEqual(harness.caller);
                expect(result.write.reply).toEqual(result.reply);
                // The committed write burnt its identity: identityCount is 1 above.
            }
        );

        test(
            "adopts a valid caller cause correlation instead of opening another Invocation root",
            { tags: "p1" },
            async () => {
                const harness = create();
                const cause = harness.seedInvocationCause("journey-cause");

                const result = await harness.dispatch(
                    harness.envelope({ key: "journey-caused", callerCause: cause.id })
                );
                const snapshot = harness.snapshot();
                const audit = snapshot.audits.get(result.write.audit.value);

                expect(result.outcome).toBe("committed");
                expect(snapshot.writes).toHaveLength(1);
                expect(snapshot.audits.size).toBe(2);
                expect(audit?.cause?.equals(cause.id)).toBe(true);
                expect(audit?.correlation.equals(cause.correlation)).toBe(true);
                expect(snapshot).toMatchObject({ identityCount: 1, contentPuts: 0 });
            }
        );

        test(
            "replays a resubmitted envelope as byte-identical duplicate evidence",
            { tags: "p0" },
            async () => {
                const harness = create();
                const raw = harness.envelope({ key: "journey-replay", amount: 2 });
                const first = await harness.dispatch(raw);
                const before = harness.snapshot();

                const duplicate = await harness.dispatch(raw);
                const after = harness.snapshot();
                const audit = after.audits.get(duplicate.write.audit.value);

                expect(first.outcome).toBe("committed");
                expect(duplicate.outcome).toBe("duplicate");
                expect(duplicate.reply).toEqual(first.reply);
                expect(duplicate.write.duplicateOf?.equals(first.write.id)).toBe(true);
                // A duplicate reserves nothing; the identityCount assertion below proves it.
                expect(audit?.kind).toMatchObject({ kind: "write", outcome: "duplicate" });
                expect(after).toMatchObject({
                    value: before.value,
                    identityCount: before.identityCount,
                    contentGets: before.contentGets,
                    contentPuts: before.contentPuts
                });
                expect(after.revision.value).toBe(before.revision.value);
                expect(after.writes.map((write) => write.outcome)).toEqual([
                    "committed",
                    "duplicate"
                ]);
            }
        );
    });
}

commandEvidenceJourney("memory", (options) => new CounterHarness(options));
commandEvidenceJourney("SQLite", (options) => new SqliteCounterHarness(options));
