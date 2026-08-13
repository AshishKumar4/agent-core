import { describe, expect, test } from "vitest";
import { Digest, decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { BindingName } from "../../src/facets";
import { TenantId } from "../../src/identity";
import { AuditRecordId } from "../../src/interaction-references";
import { requireObject } from "../../src/workspaces/codec";
import {
    AuthenticatedRouteProjection,
    RouteDelivery,
    RouteDeliveryState,
    RouteProjection,
    RouteProjectionAuthenticator,
    RouteReservation,
    requireAuthenticatedRouteProjection,
    routeProjectionEnvelopeBytes
} from "../../src/workspaces/route";
import { principal, projectionFixture, reservationFixture, tenant } from "./fixtures";

class VerdictAuthenticator extends RouteProjectionAuthenticator {
    public constructor(private readonly verdict: boolean) {
        super();
    }

    protected verify(): boolean {
        return this.verdict;
    }
}

class MutatingVerifierAuthenticator extends RouteProjectionAuthenticator {
    protected verify(message: Uint8Array, evidence: Uint8Array): boolean {
        message.fill(0);
        evidence.fill(0);
        return true;
    }
}

describe("route record mutation kills", () => {
    test("route reservation codec cites each tampered field with its exact label", { tags: "p2" }, () => {
        const encoded = RouteReservation.encode(reservationFixture("codec-label"));
        const cases: readonly {
            readonly patch: { readonly [key: string]: JsonValue };
            readonly message: string;
        }[] = [
            { patch: { id: 5 }, message: "Route reservation ID must be a string" },
            { patch: { invocation: 5 }, message: "Route invocation ID must be a string" },
            { patch: { event: 5 }, message: "Route Event ID must be a string" },
            {
                patch: { sourceAuditCause: 5 },
                message: "Route source audit cause must be a string"
            },
            { patch: { subscription: 5 }, message: "Route Subscription ID must be a string" },
            { patch: { dedupeKey: 5 }, message: "Route dedupe key must be a string" },
            { patch: { operation: 5 }, message: "Route operation must be a string" },
            { patch: { projection: 5 }, message: "Route projection ID must be a string" },
            {
                patch: { projectionContent: 5 },
                message: "Route projection content must be an object"
            },
            { patch: { initiator: 5 }, message: "Route initiator must be an object" },
            { patch: { sourceActor: 5 }, message: "Route source Actor must be an object" },
            { patch: { targetActor: 5 }, message: "Route target Actor must be an object" },
            {
                patch: { authority: { kind: "initiator", binding: 5 } },
                message: "Route binding must be a string"
            },
            {
                patch: { tenants: { kind: "same", tenant: 5 } },
                message: "Route tenant must be a string"
            }
        ];
        for (const { patch, message } of cases) {
            expect(() => RouteReservation.decode(withPayload(encoded, patch))).toThrow(
                expect.objectContaining({ message: reservationDecodeError(message) })
            );
        }

        const cross = RouteReservation.encode(crossReservation("codec-label-cross"));
        const crossCases: readonly {
            readonly patch: { readonly [key: string]: JsonValue };
            readonly message: string;
        }[] = [
            {
                patch: {
                    tenants: {
                        kind: "cross",
                        source: 5,
                        target: "tenant-cross-target",
                        authority: "binding.cross"
                    }
                },
                message: "Route source tenant must be a string"
            },
            {
                patch: {
                    tenants: {
                        kind: "cross",
                        source: tenant.value,
                        target: 5,
                        authority: "binding.cross"
                    }
                },
                message: "Route target tenant must be a string"
            },
            {
                patch: {
                    tenants: {
                        kind: "cross",
                        source: tenant.value,
                        target: "tenant-cross-target",
                        authority: 5
                    }
                },
                message: "Cross-tenant authority must be a string"
            }
        ];
        for (const { patch, message } of crossCases) {
            expect(() => RouteReservation.decode(withPayload(cross, patch))).toThrow(
                expect.objectContaining({ message: reservationDecodeError(message) })
            );
        }
    });

    test(
        "route projection and delivery codecs cite tampered identifiers exactly",
        { tags: "p2" },
        () => {
            const projection = projectionFixture(reservationFixture("projection-codec-label"));
            const encodedProjection = RouteProjection.encode(projection);
            const projectionCases: readonly {
                readonly patch: { readonly [key: string]: JsonValue };
                readonly message: string;
            }[] = [
                { patch: { content: 5 }, message: "Route projection content must be an object" },
                { patch: { id: 5 }, message: "Route projection ID must be a string" },
                { patch: { reservation: 5 }, message: "Projection reservation ID must be a string" }
            ];
            for (const { patch, message } of projectionCases) {
                expect(() => RouteProjection.decode(withPayload(encodedProjection, patch))).toThrow(
                    expect.objectContaining({
                        message: `Invalid workspace.route-projection record: ${message}`
                    })
                );
            }

            const encodedDelivery = RouteDelivery.encode(
                new RouteDelivery({
                    reservation: reservationFixture("delivery-codec-label").id,
                    state: RouteDeliveryState.delivered(),
                    targetAudit: new AuditRecordId("audit-delivery-codec-label")
                })
            );
            const deliveryCases: readonly {
                readonly patch: { readonly [key: string]: JsonValue };
                readonly message: string;
            }[] = [
                { patch: { reservation: 5 }, message: "Delivery reservation ID must be a string" },
                { patch: { targetAudit: 5 }, message: "Delivery target audit must be a string" }
            ];
            for (const { patch, message } of deliveryCases) {
                expect(() => RouteDelivery.decode(withPayload(encodedDelivery, patch))).toThrow(
                    expect.objectContaining({
                        message: `Invalid workspace.route-delivery record: ${message}`
                    })
                );
            }
        }
    );

    test(
        "route delivery decode enforces outcome and reason parity with an exact diagnostic",
        { tags: "p1" },
        () => {
            const encoded = RouteDelivery.encode(
                new RouteDelivery({
                    reservation: reservationFixture("delivery-parity").id,
                    state: RouteDeliveryState.delivered(),
                    targetAudit: new AuditRecordId("audit-delivery-parity")
                })
            );
            const message =
                "Invalid workspace.route-delivery record: " +
                "Route delivery reason does not match its terminal outcome";
            expect(() => RouteDelivery.decode(withPayload(encoded, { reason: "late" }))).toThrow(
                expect.objectContaining({ message })
            );
            expect(() =>
                RouteDelivery.decode(withPayload(encoded, { outcome: "rejected" }))
            ).toThrow(expect.objectContaining({ message }));
        }
    );

    test("route delivery states compare by terminal kind and rejection reason", { tags: "p0" }, () => {
        const delivered = RouteDeliveryState.delivered();
        const rejected = RouteDeliveryState.rejected("authority denied");
        expect(delivered.equals(RouteDeliveryState.delivered())).toBe(true);
        expect(delivered.equals(rejected)).toBe(false);
        expect(rejected.equals(delivered)).toBe(false);
        expect(rejected.equals(RouteDeliveryState.rejected("authority denied"))).toBe(true);
        expect(rejected.equals(RouteDeliveryState.rejected("lease expired"))).toBe(false);
    });

    test(
        "projection authentication denials carry the authority code and exact reasons",
        { tags: "p0" },
        () => {
            const reservation = reservationFixture("auth-denial");
            const projection = projectionFixture(reservation);
            expect(() =>
                new VerdictAuthenticator(false).authenticate(
                    { reservation, projection },
                    new Uint8Array([1])
                )
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Route projection authentication failed"
                })
            );

            const asserted = projection.authenticate(
                Digest.sha256(new TextEncoder().encode("source-assertion"))
            );
            expect(() =>
                new VerdictAuthenticator(true).authenticate(
                    { reservation, projection: asserted },
                    new Uint8Array([1])
                )
            ).toThrow(
                expect.objectContaining({
                    code: "authority.denied",
                    message: "Source projection cannot assert target authentication"
                })
            );
        }
    );

    test("authentication isolates verifier input from caller evidence", { tags: "p0" }, () => {
        const reservation = reservationFixture("mutating-verifier");
        const projection = projectionFixture(reservation);
        const authenticator = new MutatingVerifierAuthenticator();
        const evidence = new Uint8Array([7, 8, 9]);

        const first = authenticator.authenticate({ reservation, projection }, evidence);
        expect(first).toBeInstanceOf(AuthenticatedRouteProjection);
        expect(Array.from(evidence)).toEqual([7, 8, 9]);

        const second = authenticator.authenticate({ reservation, projection }, evidence);
        expect(Array.from(evidence)).toEqual([7, 8, 9]);
        expect(second.digest.equals(first.digest)).toBe(true);
    });

    test(
        "projection envelope bytes bind the versioned route projection domain",
        { tags: "p0" },
        () => {
            const reservation = reservationFixture("envelope-domain");
            const bytes = routeProjectionEnvelopeBytes({
                reservation,
                projection: projectionFixture(reservation)
            });
            const decoded = requireObject(
                decodeCanonicalJson(bytes),
                "Projection envelope payload"
            );
            expect(decoded["domain"]).toBe("agent-core.route-projection.v1");
        }
    );

    test(
        "[C13-ADV-MISSING-CROSS-TENANT-BINDING] a cross-tenant relation without its authority Binding does not decode",
        { tags: "p0" },
        () => {
            const encoded = RouteReservation.encode(crossReservation("missing-cross-binding"));
            const decoded = RouteReservation.decode(encoded);
            expect(
                decoded.tenants.kind === "cross" ? decoded.tenants.authority.value : undefined
            ).toBe("binding.cross");
            expect(() =>
                RouteReservation.decode(
                    withPayload(encoded, {
                        tenants: {
                            kind: "cross",
                            source: tenant.value,
                            target: "tenant-cross-target"
                        }
                    })
                )
            ).toThrow(
                expect.objectContaining({
                    message: reservationDecodeError(
                        "Cross-tenant relation contains missing or unknown fields"
                    )
                })
            );
        }
    );

    test("reservation codec round-trips initiator presence exactly", { tags: "p1" }, () => {
        const decodedCross = RouteReservation.decode(
            RouteReservation.encode(crossReservation("initiator-absent"))
        );
        expect(decodedCross.initiator).toBeUndefined();
        expect(Object.hasOwn(decodedCross.init, "initiator")).toBe(false);

        const decoded = RouteReservation.decode(
            RouteReservation.encode(reservationFixture("initiator-present"))
        );
        expect(decoded.initiator?.equals(principal)).toBe(true);
    });
});

