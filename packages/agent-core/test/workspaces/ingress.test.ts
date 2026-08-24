import { describe, expect, test } from "vitest";
import {
    Revision,
    SecretRef,
    decodeCanonicalJson,
    encodeCanonicalJson,
    isJsonObject,
    type JsonObject,
    type JsonValue
} from "../../src/core";
import {
    ContributionAttribution,
    FieldMove,
    IngressDeclaration,
    IngressVerification,
    ProvenanceMapping
} from "../../src/facets";
import { ScopeRef, WorkspaceId as IdentityWorkspaceId } from "../../src/identity";
import { IngressEndpoint, IngressEndpointId } from "../../src/workspaces";
import { tenant } from "./fixtures";
import { malformed } from "../helpers/malformed";
import { attribution } from "../w3/slot-store-contract";

const ownScope = ScopeRef.workspace(tenant, new IdentityWorkspaceId("workspace-scope"));

function declared(path = "/hooks/test"): IngressDeclaration {
    return new IngressDeclaration(
        path,
        new IngressVerification("hmac", new SecretRef("env", "provider-test", `secret${path}`)),
        new ProvenanceMapping([new FieldMove("/identity", { literal: "external" })])
    );
}

function endpointFixture(
    suffix = "default",
    init: {
        readonly contribution?: ContributionAttribution;
        readonly retired?: true;
        readonly scope?: ScopeRef;
        readonly path?: string;
    } = {}
): IngressEndpoint {
    return new IngressEndpoint({
        id: new IngressEndpointId(`ingress-${suffix}`),
        revision: Revision.initial(),
        scope: init.scope ?? ownScope,
        declared: declared(init.path ?? `/hooks/${suffix}`),
        contribution: init.contribution,
        retired: init.retired
    });
}

function recordPayload(bytes: Uint8Array): JsonObject {
    const envelope = decodeCanonicalJson(bytes);
    if (!isJsonObject(envelope)) throw new TypeError("Record envelope must be an object");
    const payload = envelope["payload"];
    if (!isJsonObject(payload)) throw new TypeError("Record payload must be an object");
    return payload;
}

/** Re-encodes an endpoint envelope with one payload field replaced. */
function reencoded(bytes: Uint8Array, field: string, value: JsonValue): Uint8Array {
    const payload = recordPayload(bytes);
    return encodeCanonicalJson({
        kind: "workspace.ingress-endpoint",
        version: { major: 1, minor: 0 },
        payload: { ...payload, [field]: value }
    });
}

describe("ingress endpoint record", () => {
    test("[workspace.ingress-endpoint] round-trips byte-identically and encodes attribution and retirement by presence", () => {
        const contribution = attribution("workspace:ingress");
        const contributed = endpointFixture("wire", { contribution });
        const contributedBytes = IngressEndpoint.encode(contributed);
        expect(IngressEndpoint.decode(contributedBytes).contribution?.equals(contribution)).toBe(
            true
        );
        const payload = recordPayload(contributedBytes);
        expect(payload["contribution"]).toEqual(contribution.encodeFields());
        expect(
            Object.hasOwn(
                recordPayload(IngressEndpoint.encode(endpointFixture("direct"))),
                "contribution"
            )
        ).toBe(false);
        expect(Object.hasOwn(payload, "retired")).toBe(false);

        const retired = contributed.retire();
        const retiredBytes = IngressEndpoint.encode(retired);
        const retiredPayload = recordPayload(retiredBytes);
        expect(retiredPayload["retired"]).toBe(true);
        expect(retiredPayload["contribution"]).toEqual(contribution.encodeFields());
        const reopened = IngressEndpoint.decode(retiredBytes);
        expect(reopened.retired).toBe(true);
        expect(reopened.revision.value).toBe(1);
        expect(IngressEndpoint.encode(reopened)).toEqual(retiredBytes);
    });

    test("refuses a non-canonical or halved attribution at construction and decode", () => {
        const live = endpointFixture("shape");
        expect(
            () =>
                new IngressEndpoint({
                    ...live,
                    contribution: malformed<ContributionAttribution>({
                        contributor: "workspace:forged",
                        package: { id: "workspace:forged", version: "1.0.0" }
                    })
                })
        ).toThrow(new TypeError("Ingress endpoint contribution must carry canonical attribution"));

        const bytes = IngressEndpoint.encode(
            endpointFixture("halved", { contribution: attribution("workspace:halved") })
        );
        for (const halved of [
            null,
            "workspace:halved",
            { contributor: "workspace:halved" },
            { package: { id: "halved-package", version: "1.0.0" } },
            { contributor: "workspace:halved", package: {}, extra: true }
        ] as const) {
            expect(() =>
                IngressEndpoint.decode(reencoded(bytes, "contribution", halved))
            ).toThrow();
        }
        expect(() => IngressEndpoint.decode(reencoded(bytes, "retired", false))).toThrow();
    });

    test("retirement is a contributed-only transition that preserves the exact pair", () => {
        const direct = endpointFixture("unattributed");
        expect(() => direct.retire()).toThrow(
            expect.objectContaining({
                code: "protocol.invalid-state",
                message: "Only a contributed Ingress endpoint is retired by withdrawal"
            })
        );

        const contribution = attribution("workspace:retiring");
        const contributed = endpointFixture("retiring", { contribution });
        const retired = contributed.retire();
        expect(retired.revision.value).toBe(contributed.revision.value + 1);
        expect(retired.contribution?.equals(contribution)).toBe(true);
        expect(IngressDeclaration.encode(retired.declared)).toEqual(
            IngressDeclaration.encode(contributed.declared)
        );
        expect(retired.scope.equals(contributed.scope)).toBe(true);
        expect(retired.retired).toBe(true);
        expect(contributed.retired).toBeUndefined();
    });
});
