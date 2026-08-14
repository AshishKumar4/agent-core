import { describe, expect, test } from "vitest";
import {
    AuthorityCheckEvidence,
    AuthorityCheckRequest,
    BindingValidationEvidence,
    BindingValidationRequest
} from "../../../src/authority";
import { TENANT_AUTHORITY_COMMANDS } from "../../../src/composition";
import { TenantId } from "../../../src/identity";
import {
    AuthorityCheckReply,
    AuthorityPermitIssuanceReply,
    AuthorityPermitIssuanceRequest,
    BindingValidationReply
} from "../../../src/protocol";
import {
    JOURNEY_NOW,
    authorityJourneySubstrates,
    type AuthorityJourneyFactory
} from "./journey-support";

/*
 * The authority journey end to end: a Workspace Actor validates its Binding, checks an
 * intent, and takes a permit out of one closed Tenant authority composition — every
 * step producing evidence bound to the authenticated source and the decision instant.
 */
function authorityJourney(name: string, create: AuthorityJourneyFactory): void {
    describe(`closed Tenant authority journey (${name})`, () => {
        test(
            "validates a Binding, checks the intent, and issues the permit as linked evidence",
            { tags: "p1" },
            async () => {
                const journey = create(`${name}-authority`);

                const validation = journey.bindingRequest();
                const validationPayload = BindingValidationRequest.encode(validation);
                const validated = await journey.dispatch(
                    journey.envelope(
                        TENANT_AUTHORITY_COMMANDS.validateBinding,
                        "journey-binding",
                        validationPayload
                    ),
                    validationPayload
                );
                const validationEvidence = BindingValidationReply.decode(validated.reply).evidence;

                expect(validated.outcome).toBe("committed");
                expect(validationEvidence.binds(validation)).toBe(true);
                expect(validationEvidence.issuer.equals(journey.tenantActor)).toBe(true);
                expect(validationEvidence.checkedAt).toEqual(JOURNEY_NOW);
                expect(
                    BindingValidationEvidence.decode(validated.observation!).binds(validation)
                ).toBe(true);

                const check = journey.checkRequest();
                const checkPayload = AuthorityCheckRequest.encode(check);
                const checked = await journey.dispatch(
                    journey.envelope(
                        TENANT_AUTHORITY_COMMANDS.check,
                        "journey-check",
                        checkPayload
                    ),
                    checkPayload
                );
                const checkEvidence = AuthorityCheckReply.decode(checked.reply).evidence;

                expect(checked.outcome).toBe("committed");
                expect(checkEvidence.binds(check)).toBe(true);
                expect(checkEvidence.decision).toBe("allow");
                expect(checked.write.caller).toEqual(journey.caller);
                expect(AuthorityCheckEvidence.decode(checked.observation!).allowed).toBe(true);

                const permitRequest = journey.permitRequest();
                const permitPayload = AuthorityPermitIssuanceRequest.encode(permitRequest);
                const issued = await journey.dispatch(
                    journey.envelope(
                        TENANT_AUTHORITY_COMMANDS.issuePermit,
                        "journey-permit",
                        permitPayload
                    ),
                    permitPayload
                );
                const permit = AuthorityPermitIssuanceReply.decode(issued.reply).requirePermit();

                expect(issued.outcome).toBe("committed");
                expect(permit.expectation.equals(permitRequest.targetRequest.expectation)).toBe(
                    true
                );
                expect(permit.issuer.equals(journey.tenantActor)).toBe(true);
                expect(permit.issuedAt).toEqual(JOURNEY_NOW);
                expect(
                    AuthorityPermitIssuanceReply.decode(issued.observation!)
                        .requirePermit()
                        .digest()
                        .equals(permit.digest())
                ).toBe(true);
                expect(journey.snapshot()).toEqual({
                    writes: 3,
                    audits: 6,
                    permits: 1,
                    checks: 1
                });
            }
        );

        test(
            "refuses a check naming a foreign owning Tenant before evaluating authority",
            { tags: "p0" },
            async () => {
                const journey = create(`${name}-authority-foreign-owner`);
                const request = journey.checkRequest({
                    ownerTenant: new TenantId("journey-foreign-owner")
                });
                const payload = AuthorityCheckRequest.encode(request);

                const result = await journey.dispatch(
                    journey.envelope(
                        TENANT_AUTHORITY_COMMANDS.check,
                        "journey-foreign-owner",
                        payload
                    ),
                    payload
                );

                expect(result.outcome).toBe("rejectedAuthority");
                expect(result.observation).toBeUndefined();
                expect(journey.snapshot()).toEqual({
                    writes: 1,
                    audits: 1,
                    permits: 0,
                    checks: 0
                });
            }
        );

        test(
            "replays a duplicate check without re-evaluating authority",
            { tags: "p0" },
            async () => {
                const journey = create(`${name}-authority-replay`);
                const request = journey.checkRequest();
                const payload = AuthorityCheckRequest.encode(request);
                const raw = journey.envelope(
                    TENANT_AUTHORITY_COMMANDS.check,
                    "journey-check-replay",
                    payload
                );

                const first = await journey.dispatch(raw, payload);
                const duplicate = await journey.dispatch(raw, payload);

                expect(first.outcome).toBe("committed");
                expect(duplicate.outcome).toBe("duplicate");
                expect(duplicate.reply).toEqual(first.reply);
                expect(duplicate.write.duplicateOf?.equals(first.write.id)).toBe(true);
                expect(journey.snapshot().checks).toBe(1);
            }
        );
    });
}

for (const [name, create] of authorityJourneySubstrates) {
    authorityJourney(name, create);
}
