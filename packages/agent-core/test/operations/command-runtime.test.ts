import { describe, expect, test } from "vitest";
import { JsonSchema, type JsonValue } from "../../src/core";
import {
    BindingName,
    Command,
    FacetPackageId,
    FacetRef,
    FieldMapping,
    FieldMove,
    OperationDescriptor,
    OperationName,
    OperationRef,
    SlotName,
    type Impact
} from "../../src/facets";
import {
    CommandRuntime,
    type CommandInstallation,
    type CommandInstallationTarget
} from "../../src/operations/command-runtime";

const PACKAGE = "acme.tools";
const OPERATION = "render";
const COMPLETION = "rendered";

const numberArguments = new JsonSchema({
    type: "object",
    required: ["value"],
    properties: { value: { type: "number" } },
    additionalProperties: false
});

function target(
    input: JsonSchema,
    name = OPERATION,
    impact: Impact = "mutate"
): CommandInstallationTarget {
    return {
        package: new FacetPackageId(PACKAGE),
        descriptor: new OperationDescriptor(
            new OperationName(name),
            impact,
            input,
            new JsonSchema({ type: "object", additionalProperties: true })
        )
    };
}

function makeCommand(
    init: {
        readonly arguments?: JsonSchema;
        readonly mapping?: FieldMapping;
        readonly completion?: OperationRef;
    } = {}
): Command {
    return new Command({
        name: "render",
        title: "Render",
        arguments: init.arguments ?? numberArguments,
        operation: new OperationRef(`${PACKAGE}:${OPERATION}`),
        binding: new BindingName("tools"),
        surfaces: [new SlotName("palette")],
        ...(init.mapping === undefined ? {} : { mapping: init.mapping }),
        ...(init.completion === undefined ? {} : { completion: init.completion })
    });
}

function installation(
    init: {
        readonly arguments?: JsonSchema;
        readonly mapping?: FieldMapping;
        readonly completion?: OperationRef;
        readonly input?: JsonSchema;
        readonly completionTarget?: CommandInstallationTarget;
    } = {}
): CommandInstallation {
    return {
        contributor: new FacetRef("workspace:tools"),
        command: makeCommand(init),
        target: target(init.input ?? numberArguments),
        ...(init.completionTarget === undefined ? {} : { completion: init.completionTarget })
    };
}

function moves(...entries: readonly (readonly [string, { from: string } | { literal: unknown }])[]): FieldMapping {
    return new FieldMapping(
        entries.map(
            ([to, source]) => new FieldMove(to, source as { from: string })
        )
    );
}

function expectInstallError(candidate: CommandInstallation, code: string, message: RegExp): void {
    expect(() => new CommandRuntime().install(candidate)).toThrowError(
        expect.objectContaining({ code, message: expect.stringMatching(message) })
    );
}

describe("CommandRuntime installation", () => {
    test("returns the identical installed Command for an equal reinstallation and rejects a divergent one", { tags: "p1" }, () => {
        const runtime = new CommandRuntime();
        const first = runtime.install(installation());
        expect(runtime.install(installation())).toBe(first);

        const divergent = installation({
            input: new JsonSchema({
                type: "object",
                required: ["value"],
                properties: { value: { type: "number" } },
                additionalProperties: true
            })
        });
        expect(() => runtime.install(divergent)).toThrowError(
            expect.objectContaining({ code: "protocol.duplicate" })
        );
    });

    test("rejects a target whose package or operation differs from the Command's Operation reference", { tags: "p1" }, () => {
        expectInstallError(
            {
                ...installation(),
                target: {
                    ...target(numberArguments),
                    package: new FacetPackageId("acme.other")
                }
            },
            "operation.missing",
            /does not match its Operation reference/u
        );
        expectInstallError(
            { ...installation(), target: target(numberArguments, "different") },
            "operation.missing",
            /does not match its Operation reference/u
        );
    });

    test("rejects a completion installation the Command never declared", { tags: "p1" }, () => {
        expectInstallError(
            installation({ completionTarget: target(numberArguments, COMPLETION, "observe") }),
            "operation.invalid-input",
            /undeclared completion/u
        );
    });

    test("requires a declared completion to resolve to its exact observe Operation", { tags: "p1" }, () => {
        const completion = new OperationRef(`${PACKAGE}:${COMPLETION}`);
        expectInstallError(
            installation({ completion }),
            "operation.invalid-input",
            /exact observe Operation/u
        );
        expectInstallError(
            installation({
                completion,
                completionTarget: {
                    ...target(numberArguments, COMPLETION, "observe"),
                    package: new FacetPackageId("acme.other")
                }
            }),
            "operation.invalid-input",
            /exact observe Operation/u
        );
        expectInstallError(
            installation({
                completion,
                completionTarget: target(numberArguments, "different", "observe")
            }),
            "operation.invalid-input",
            /exact observe Operation/u
        );
        expectInstallError(
            installation({
                completion,
                completionTarget: target(numberArguments, COMPLETION, "mutate")
            }),
            "operation.invalid-input",
            /exact observe Operation/u
        );
        expect(() =>
            new CommandRuntime().install(
                installation({
                    completion,
                    completionTarget: target(numberArguments, COMPLETION, "observe")
                })
            )
        ).not.toThrow();
    });
});

