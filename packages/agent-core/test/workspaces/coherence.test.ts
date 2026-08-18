import { expect, test } from "vitest";
import { GrantId } from "../../src/authority";
import {
    Digest,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonValue
} from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { BindingName } from "../../src/facets";
import { PrincipalRef, ScopeRef, TenantId, WorkspaceId } from "../../src/identity";
import {
    CoherenceFinding,
    CoherenceVerdict,
    admitCrossRunObservation,
    authorizeObservedIntervention,
    decideCoherenceFinding,
    type CrossRunObservation,
    type ObservationAuthority,
    type ObservationDecision,
    type TenantRelation
} from "../../src/workspaces";
import {
    coherenceFindingFixture,
    coherenceFindingIdentityFixture,
    crossRunObservationFixture,
    observationGrant,
    observedIntentFixture,
    observedSubjects,
    principal,
    principalId,
    scope,
    tenant
} from "./fixtures";

const sameTenant: TenantRelation = { kind: "same", tenant };
const foreignTenant = new TenantId("tenant-foreign");
const crossBinding = new BindingName("binding.cross");
const otherDigest = "b".repeat(64);

function observeAuthority(init: Partial<ObservationAuthority> = {}): ObservationAuthority {
    return {
        grant: init.grant ?? observationGrant,
        scope: init.scope ?? scope,
        runs: init.runs ?? [observedSubjects[1]],
        impacts: init.impacts ?? ["observe"]
    };
}

function refusalReason(decision: ObservationDecision): string {
    if (decision.kind !== "refused") throw new TypeError("Decision was admitted");
    return decision.refusal.reason;
}

function admittedGrant(decision: ObservationDecision): GrantId {
    if (decision.kind !== "admitted") throw new TypeError("Decision was refused");
    return decision.grant;
}