function reservationDecodeError(message: string): string {
    return `Invalid workspace.route-reservation record: ${message}`;
}

function withPayload(
    bytes: Uint8Array,
    patch: { readonly [key: string]: JsonValue }
): Uint8Array {
    const envelope = requireObject(decodeCanonicalJson(bytes), "Encoded record envelope");
    const payload = requireObject(envelope["payload"] ?? null, "Encoded record payload");
    return encodeCanonicalJson({ ...envelope, payload: { ...payload, ...patch } });
}

function crossReservation(suffix: string): RouteReservation {
    const { initiator: _initiator, ...rest } = reservationFixture(suffix).init;
    return new RouteReservation({
        ...rest,
        tenants: {
            kind: "cross",
            source: tenant,
            target: new TenantId("tenant-cross-target"),
            authority: new BindingName("binding.cross")
        },
        authority: { kind: "delegated", binding: new BindingName("binding.delegated") },
        trust: "external"
    });
}

describe("authenticated projection provenance", () => {
    test("a prototype-forged projection lacks host authentication", { tags: "p0" }, () => {
        // SAFETY: Object.create returns a bare prototype instance the constructor never
        // ran on, so it carries none of the host authentication. Only a value that passes
        // `instanceof` while lacking that evidence reaches the guard under test.
        const forged = Object.create(
            AuthenticatedRouteProjection.prototype
        ) as AuthenticatedRouteProjection;
        expect(() => requireAuthenticatedRouteProjection(forged)).toThrow(
            expect.objectContaining({ name: "AgentCoreError", code: "authority.denied" })
        );
    });
});
