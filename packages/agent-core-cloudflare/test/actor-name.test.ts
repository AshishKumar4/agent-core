import { actorObjectName, locateActorObject, parseActorObjectName } from "../src/index.js";
import { ActorId } from "@agent-core/core";
import { expectOperationalFailure } from "./assertions.js";
import { FakeDurableObjectNamespace, fakeErrors } from "./fakes.js";

describe("Actor object names", () => {
    test("derive the name purely from core identity", () => {
        const identity = { kind: "run" as const, id: new ActorId("a:b/c%20") };
        const name = actorObjectName(identity);

        expect(name).toBe("agent-core:actor:v1:run:a%3Ab%2Fc%2520");
        expect(parseActorObjectName(name)).toEqual(identity);
    });

    test("produce one identical name regardless of any physical placement request", () => {
        const actor = { kind: "workspace" as const, id: new ActorId("42") };
        // The name carries no jurisdiction component, so there is exactly one name for one
        // ActorRef and therefore exactly one authoritative store.
        expect(actorObjectName(actor)).toBe(actorObjectName(actor));
        expect(actorObjectName(actor).split(":")).toHaveLength(5);
    });

    test("encodes Unicode exactly without normalization aliases", () => {
        const composed = actorObjectName({ kind: "run", id: new ActorId("café") });
        const decomposed = actorObjectName({ kind: "run", id: new ActorId("café") });

        expect(composed).not.toBe(decomposed);
        expect(parseActorObjectName(composed).id.value).toBe("caf\u00e9");
        expect(parseActorObjectName(decomposed).id.value).toBe("café");
        expect(() => new ActorId("\ud800")).toThrow(TypeError);
    });

    test("validates complete UTF-16 surrogate pairs in the ID", () => {
        const name = actorObjectName({ kind: "workspace", id: new ActorId("id-\ud83d\ude80") });
        expect(parseActorObjectName(name).id.value).toBe("id-\ud83d\ude80");
        expect(() => new ActorId("\ud800x")).toThrow(TypeError);
        expect(() => new ActorId("x\ud800")).toThrow(TypeError);
        expect(() => new ActorId("\udc00")).toThrow(TypeError);
    });

    test("round-trips every supported actor kind and rejects decoded invalid input", () => {
        const kinds = ["tenant", "workspace", "run", "environment", "slate"] as const;
        for (const kind of kinds) {
            expect(
                parseActorObjectName(actorObjectName({ kind, id: new ActorId(`${kind}-id`) })).kind
            ).toBe(kind);
        }

        expect(() => parseActorObjectName("agent-core:actor:v1:other:id")).toThrow(
            "Actor kind is invalid"
        );
        expect(() => parseActorObjectName("agent-core:actor:v1:run:%E0%A4%A")).toThrow(
            "invalid UTF-8"
        );
    });

    test("rejects empty, oversized, noncanonical, and unsupported names", () => {
        expect(() => actorObjectName({ kind: "" as never, id: new ActorId("id") })).toThrow(
            TypeError
        );
        expect(() =>
            actorObjectName({ kind: "run", id: new ActorId("\ud83d\ude80".repeat(100)) })
        ).toThrow("1024-byte limit");
        expect(() => parseActorObjectName("agent-core:actor:v2:run:id")).toThrow(
            "unsupported version"
        );
        expect(() => parseActorObjectName("agent-core:actor:v1:run:id:eu")).toThrow(
            "malformed or has an unsupported version"
        );
        expect(() => parseActorObjectName("agent-core:actor:v1:run:a%2fb")).toThrow(
            "canonically encoded"
        );
    });

    test("selects one stable namespace object per Actor identity", () => {
        const namespace = new FakeDurableObjectNamespace((name, jurisdiction) => ({
            name,
            jurisdiction
        }));
        const identity = { kind: "workspace" as const, id: new ActorId("42") };
        const name = actorObjectName(identity);
        const first = namespace.get(namespace.idFromName(name));
        const second = namespace.get(namespace.idFromName(name));
        const other = namespace.get(
            namespace.idFromName(actorObjectName({ kind: "workspace", id: new ActorId("43") }))
        );

        expect(first).toBe(second);
        expect(other).not.toBe(first);
    });

    test("selects namespace jurisdiction as physical placement, never as name identity", () => {
        const namespace = new FakeDurableObjectNamespace((name, jurisdiction) => ({
            name,
            jurisdiction
        }));
        const identity = { kind: "run" as const, id: new ActorId("7") };

        const defaultStub = locateActorObject(namespace, identity, fakeErrors);
        expect(defaultStub.jurisdiction).toBeUndefined();
        expect(namespace.selectedJurisdictions).toEqual([]);

        const restrictedStub = locateActorObject(namespace, identity, fakeErrors, {
            namespaceJurisdiction: "fedramp"
        });
        expect(restrictedStub.jurisdiction).toBe("fedramp");
        expect(namespace.selectedJurisdictions).toEqual(["fedramp"]);
        // Same name, different physical object: jurisdiction is placement, which is exactly
        // why resolution must pin one jurisdiction per ActorRef.
        expect(restrictedStub.name).toBe(defaultStub.name);
        expect(restrictedStub).not.toBe(defaultStub);
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