test(
    "[C13-SUBSCRIPTION-OBSERVATION-GRANT] refuses an observer presenting no Grant at all",
    { tags: "p0" },
    () => {
        const decision = admitCrossRunObservation(
            crossRunObservationFixture(),
            [],
            sameTenant
        );
        expect(refusalReason(decision)).toBe("ambient");
        if (decision.kind !== "refused") throw new TypeError("Decision was admitted");
        expect(decision.refusal.denied()).toBeInstanceOf(AgentCoreError);
        expect(decision.refusal.denied().code).toBe("authority.denied");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-GRANT] refuses a Grant that admits another Run",
    { tags: "p0" },
    () => {
        const decision = admitCrossRunObservation(
            crossRunObservationFixture(),
            [observeAuthority({ runs: [observedSubjects[0]] })],
            sameTenant
        );
        expect(refusalReason(decision)).toBe("ambient");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-GRANT] refuses a Grant held outside the observed Run's Scope path",
    { tags: "p0" },
    () => {
        const decision = admitCrossRunObservation(
            crossRunObservationFixture(),
            [
                observeAuthority({
                    scope: ScopeRef.workspace(tenant, new WorkspaceId("workspace-elsewhere"))
                })
            ],
            sameTenant
        );
        expect(refusalReason(decision)).toBe("ambient");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-GRANT] refuses a Grant the observation does not name",
    { tags: "p0" },
    () => {
        const decision = admitCrossRunObservation(
            crossRunObservationFixture(),
            [observeAuthority({ grant: new GrantId("grant-other") })],
            sameTenant
        );
        expect(refusalReason(decision)).toBe("ambient");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-GRANT] refuses a named Grant carrying no observe impact",
    { tags: "p0" },
    () => {
        const decision = admitCrossRunObservation(
            crossRunObservationFixture(),
            [observeAuthority({ impacts: ["mutate", "execute"] })],
            sameTenant
        );
        expect(refusalReason(decision)).toBe("impact");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-GRANT] admits an observe Grant reaching the Run through an ancestor Scope",
    { tags: "p0" },
    () => {
        const decision = admitCrossRunObservation(
            crossRunObservationFixture(),
            [observeAuthority({ scope: ScopeRef.tenant(tenant) })],
            sameTenant
        );
        expect(admittedGrant(decision).value).toBe(observationGrant.value);
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-TENANT] refuses a cross-tenant observation with no cross-tenant Binding",
    { tags: "p0" },
    () => {
        const observation: CrossRunObservation = {
            ...crossRunObservationFixture(),
            subjectScope: ScopeRef.workspace(foreignTenant, new WorkspaceId("workspace-foreign"))
        };
        const decision = admitCrossRunObservation(
            observation,
            [observeAuthority({ scope: ScopeRef.tenant(foreignTenant) })],
            {
                kind: "cross",
                source: foreignTenant,
                target: tenant,
                authority: crossBinding
            }
        );
        expect(refusalReason(decision)).toBe("tenant");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-TENANT] refuses a cross-tenant observation naming another Binding",
    { tags: "p0" },
    () => {
        const observation: CrossRunObservation = {
            ...crossRunObservationFixture(),
            subjectScope: ScopeRef.workspace(foreignTenant, new WorkspaceId("workspace-foreign")),
            crossTenantAuthority: new BindingName("binding.unrelated")
        };
        const decision = admitCrossRunObservation(
            observation,
            [observeAuthority({ scope: ScopeRef.tenant(foreignTenant) })],
            {
                kind: "cross",
                source: foreignTenant,
                target: tenant,
                authority: crossBinding
            }
        );
        expect(refusalReason(decision)).toBe("tenant");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-TENANT] refuses a same-tenant route carrying cross-tenant authority",
    { tags: "p0" },
    () => {
        const decision = admitCrossRunObservation(
            { ...crossRunObservationFixture(), crossTenantAuthority: crossBinding },
            [observeAuthority()],
            sameTenant
        );
        expect(refusalReason(decision)).toBe("tenant");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-TENANT] refuses an observer whose Tenant is not the route's target",
    { tags: "p0" },
    () => {
        const observation: CrossRunObservation = {
            ...crossRunObservationFixture(),
            observer: new PrincipalRef(new TenantId("tenant-third"), principalId),
            subjectScope: ScopeRef.workspace(foreignTenant, new WorkspaceId("workspace-foreign")),
            crossTenantAuthority: crossBinding
        };
        const decision = admitCrossRunObservation(
            observation,
            [observeAuthority({ scope: ScopeRef.tenant(foreignTenant) })],
            {
                kind: "cross",
                source: foreignTenant,
                target: tenant,
                authority: crossBinding
            }
        );
        expect(refusalReason(decision)).toBe("tenant");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-TENANT] admits a cross-tenant observation holding both authorities",
    { tags: "p0" },
    () => {
        const observation: CrossRunObservation = {
            ...crossRunObservationFixture(),
            subjectScope: ScopeRef.workspace(foreignTenant, new WorkspaceId("workspace-foreign")),
            crossTenantAuthority: crossBinding
        };
        const decision = admitCrossRunObservation(
            observation,
            [observeAuthority({ scope: ScopeRef.tenant(foreignTenant) })],
            {
                kind: "cross",
                source: foreignTenant,
                target: tenant,
                authority: crossBinding
            }
        );
        expect(admittedGrant(decision).value).toBe(observationGrant.value);
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-INTERVENTION] refuses an observer holding only its observation Grant",
    { tags: "p0" },
    () => {
        const decision = authorizeObservedIntervention(
            crossRunObservationFixture(),
            [observeAuthority()],
            "mutate"
        );
        expect(refusalReason(decision)).toBe("intervention");
        if (decision.kind !== "refused") throw new TypeError("Decision was admitted");
        expect(decision.refusal.explain()).toContain("mutate");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-INTERVENTION] refuses an intervention laundered through a widened observation Grant",
    { tags: "p0" },
    () => {
        const observation = crossRunObservationFixture();
        const widened = [observeAuthority({ impacts: ["observe", "mutate", "delegate"] })];
        expect(admittedGrant(admitCrossRunObservation(observation, widened, sameTenant)).value).toBe(
            observationGrant.value
        );
        expect(refusalReason(authorizeObservedIntervention(observation, widened, "mutate"))).toBe(
            "intervention"
        );
        expect(refusalReason(authorizeObservedIntervention(observation, widened, "delegate"))).toBe(
            "intervention"
        );
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-INTERVENTION] admits an intervention backed by a separate Grant of that impact",
    { tags: "p0" },
    () => {
        const steering = new GrantId("grant-steer");
        const decision = authorizeObservedIntervention(
            crossRunObservationFixture(),
            [
                observeAuthority(),
                observeAuthority({ grant: steering, impacts: ["mutate"] })
            ],
            "mutate"
        );
        expect(admittedGrant(decision).value).toBe(steering.value);
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-INTERVENTION] refuses a separate Grant that reaches another Run",
    { tags: "p0" },
    () => {
        const decision = authorizeObservedIntervention(
            crossRunObservationFixture(),
            [
                observeAuthority({
                    grant: new GrantId("grant-steer"),
                    impacts: ["mutate"],
                    runs: [observedSubjects[0]]
                })
            ],
            "mutate"
        );
        expect(refusalReason(decision)).toBe("intervention");
    }
);