describe("CommandRuntime mapping validation", () => {
    test("rejects an identity mapping whose argument and input schemas are incompatible", { tags: "p1" }, () => {
        expectInstallError(
            installation({ input: new JsonSchema({ type: "string" }) }),
            "operation.invalid-input",
            /Identity Command mapping is incompatible/u
        );
    });

    test("accepts an identity mapping against a permissive input schema", { tags: "p2" }, () => {
        expect(() =>
            new CommandRuntime().install(installation({ input: new JsonSchema({}) }))
        ).not.toThrow();
        expect(() =>
            new CommandRuntime().install(installation({ input: JsonSchema.any() }))
        ).not.toThrow();
    });

    test("rejects a mapping that writes the same destination twice", { tags: "p1" }, () => {
        expectInstallError(
            installation({
                mapping: moves(["/value", { from: "/value" }], ["/value", { literal: 1 }])
            }),
            "operation.invalid-input",
            /writes \/value more than once/u
        );
    });

    test("rejects a mapping whose destination is absent from the Operation input schema", { tags: "p1" }, () => {
        expectInstallError(
            installation({ mapping: moves(["/missing", { from: "/value" }]) }),
            "operation.invalid-input",
            /target \/missing is absent/u
        );
    });

    test("rejects a literal move whose value the destination schema refuses", { tags: "p1" }, () => {
        expectInstallError(
            installation({ mapping: moves(["/value", { literal: "text" }]) }),
            "operation.invalid-input",
            /literal does not match target \/value/u
        );
    });

    test("rejects a move whose source pointer is absent from the arguments schema", { tags: "p1" }, () => {
        expectInstallError(
            installation({ mapping: moves(["/value", { from: "/missing" }]) }),
            "operation.invalid-input",
            /source \/missing is absent/u
        );
    });

    test("rejects a move between incompatible source and destination schemas", { tags: "p1" }, () => {
        expectInstallError(
            installation({
                arguments: new JsonSchema({
                    type: "object",
                    required: ["value"],
                    properties: { value: { type: "string" } },
                    additionalProperties: false
                }),
                mapping: moves(["/value", { from: "/value" }])
            }),
            "operation.invalid-input",
            /incompatible schemas/u
        );
    });

    test("requires the mapping to produce every required Operation input", { tags: "p1" }, () => {
        expectInstallError(
            installation({
                input: new JsonSchema({
                    type: "object",
                    required: ["value", "extra"],
                    properties: { value: { type: "number" }, extra: { type: "number" } },
                    additionalProperties: false
                }),
                mapping: moves(["/value", { from: "/value" }])
            }),
            "operation.invalid-input",
            /every required Operation input/u
        );
    });

    test("counts a nested destination toward its required root property", { tags: "p2" }, () => {
        expect(() =>
            new CommandRuntime().install(
                installation({
                    input: new JsonSchema({
                        type: "object",
                        required: ["nested"],
                        properties: {
                            nested: {
                                type: "object",
                                properties: { value: { type: "number" } },
                                additionalProperties: false
                            }
                        },
                        additionalProperties: false
                    }),
                    mapping: moves(["/nested/value", { from: "/value" }])
                })
            )
        ).not.toThrow();
    });

    test("covers the whole input with a root destination", { tags: "p2" }, () => {
        expect(() =>
            new CommandRuntime().install(
                installation({ mapping: moves(["", { from: "" }]) })
            )
        ).not.toThrow();
    });

    test("resolves destinations through prefixItems, items, and additionalProperties", { tags: "p2" }, () => {
        const runtime = new CommandRuntime();
        expect(() =>
            runtime.install(
                installation({
                    input: new JsonSchema({
                        type: "object",
                        properties: {
                            tuple: {
                                type: "array",
                                prefixItems: [{ type: "number" }],
                                items: false,
                                minItems: 1
                            },
                            list: { type: "array", items: { type: "number" } },
                            bag: { type: "object", additionalProperties: { type: "number" } }
                        },
                        additionalProperties: false
                    }),
                    mapping: moves(
                        ["/tuple/0", { from: "/value" }],
                        ["/list/3", { from: "/value" }],
                        ["/bag/anything", { from: "/value" }]
                    )
                })
            )
        ).not.toThrow();
        expectInstallError(
            installation({
                input: new JsonSchema({
                    type: "object",
                    properties: { closed: { type: "object", additionalProperties: false } },
                    additionalProperties: false
                }),
                mapping: moves(["/closed/anything", { from: "/value" }])
            }),
            "operation.invalid-input",
            /target \/closed\/anything is absent/u
        );
        expectInstallError(
            installation({
                input: new JsonSchema({
                    type: "object",
                    properties: { flag: { type: "boolean" } },
                    additionalProperties: false
                }),
                mapping: moves(["/flag/deeper", { from: "/value" }])
            }),
            "operation.invalid-input",
            /target \/flag\/deeper is absent/u
        );
    });

    test("rejects unsafe mapping path segments", { tags: "p0" }, () => {
        expectInstallError(
            installation({ mapping: moves(["/constructor", { from: "/value" }]) }),
            "operation.invalid-input",
            /unsafe path segment/u
        );
    });

    test("treats const and enum sources as compatible exactly when the destination accepts their values", { tags: "p1" }, () => {
        const constArguments = new JsonSchema({
            type: "object",
            required: ["value"],
            properties: { value: { type: "number", const: 5 } },
            additionalProperties: false
        });
        expect(() =>
            new CommandRuntime().install(
                installation({
                    arguments: constArguments,
                    mapping: moves(["/value", { from: "/value" }])
                })
            )
        ).not.toThrow();
        expectInstallError(
            installation({
                arguments: new JsonSchema({
                    type: "object",
                    required: ["value"],
                    properties: { value: { type: "string", const: "text" } },
                    additionalProperties: false
                }),
                mapping: moves(["/value", { from: "/value" }])
            }),
            "operation.invalid-input",
            /incompatible schemas/u
        );
        expect(() =>
            new CommandRuntime().install(
                installation({
                    arguments: new JsonSchema({
                        type: "object",
                        required: ["value"],
                        properties: { value: { type: "number", enum: [1, 2] } },
                        additionalProperties: false
                    }),
                    mapping: moves(["/value", { from: "/value" }])
                })
            )
        ).not.toThrow();
        expectInstallError(
            installation({
                arguments: new JsonSchema({
                    type: "object",
                    required: ["value"],
                    properties: { value: { enum: [1, "two"] } },
                    additionalProperties: false
                }),
                mapping: moves(["/value", { from: "/value" }])
            }),
            "operation.invalid-input",
            /incompatible schemas/u
        );
    });

    test("matches literal values against destination const, enum, and every primitive type form", { tags: "p2" }, () => {
        const accepts = (schema: { readonly [key: string]: JsonValue }, literal: JsonValue): void => {
            expect(() =>
                new CommandRuntime().install(
                    installation({
                        input: new JsonSchema({
                            type: "object",
                            properties: { value: { type: "number" }, extra: schema },
                            additionalProperties: false
                        }),
                        mapping: moves(
                            ["/value", { from: "/value" }],
                            ["/extra", { literal }]
                        )
                    })
                )
            ).not.toThrow();
        };
        const refuses = (schema: { readonly [key: string]: JsonValue }, literal: JsonValue): void => {
            expectInstallError(
                installation({
                    input: new JsonSchema({
                        type: "object",
                        properties: { value: { type: "number" }, extra: schema },
                        additionalProperties: false
                    }),
                    mapping: moves(
                        ["/value", { from: "/value" }],
                        ["/extra", { literal }]
                    )
                }),
                "operation.invalid-input",
                /literal does not match target \/extra/u
            );
        };
        accepts({ const: [1] }, [1]);
        refuses({ const: [1] }, [2]);
        accepts({ enum: ["a", "b"] }, "b");
        refuses({ enum: ["a", "b"] }, "c");
        accepts({ type: "array" }, [1]);
        refuses({ type: "array" }, 1);
        accepts({ type: "boolean" }, true);
        accepts({ type: "integer" }, 3);
        refuses({ type: "integer" }, 3.5);
        accepts({ type: "null" }, null);
        refuses({ type: "null" }, 0);
        accepts({ type: "number" }, 3.5);
        accepts({ type: "object" }, { a: 1 });
        refuses({ type: "object" }, [1]);
        accepts({ type: "string" }, "text");
        refuses({ type: "string" }, 1);
    });
});

