import { actorObjectName, locateActorObject, parseActorObjectName } from "../src/index.js";
import { ActorId } from "@agent-core/core";
import { expectOperationalFailure } from "./assertions.js";
import { FakeDurableObjectNamespace, fakeErrors } from "./fakes.js";

describe("Actor object names", () => {
    test("round-trips kind, ID, and jurisdiction without delimiter ambiguity", () => {
        const identity = {
            kind: "run" as const,
            id: new ActorId("a:b/c%20"),
            jurisdiction: "eu:west/1"
        };
        const name = actorObjectName(identity);

        expect(name).toBe("agent-core:actor:v1:run:a%3Ab%2Fc%2520:eu%3Awest%2F1");
        expect(parseActorObjectName(name)).toEqual(identity);
        expect(
            actorObjectName({ kind: "run", id: new ActorId("regional:a"), jurisdiction: "b" })
        ).not.toBe(name);
    });

    test("encodes Unicode exactly without normalization aliases", () => {
        const composed = actorObjectName({
            kind: "run",
            id: new ActorId("caf\u00e9"),
            jurisdiction: "\u65e5\u672c"
        });
        const decomposed = actorObjectName({
            kind: "run",
            id: new ActorId("cafe\u0301"),
            jurisdiction: "\u65e5\u672c"
        });

        expect(composed).not.toBe(decomposed);
        expect(parseActorObjectName(composed).id.value).toBe("caf\u00e9");
        expect(parseActorObjectName(decomposed).id.value).toBe("cafe\u0301");
        expect(() => new ActorId("\ud800")).toThrow(TypeError);
    });

    test("validates complete UTF-16 surrogate pairs", () => {
        const name = actorObjectName({
            kind: "workspace",
            id: new ActorId("id-\ud83d\ude80"),
            jurisdiction: "eu"
        });
        expect(parseActorObjectName(name).id.value).toBe("id-\ud83d\ude80");
        expect(() =>
            actorObjectName({
                kind: "run",
                id: new ActorId("id"),
                jurisdiction: "\ud800x"
            })
        ).toThrow(TypeError);
        expect(() =>
            actorObjectName({
                kind: "run",
                id: new ActorId("id"),
                jurisdiction: "x\ud800"
            })
        ).toThrow(TypeError);
        expect(() =>
            actorObjectName({
                kind: "run",
                id: new ActorId("id"),
                jurisdiction: "\ud800\ue000"
            })
        ).toThrow(TypeError);
        expect(() =>
            actorObjectName({
                kind: "run",
                id: new ActorId("id"),
                jurisdiction: "\udc00"
            })
        ).toThrow(TypeError);
    });

    test("round-trips every supported actor kind and rejects decoded invalid input", () => {
        const kinds = ["tenant", "workspace", "run", "environment", "slate"] as const;
        for (const kind of kinds) {
            expect(
                parseActorObjectName(
                    actorObjectName({ kind, id: new ActorId(`${kind}-id`), jurisdiction: "global" })
                ).kind
            ).toBe(kind);
        }

        expect(() => parseActorObjectName("agent-core:actor:v1:other:id:global")).toThrow(
            "Actor kind is invalid"
        );
        expect(() => parseActorObjectName("agent-core:actor:v1:run:%E0%A4%A:global")).toThrow(
            "invalid UTF-8"
        );
    });

    test("rejects empty, oversized, noncanonical, and unsupported names", () => {
        expect(() =>
            actorObjectName({
                kind: "" as never,
                id: new ActorId("id"),
                jurisdiction: "global"
            })
        ).toThrow(TypeError);
        expect(() =>
            actorObjectName({
                kind: "run",
                id: new ActorId("id"),
                jurisdiction: "x".repeat(1024)
            })
        ).toThrow("1024-byte limit");
        expect(() => parseActorObjectName("agent-core:actor:v2:run:id:global")).toThrow(
            "unsupported version"
        );
        expect(() => parseActorObjectName("agent-core:actor:v1:run:a%2fb:global")).toThrow(
            "canonically encoded"
        );
    });

    test("selects stable namespace objects by the complete Actor identity", () => {
        const namespace = new FakeDurableObjectNamespace((name, jurisdiction) => ({
            name,
            jurisdiction
        }));
        const name = actorObjectName({
            kind: "workspace",
            id: new ActorId("42"),
            jurisdiction: "fedramp"
        });
        const first = namespace.get(namespace.idFromName(name));
        const second = namespace.get(namespace.idFromName(name));
        const other = namespace.get(
            namespace.idFromName(
                actorObjectName({
                    kind: "workspace",
                    id: new ActorId("42"),
                    jurisdiction: "global"
                })
            )
        );

        expect(first).toBe(second);
        expect(other).not.toBe(first);
    });

    test("selects namespace jurisdiction separately from name identity data", () => {
        const namespace = new FakeDurableObjectNamespace((name, jurisdiction) => ({
            name,
            jurisdiction
        }));
        const identity = {
            kind: "run" as const,
            id: new ActorId("7"),
            jurisdiction: "identity-region"
        };

        const defaultStub = locateActorObject(namespace, identity, fakeErrors);
        expect(defaultStub.jurisdiction).toBeUndefined();
        expect(namespace.selectedJurisdictions).toEqual([]);
        expect(parseActorObjectName(defaultStub.name).jurisdiction).toBe("identity-region");

        const restrictedStub = locateActorObject(namespace, identity, fakeErrors, {
            namespaceJurisdiction: "fedramp"
        });
        expect(restrictedStub.jurisdiction).toBe("fedramp");
        expect(namespace.selectedJurisdictions).toEqual(["fedramp"]);
        expect(restrictedStub.name).toBe(defaultStub.name);
        expect(() =>
            locateActorObject(namespace, identity, fakeErrors, { namespaceJurisdiction: "" })
        ).toThrow(TypeError);
        expectOperationalFailure(
            () =>
                locateActorObject(
                    {
                        idFromName(): never {
                            throw new TypeError("platform");
                        },
                        get: () => ({}),
                        jurisdiction(): never {
                            throw new TypeError("unexpected jurisdiction selection");
                        }
                    },
                    identity,
                    fakeErrors
                ),
            "protocol.invalid-state"
        );
    });
});