test(
    "[C13-SUBSCRIPTION-OBSERVATION-INTERVENTION] cannot express observe as an intervention impact",
    { tags: "p0" },
    () => {
        const decision = authorizeObservedIntervention(
            crossRunObservationFixture(),
            [observeAuthority()],
            // @ts-expect-error `observe` is the read the observation already covers, so the
            // intervention signature must refuse it rather than answer it.
            "observe"
        );
        expect(refusalReason(decision)).toBe("intervention");
    }
);

test(
    "[C13-SUBSCRIPTION-COHERENCE-EVIDENCE] decides duplicate from equal arguments digests and names its witnesses",
    { tags: "p0" },
    () => {
        const finding = decideCoherenceFinding(coherenceFindingIdentityFixture(), [
            observedIntentFixture(observedSubjects[0]),
            observedIntentFixture(observedSubjects[1])
        ]);
        expect(finding?.verdict.equals(CoherenceVerdict.duplicate)).toBe(true);
        expect(finding?.witnesses).toHaveLength(1);
        expect(finding?.discriminator).toBeUndefined();
        expect(finding?.witnesses[0]?.left.run.value).toBe(observedSubjects[0].value);
    }
);

test(
    "[C13-SUBSCRIPTION-COHERENCE-EVIDENCE] decides distinct for two Runs that merely resemble each other",
    { tags: "p0" },
    () => {
        const finding = decideCoherenceFinding(coherenceFindingIdentityFixture(), [
            observedIntentFixture(observedSubjects[0]),
            observedIntentFixture(observedSubjects[1], otherDigest)
        ]);
        expect(finding?.verdict.equals(CoherenceVerdict.distinct)).toBe(true);
        expect(finding?.witnesses).toHaveLength(0);
        expect(finding?.discriminator?.left.operation.value).toBe(
            finding?.discriminator?.right.operation.value
        );
        expect(finding?.discriminator?.left.argumentsDigest.value).not.toBe(
            finding?.discriminator?.right.argumentsDigest.value
        );
    }
);

test(
    "[C13-SUBSCRIPTION-COHERENCE-EVIDENCE] makes no determination where nothing resembles anything",
    { tags: "p0" },
    () => {
        expect(
            decideCoherenceFinding(coherenceFindingIdentityFixture(), [
                observedIntentFixture(observedSubjects[0]),
                observedIntentFixture(observedSubjects[1], otherDigest, "facet.test:produce")
            ])
        ).toBeUndefined();
        expect(
            decideCoherenceFinding(coherenceFindingIdentityFixture(), [
                observedIntentFixture(observedSubjects[0])
            ])
        ).toBeUndefined();
    }
);

