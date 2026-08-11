import { describe, expect, test } from "vitest";
import { AuthorityCheckRequest } from "../../../src/authority";
import { TENANT_AUTHORITY_COMMANDS } from "../../../src/composition";
import type { CommandCaller } from "../../../src/protocol";
import { authorityJourneySubstrates, type AuthorityJourneyFactory } from "./journey-support";

/*
 * Two Tenants, one process: neither composition can be reached by the other's callers.
 * A foreign Principal never gets past authentication, and a foreign Actor never gets
 * past authority — and in both cases the foreign Tenant's own evidence stays untouched.
 */
function tenantIsolationJourney(name: string, create: AuthorityJourneyFactory): void {
    describe(`multi-Tenant isolation (${name})`, () => {
        test("refuses a foreign Tenant Principal caller at authentication", { tags: "p0" }, async () => {
            const home = create(`${name}-isolation-home-principal`);
            const foreign = create(`${name}-isolation-foreign-principal`);
            const caller: CommandCaller = { kind: "principal", principal: foreign.principal };
            const payload = AuthorityCheckRequest.encode(home.checkRequest());

            const result = await home.dispatch(
                home.envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    "isolation-foreign-principal",
                    payload,
                    caller
                ),
                payload,
                caller
            );

            expect(result.outcome).toBe("rejectedAuthentication");
            expect(home.snapshot()).toEqual({ writes: 1, audits: 1, permits: 0, checks: 0 });
            expect(foreign.snapshot()).toEqual({ writes: 0, audits: 0, permits: 0, checks: 0 });
        });

        test("refuses a foreign Tenant Actor caller at authority", { tags: "p0" }, async () => {
            const home = create(`${name}-isolation-home-actor`);
            const foreign = create(`${name}-isolation-foreign-actor`);
            const payload = AuthorityCheckRequest.encode(home.checkRequest());

            const result = await home.dispatch(
                home.envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    "isolation-foreign-actor",
                    payload,
                    foreign.caller
                ),
                payload,
                foreign.caller
            );

            expect(result.outcome).toBe("rejectedAuthority");
            expect(home.snapshot()).toEqual({ writes: 1, audits: 1, permits: 0, checks: 0 });
            expect(foreign.snapshot()).toEqual({ writes: 0, audits: 0, permits: 0, checks: 0 });
        });

        test("reserves the same idempotency key independently per Tenant", { tags: "p0" }, async () => {
            const first = create(`${name}-isolation-first`);
            const second = create(`${name}-isolation-second`);
            const key = "isolation-shared-key";
            const firstPayload = AuthorityCheckRequest.encode(first.checkRequest());
            const secondPayload = AuthorityCheckRequest.encode(second.checkRequest());

            const committed = await first.dispatch(
                first.envelope(TENANT_AUTHORITY_COMMANDS.check, key, firstPayload),
                firstPayload
            );
            const other = await second.dispatch(
                second.envelope(TENANT_AUTHORITY_COMMANDS.check, key, secondPayload),
                secondPayload
            );

            expect([committed.outcome, other.outcome]).toEqual(["committed", "committed"]);
            expect(other.write.duplicateOf).toBeUndefined();
            expect(other.reply).not.toEqual(committed.reply);
            expect(first.snapshot()).toMatchObject({ writes: 1, checks: 1 });
            expect(second.snapshot()).toMatchObject({ writes: 1, checks: 1 });
        });
    });
}

for (const [name, create] of authorityJourneySubstrates) {
    tenantIsolationJourney(name, create);
}