describe("CommandRuntime binding and invocation", () => {
    test("binds arguments through nested and array pointers into a canonical input", { tags: "p1" }, () => {
        const runtime = new CommandRuntime();
        const command = makeCommand({
            arguments: new JsonSchema({
                type: "object",
                required: ["items", "nested"],
                properties: {
                    items: { type: "array", items: { type: "number" } },
                    nested: {
                        type: "object",
                        required: ["value"],
                        properties: { value: { type: "number" } },
                        additionalProperties: false
                    }
                },
                additionalProperties: false
            }),
            mapping: moves(
                ["/value", { from: "/items/1" }],
                ["/copy/deep", { from: "/nested/value" }],
                ["/kept", { literal: [7, { a: 1 }] }]
            )
        });
        expect(
            runtime.bind(command, { items: [10, 20], nested: { value: 3 } })
        ).toEqual({ value: 20, copy: { deep: 3 }, kept: [7, { a: 1 }] });
    });

    test("rejects binding when a source value or array index is missing", { tags: "p1" }, () => {
        const runtime = new CommandRuntime();
        const arraySchema = new JsonSchema({
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: { type: "number" } } },
            additionalProperties: false
        });
        const outOfBounds = makeCommand({
            arguments: arraySchema,
            mapping: moves(["/value", { from: "/items/5" }])
        });
        expect(() => runtime.bind(outOfBounds, { items: [1] })).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: expect.stringMatching(/array index is out of bounds/u)
            })
        );
        const optional = makeCommand({
            arguments: new JsonSchema({
                type: "object",
                properties: { value: { type: "number" } },
                additionalProperties: false
            }),
            mapping: moves(["/value", { from: "/value" }])
        });
        expect(() => runtime.bind(optional, {})).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: expect.stringMatching(/source \/value is missing/u)
            })
        );
    });

    test("rejects binding through a destination that traverses a non-object value", { tags: "p1" }, () => {
        const runtime = new CommandRuntime();
        const command = makeCommand({
            arguments: numberArguments,
            mapping: moves(
                ["/slot", { from: "/value" }],
                ["/slot/deeper", { from: "/value" }]
            )
        });
        expect(() => runtime.bind(command, { value: 1 })).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: expect.stringMatching(/target \/slot\/deeper is invalid/u)
            })
        );
    });

    test("rejects arguments their schema refuses before applying any mapping", { tags: "p0" }, () => {
        const runtime = new CommandRuntime();
        expect(() => runtime.bind(makeCommand(), { value: "text" })).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: expect.stringMatching(/arguments do not match their schema/u)
            })
        );
    });

    test("only invokes through an installed Command on one of its declared surfaces", { tags: "p0" }, async () => {
        const runtime = new CommandRuntime();
        const installed = runtime.install(installation());
        const events = {
            invoked: async (): Promise<{ id: string }> => ({ id: "event-1" })
        };

        const foreign = new CommandRuntime().install(installation());
        await expect(
            runtime.invoke(foreign, { value: 1 }, { surface: new SlotName("palette") }, events)
        ).rejects.toMatchObject({ code: "facet.inactive" });

        await expect(
            runtime.invoke(installed, { value: 1 }, { surface: new SlotName("sidebar") }, events)
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            message: expect.stringMatching(/not installed for surface/u)
        });

        await expect(
            runtime.invoke(installed, { value: 1 }, { surface: new SlotName("palette") }, events)
        ).resolves.toEqual({ id: "event-1" });
    });

    test("rejects an invocation whose bound input the installed Operation schema refuses", { tags: "p0" }, async () => {
        const runtime = new CommandRuntime();
        const installed = runtime.install(
            installation({
                arguments: new JsonSchema({
                    type: "object",
                    required: ["value"],
                    properties: { value: { type: "number" } },
                    additionalProperties: true
                }),
                input: new JsonSchema({
                    type: "object",
                    required: ["value"],
                    properties: { value: { type: "number" } },
                    additionalProperties: false
                })
            })
        );
        const events = {
            invoked: async (): Promise<{ id: string }> => ({ id: "event-1" })
        };
        await expect(
            runtime.invoke(
                installed,
                { value: 1, extra: true },
                { surface: new SlotName("palette") },
                events
            )
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            message: expect.stringMatching(/does not match the installed Operation schema/u)
        });
    });
});
