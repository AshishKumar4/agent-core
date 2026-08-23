import { describe, expect, test } from "vitest";
import {
    Digest,
    JsonSchema,
    SemVer,
    decodeCanonicalJson,
    encodeCanonicalJson,
    type JsonValue
} from "../../src/core";
import { PackageId, PackagePin } from "../../src/definition-references";
import { ContributionAttribution } from "../../src/facets/attribution";
import { CatalogEntry } from "../../src/facets/catalog-entry";
import { Command } from "../../src/facets/command";
import { OperationDescriptor } from "../../src/facets/contribution";
import { BindingName, FacetRef, OperationName, OperationRef, SlotName } from "../../src/facets/id";

const objectSchema = new JsonSchema({ type: "object" });
const goldenPin = new PackagePin(
    new PackageId("acme.codec"),
    new SemVer("1.2.3"),
    new Digest("a".repeat(64)),
    new Digest("b".repeat(64))
);
const goldenAttribution = new ContributionAttribution(new FacetRef("workspace:facet"), goldenPin);

describe("Declarative facet vocabulary [facet.catalog-entry]", () => {
    test("round-trips an operation declaration together with its contribution attribution", () => {
        const entry = operationEntry();
        const encoded = CatalogEntry.encode(entry);
        expect(new TextDecoder().decode(encoded)).toBe(
            '{"kind":"facet.catalog-entry","payload":{"contributor":"workspace:facet","declaration":{"impact":"mutate","input":{"type":"object"},"name":"resize","output":{"type":"object"}},"id":"catalog:decd12dfe217d5a7f412b0cf7feb433e48fc5743928d993de01a0c997e531738","kind":"operation","name":"resize","package":{"codeDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","id":"acme.codec","manifestDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":"1.2.3"}},"version":{"major":1,"minor":0}}'
        );
        const decoded = CatalogEntry.decode(encoded);
        expect(decoded.kind).toBe("operation");
        expect(decoded.name).toBe("resize");
        expect(decoded.origin.key).toBe(entry.origin.key);
        expect(decoded.id.equals(entry.id)).toBe(true);
        expect(decoded.attribution?.equals(goldenAttribution)).toBe(true);
        expect(decoded.declaration instanceof OperationDescriptor).toBe(true);
        expect([...CatalogEntry.encode(decoded)]).toEqual([...encoded]);
    });

    test("round-trips a command declaration the same way", () => {
        const entry = commandEntry();
        const encoded = CatalogEntry.encode(entry);
        expect(new TextDecoder().decode(encoded)).toBe(
            '{"kind":"facet.catalog-entry","payload":{"contributor":"workspace:facet","declaration":{"arguments":{"type":"object"},"binding":"images","name":"resize","operation":"acme.codec:resize","surfaces":["chat.composer"],"title":"Resize image"},"id":"catalog:b051066fc1125356b313fb505a3326dfee0c61c2771526a83d89512c67bf7220","kind":"command","name":"resize","package":{"codeDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","id":"acme.codec","manifestDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":"1.2.3"}},"version":{"major":1,"minor":0}}'
        );
        const decoded = CatalogEntry.decode(encoded);
        expect(decoded.declaration instanceof Command).toBe(true);
        expect(decoded.id.equals(entry.id)).toBe(true);
    });

    test("encodes a host-direct declaration without any attribution field", () => {
        const encoded = CatalogEntry.encode(directEntry());
        expect(new TextDecoder().decode(encoded)).toBe(
            '{"kind":"facet.catalog-entry","payload":{"declaration":{"impact":"mutate","input":{"type":"object"},"name":"resize","output":{"type":"object"}},"id":"catalog:bf5af163e6f0a79a7ab1621698fd92860e6f0f97407205fd5404f75e8577e7fa","kind":"operation","name":"resize"},"version":{"major":1,"minor":0}}'
        );
        const decoded = CatalogEntry.decode(encoded);
        expect(decoded.attribution).toBeUndefined();
        expect(decoded.origin.owner).toBeUndefined();
    });

    test("refuses to decode an unsupported codec major or minor", () => {
        // The payload bytes are the same ones major 1 wrote; only the envelope moves.
        const envelope = decodeEnvelope(operationEntry());
        expect(() =>
            CatalogEntry.decode(
                encodeCanonicalJson({ ...envelope, version: { major: 2, minor: 0 } })
            )
        ).toThrow(/Unsupported facet\.catalog-entry codec major 2/);
        expect(() =>
            CatalogEntry.decode(
                encodeCanonicalJson({ ...envelope, version: { major: 1, minor: 1 } })
            )
        ).toThrow(/Unsupported facet\.catalog-entry codec minor 1/);
    });

    test("[C13-FACET-CONTRIBUTION-ATTRIBUTION] digests the exact source pair into the identity", () => {
        const base = operationEntry();
        // SAFETY: the union holds an operation descriptor here by construction, so this
        // cast only recovers the fields the identity comparison reads.
        const descriptor_ = base.declaration as OperationDescriptor;
        const repinned = new CatalogEntry(
            "operation",
            "resize",
            descriptor_,
            new ContributionAttribution(new FacetRef("workspace:facet"), upgrade(goldenPin))
        );
        const reattributed = new CatalogEntry(
            "operation",
            "resize",
            descriptor_,
            new ContributionAttribution(new FacetRef("workspace:other"), goldenPin)
        );
        // A different release or a different contributor is a different record, never a
        // rewrite of the first under someone else's name.
        expect(repinned.id.equals(base.id)).toBe(false);
        expect(reattributed.id.equals(base.id)).toBe(false);
        expect(directEntry().id.equals(base.id)).toBe(false);
    });

    test("refuses a stored id that does not match its canonical contents", () => {
        const fields = fieldsOf(operationEntry());
        expect(() =>
            CatalogEntry.fromData({ ...fields, id: `catalog:${"0".repeat(64)}` })
        ).toThrow(/does not match its canonical contents/);
        // A tampered pin moves the digest with it, so rewriting a stored record's release
        // in place cannot keep the identity it was stored under.
        expect(() =>
            CatalogEntry.fromData({
                ...fields,
                package: upgrade(goldenPin).toData(),
                id: "not-a-digest"
            })
        ).toThrow(TypeError);
    });

    test("refuses a name, kind, or declaration that do not identify one entry", () => {
        // SAFETY: this entry was built from an operation descriptor, so the cast only
        // recovers its own declared record.
        const descriptor_ = operationEntry().declaration as OperationDescriptor;
        // SAFETY: same union discipline — this entry was built from a Command.
        const command = commandEntry().declaration as Command;
        expect(() => new CatalogEntry("operation", "other", descriptor_, undefined)).toThrow(
            /must be its declaration's own name resize/
        );
        expect(() => new CatalogEntry("command", "resize", descriptor_, undefined)).toThrow(
            /declares a different record/
        );
        expect(() => new CatalogEntry("operation", "resize", command, undefined)).toThrow(
            /declares a different record/
        );
        expect(() =>
            CatalogEntry.fromData({ ...fieldsOf(directEntry()), kind: "macro" })
        ).toThrow(/must be one of operation, command/);
        expect(() =>
            new CatalogEntry("operation", "resize", structuredClone(descriptor_), undefined)
        ).toThrow(TypeError);
        expect(
            () =>
                new CatalogEntry(
                    "operation",
                    "resize",
                    descriptor_,
                    // SAFETY: only a non-ContributionAttribution stand-in reaches the
                    // constructor guard that a materialized entry carries real attribution.
                    structuredClone(goldenAttribution) as never
                )
        ).toThrow(TypeError);
    });

    test("refuses attribution halves written without their pair", () => {
        const fields = fieldsOf(directEntry());
        expect(() => CatalogEntry.fromData({ ...fields, contributor: "workspace:facet" })).toThrow(
            /contributing FacetRef and source Package pin together/
        );
        expect(() => CatalogEntry.fromData({ ...fields, package: goldenPin.toData() })).toThrow(
            /contributing FacetRef and source Package pin together/
        );
    });
});