test(
    "[C13-SUBSCRIPTION-COHERENCE-EVIDENCE] refuses a duplicate finding witnessed by unequal digests",
    { tags: "p0" },
    () => {
        expect(
            () =>
                new CoherenceFinding({
                    ...coherenceFindingIdentityFixture(),
                    verdict: CoherenceVerdict.duplicate,
                    witnesses: [
                        {
                            left: observedIntentFixture(observedSubjects[0]),
                            right: observedIntentFixture(observedSubjects[1], otherDigest)
                        }
                    ]
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new CoherenceFinding({
                    ...coherenceFindingIdentityFixture(),
                    verdict: CoherenceVerdict.duplicate,
                    witnesses: []
                })
        ).toThrow(TypeError);
    }
);

test(
    "[C13-SUBSCRIPTION-COHERENCE-EVIDENCE] refuses a distinct finding discriminated by equal digests",
    { tags: "p0" },
    () => {
        expect(
            () =>
                new CoherenceFinding({
                    ...coherenceFindingIdentityFixture(),
                    verdict: CoherenceVerdict.distinct,
                    witnesses: [],
                    discriminator: {
                        left: observedIntentFixture(observedSubjects[0]),
                        right: observedIntentFixture(observedSubjects[1])
                    }
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new CoherenceFinding({
                    ...coherenceFindingIdentityFixture(),
                    verdict: CoherenceVerdict.distinct,
                    witnesses: []
                })
        ).toThrow(TypeError);
    }
);

test(
    "[C13-SUBSCRIPTION-COHERENCE-EVIDENCE] refuses evidence that is not about the two subject Runs",
    { tags: "p0" },
    () => {
        expect(
            () =>
                new CoherenceFinding({
                    ...coherenceFindingIdentityFixture(),
                    verdict: CoherenceVerdict.duplicate,
                    witnesses: [
                        {
                            left: observedIntentFixture(observedSubjects[0]),
                            right: observedIntentFixture(observedSubjects[0])
                        }
                    ]
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new CoherenceFinding({
                    ...coherenceFindingIdentityFixture(),
                    verdict: CoherenceVerdict.duplicate,
                    witnesses: [
                        {
                            left: observedIntentFixture(observedSubjects[0]),
                            right: observedIntentFixture(
                                observedSubjects[1],
                                "a".repeat(64),
                                "facet.test:produce"
                            )
                        }
                    ]
                })
        ).toThrow(TypeError);
        expect(
            () =>
                new CoherenceFinding({
                    ...coherenceFindingIdentityFixture(),
                    subjects: [observedSubjects[0], observedSubjects[0]],
                    verdict: CoherenceVerdict.duplicate,
                    witnesses: [
                        {
                            left: observedIntentFixture(observedSubjects[0]),
                            right: observedIntentFixture(observedSubjects[0])
                        }
                    ]
                })
        ).toThrow(TypeError);
    }
);

test(
    "[C13-SUBSCRIPTION-COHERENCE-EVIDENCE] round-trips through its codec and rejects an unknown verdict",
    { tags: "p0" },
    () => {
        const finding = coherenceFindingFixture();
        const decoded = CoherenceFinding.decode(CoherenceFinding.encode(finding));
        expect(CoherenceFinding.encode(decoded)).toEqual(CoherenceFinding.encode(finding));
        expect(decoded.observer.equals(principal)).toBe(true);
        expect(decoded.scope.equals(scope)).toBe(true);
        expect(() => CoherenceVerdict.fromData("probable")).toThrow(TypeError);
        expect(() => CoherenceVerdict.fromData(undefined)).toThrow(TypeError);
    }
);

test(
    "[C13-SUBSCRIPTION-COHERENCE-EVIDENCE] refuses a payload carrying anything but identifiers and digests",
    { tags: "p0" },
    () => {
        const payload = findingPayload(coherenceFindingFixture());
        expect(Object.keys(payload).sort()).toEqual([
            "grant",
            "id",
            "observer",
            "scope",
            "subjects",
            "verdict",
            "witnesses"
        ]);
        expect(() =>
            decodeTampered({
                ...payload,
                observedState: { note: "a copy of the observed Run" }
            })
        ).toThrow(AgentCoreError);
    }
);

test(
    "[C13-SUBSCRIPTION-COHERENCE-EVIDENCE] refuses a distinct payload whose discriminator digests are equal",
    { tags: "p0" },
    () => {
        const distinct = decideCoherenceFinding(coherenceFindingIdentityFixture(), [
            observedIntentFixture(observedSubjects[0]),
            observedIntentFixture(observedSubjects[1], otherDigest)
        ]);
        if (distinct === undefined) throw new TypeError("Distinct finding was not decided");
        const payload = findingPayload(distinct);
        const discriminator = payload["discriminator"];
        if (!isJsonObject(discriminator)) throw new TypeError("Discriminator is malformed");
        const right = discriminator["right"];
        if (!isJsonObject(right)) throw new TypeError("Discriminator side is malformed");
        expect(() =>
            decodeTampered({
                ...payload,
                discriminator: {
                    ...discriminator,
                    right: { ...right, argumentsDigest: new Digest("a".repeat(64)).value }
                }
            })
        ).toThrow(AgentCoreError);
    }
);

function findingPayload(finding: CoherenceFinding): { readonly [key: string]: JsonValue } {
    const envelope = decodeCanonicalJson(CoherenceFinding.encode(finding));
    if (!isJsonObject(envelope) || !isJsonObject(envelope["payload"])) {
        throw new TypeError("Coherence finding envelope is malformed");
    }
    return envelope["payload"];
}

function decodeTampered(payload: JsonValue): CoherenceFinding {
    return CoherenceFinding.decode(
        encodeCanonicalJson({
            kind: CoherenceFinding.codec.kind,
            version: {
                major: CoherenceFinding.codec.version.major,
                minor: CoherenceFinding.codec.version.minor
            },
            payload
        })
    );
}