function operationEntry(): CatalogEntry {
    return new CatalogEntry(
        "operation",
        "resize",
        new OperationDescriptor(new OperationName("resize"), "mutate", objectSchema, objectSchema),
        goldenAttribution
    );
}

function directEntry(): CatalogEntry {
    return new CatalogEntry(
        "operation",
        "resize",
        new OperationDescriptor(new OperationName("resize"), "mutate", objectSchema, objectSchema),
        undefined
    );
}

function commandEntry(): CatalogEntry {
    return new CatalogEntry(
        "command",
        "resize",
        new Command({
            name: "resize",
            title: "Resize image",
            arguments: objectSchema,
            operation: new OperationRef("acme.codec:resize"),
            binding: new BindingName("images"),
            surfaces: [new SlotName("chat.composer")]
        }),
        goldenAttribution
    );
}

function upgrade(pin: PackagePin): PackagePin {
    return new PackagePin(pin.id, new SemVer("2.0.0"), pin.manifestDigest, pin.codeDigest);
}

function fieldsOf(entry: CatalogEntry): { readonly [name: string]: JsonValue } {
    // SAFETY: toData returns FacetData (any JSON value); an entry always encodes to an
    // object, so this cast only restores the map shape the wire format fixes.
    return entry.toData() as { readonly [name: string]: JsonValue };
}

function decodeEnvelope(entry: CatalogEntry): {
    readonly kind: string;
    readonly payload: JsonValue;
} {
    // SAFETY: encode wrote the canonical envelope, so decoding its own bytes yields that
    // envelope shape again; the cast restates it after the JSON round-trip.
    return decodeCanonicalJson(CatalogEntry.encode(entry)) as {
        readonly kind: string;
        readonly payload: JsonValue;
    };
}
