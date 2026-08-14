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
    enforcementFloor,
    type FacetData,
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
        readonly name?: string;
        readonly mapping?: FieldMapping;
        readonly completion?: OperationRef;
        readonly surfaces?: readonly SlotName[];
    } = {}
): Command {
    return new Command({
        name: init.name ?? "render",
        title: "Render",
        arguments: init.arguments ?? numberArguments,
        operation: new OperationRef(`${PACKAGE}:${OPERATION}`),
        binding: new BindingName("tools"),
        surfaces: init.surfaces ?? [new SlotName("palette")],
        mapping: init.mapping,
        completion: init.completion
    });
}

function installation(
    init: {
        readonly arguments?: JsonSchema;
        readonly name?: string;
        readonly mapping?: FieldMapping;
        readonly completion?: OperationRef;
        readonly input?: JsonSchema;
        readonly completionTarget?: CommandInstallationTarget;
        readonly contributor?: FacetRef;
        readonly surfaces?: readonly SlotName[];
    } = {}
): CommandInstallation {
    const required = {
        contributor: init.contributor ?? new FacetRef("workspace:tools"),
        command: makeCommand(init),
        target: target(init.input ?? numberArguments)
    };
    return init.completionTarget === undefined
        ? required
        : { ...required, completion: init.completionTarget };
}

/**
 * A single-move installation that exercises exactly one source/destination schema pair,
 * so a compatibility outcome cannot be reached through some other property.
 */
function compatibility(source: JsonValue, destination: JsonValue): CommandInstallation {
    return installation({
        arguments: new JsonSchema({
            type: "object",
            required: ["carry"],
            properties: { carry: source },
            additionalProperties: false
        }),
        input: new JsonSchema({
            type: "object",
            properties: { slot: destination },
            additionalProperties: false
        }),
        mapping: moves(["/slot", { from: "/carry" }])
    });
}

function expectCompatible(source: JsonValue, destination: JsonValue): void {
    expect(() => new CommandRuntime().install(compatibility(source, destination))).not.toThrow();
}

function expectIncompatible(source: JsonValue, destination: JsonValue): void {
    expectInstallError(
        compatibility(source, destination),
        "operation.invalid-input",
        /Command mapping \/carry to \/slot has incompatible schemas/u
    );
}

function moves(
    ...entries: readonly (readonly [string, { from: string } | { literal: FacetData }])[]
): FieldMapping {
    return new FieldMapping(entries.map(([to, source]) => new FieldMove(to, source)));
}

function expectInstallError(candidate: CommandInstallation, code: string, message: RegExp): void {
    expect(() => new CommandRuntime().install(candidate)).toThrowError(
        expect.objectContaining({ code, message: expect.stringMatching(message) })
    );
}

describe("CommandRuntime installation", () => {
    test(
        "returns the identical installed Command for an equal reinstallation and rejects a divergent one",
        { tags: "p1" },
        () => {
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
        }
    );

    test(
        "refuses to hand an installed Command to a different contributor in the same scope",
        { tags: "p0" },
        () => {
            const runtime = new CommandRuntime();
            const installed = runtime.install(installation());
            expect(() =>
                runtime.install(installation({ contributor: new FacetRef("workspace:other") }))
            ).toThrowError(
                expect.objectContaining({
                    code: "protocol.duplicate",
                    message:
                        "Command acme.tools:render conflicts with an installed command in workspace"
                })
            );
            expect(runtime.install(installation())).toBe(installed);
        }
    );

    test(
        "[C13-COMMAND-COLLISION] keeps NUL-bearing surface and Command name tuples distinct within one scope",
        { tags: "p0" },
        () => {
            const runtime = new CommandRuntime();
            const scope = "workspace";
            const firstSurface = new SlotName("left");
            const firstName = "right\0tail";
            const secondSurface = new SlotName("left\0right");
            const secondName = "tail";

            expect(`${scope}\0${firstSurface.value}\0${firstName}`).toBe(
                `${scope}\0${secondSurface.value}\0${secondName}`
            );

            const first = runtime.install(
                installation({ name: firstName, surfaces: [firstSurface] })
            );
            const second = runtime.install(
                installation({ name: secondName, surfaces: [secondSurface] })
            );

            expect(first.command.name).toBe(firstName);
            expect(second.command.name).toBe(secondName);
        }
    );

    test(
        "rejects a target whose package or operation differs from the Command's Operation reference",
        { tags: "p1" },
        () => {
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
        }
    );

    test("rejects a completion installation the Command never declared", { tags: "p1" }, () => {
        expectInstallError(
            installation({ completionTarget: target(numberArguments, COMPLETION, "observe") }),
            "operation.invalid-input",
            /undeclared completion/u
        );
    });

    test(
        "requires a declared completion to resolve to its exact observe Operation",
        { tags: "p1" },
        () => {
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
        }
    );

    test(
        "[C13-COMMAND-COMPLETION-IMPACT] admits a completion only at the impact that floors to direct",
        { tags: "p1" },
        () => {
            const completion = new OperationRef(`${PACKAGE}:${COMPLETION}`);
            // Every impact but `observe` is refused, named one at a time: a completion
            // admitted at any of them is a completion that leaves the direct tier.
            for (const impact of ["execute", "mutate", "externalSend", "delegate"] as const) {
                expectInstallError(
                    installation({
                        completion,
                        completionTarget: target(numberArguments, COMPLETION, impact)
                    }),
                    "operation.invalid-input",
                    /exact observe Operation/u
                );
            }
            const admitted = new CommandRuntime().install(
                installation({
                    completion,
                    completionTarget: target(numberArguments, COMPLETION, "observe")
                })
            );
            expect(admitted.command.completion?.operation.value).toBe(COMPLETION);

            // The refusal above and this floor are the two halves of one rule, and the
            // rule is the composition: install-time screening is only worth anything
            // because `observe` is the impact §7.2 floors to `direct`. Argument
            // completion runs per keystroke, so an impact that floored to `mediated`
            // would put a durable Invocation behind every one of them.
            for (const impact of ["observe", "execute", "mutate", "externalSend"] as const) {
                expect(enforcementFloor(impact, false, false)).toBe(
                    impact === "observe" ? "direct" : "mediated"
                );
            }
        }
    );
});

describe("CommandRuntime mapping validation", () => {
    test(
        "rejects an identity mapping whose argument and input schemas are incompatible",
        { tags: "p1" },
        () => {
            expectInstallError(
                installation({ input: new JsonSchema({ type: "string" }) }),
                "operation.invalid-input",
                /Identity Command mapping is incompatible/u
            );
        }
    );

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

    test(
        "rejects a mapping whose destination is absent from the Operation input schema",
        { tags: "p1" },
        () => {
            expectInstallError(
                installation({ mapping: moves(["/missing", { from: "/value" }]) }),
                "operation.invalid-input",
                /target \/missing is absent/u
            );
        }
    );

    test(
        "rejects a literal move whose value the destination schema refuses",
        { tags: "p1" },
        () => {
            expectInstallError(
                installation({ mapping: moves(["/value", { literal: "text" }]) }),
                "operation.invalid-input",
                /literal does not match target \/value/u
            );
        }
    );

    test(
        "rejects a move whose source pointer is absent from the arguments schema",
        { tags: "p1" },
        () => {
            expectInstallError(
                installation({ mapping: moves(["/value", { from: "/missing" }]) }),
                "operation.invalid-input",
                /source \/missing is absent/u
            );
        }
    );

    test(
        "rejects a move between incompatible source and destination schemas",
        { tags: "p1" },
        () => {
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
        }
    );

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
            new CommandRuntime().install(installation({ mapping: moves(["", { from: "" }]) }))
        ).not.toThrow();
    });

    test(
        "resolves destinations through prefixItems, items, and additionalProperties",
        { tags: "p2" },
        () => {
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
        }
    );

    test(
        "resolves boolean destination sub-schemas instead of reporting them absent",
        { tags: "p1" },
        () => {
            expect(() =>
                new CommandRuntime().install(
                    installation({
                        input: new JsonSchema({
                            type: "object",
                            properties: { value: { type: "number" }, open: true },
                            additionalProperties: false
                        }),
                        mapping: moves(["/open", { from: "/value" }])
                    })
                )
            ).not.toThrow();
            expectInstallError(
                installation({
                    input: new JsonSchema({
                        type: "object",
                        properties: { value: { type: "number" }, blocked: false },
                        additionalProperties: false
                    }),
                    mapping: moves(["/blocked", { from: "/value" }])
                }),
                "operation.invalid-input",
                /Command mapping \/value to \/blocked has incompatible schemas/u
            );
        }
    );

    test(
        "treats an argument sub-schema of false as compatible with any destination",
        { tags: "p1" },
        () => {
            expect(() =>
                new CommandRuntime().install(
                    installation({
                        arguments: new JsonSchema({
                            type: "object",
                            required: ["value"],
                            properties: { value: { type: "number" }, never: false },
                            additionalProperties: false
                        }),
                        mapping: moves(["/value", { from: "/never" }])
                    })
                )
            ).not.toThrow();
        }
    );

    test(
        "requires an unconstrained argument sub-schema of true to equal its destination",
        { tags: "p1" },
        () => {
            expectCompatible(true, true);
            expectIncompatible(true, {});
            expectIncompatible(true, { type: "number" });
        }
    );

    test(
        "resolves numeric destination segments past prefixItems, through items and additionalProperties",
        { tags: "p1" },
        () => {
            const runtime = new CommandRuntime();
            const arrayInput = new JsonSchema({
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
            });
            expect(() =>
                runtime.install(
                    installation({
                        input: arrayInput,
                        mapping: moves(
                            ["/tuple/0", { from: "/value" }],
                            ["/list/12", { from: "/value" }],
                            ["/bag/0", { from: "/value" }]
                        )
                    })
                )
            ).not.toThrow();
            expectInstallError(
                installation({
                    input: arrayInput,
                    mapping: moves(["/tuple/1", { from: "/value" }])
                }),
                "operation.invalid-input",
                /Command mapping \/value to \/tuple\/1 has incompatible schemas/u
            );
            for (const segment of ["name", "1x", "x1"]) {
                expectInstallError(
                    installation({
                        input: arrayInput,
                        mapping: moves([`/list/${segment}`, { from: "/value" }])
                    }),
                    "operation.invalid-input",
                    new RegExp(`target /list/${segment} is absent`, "u")
                );
            }
        }
    );

    test(
        "compares argument and destination schemas by type, const, and enum",
        { tags: "p1" },
        () => {
            expectCompatible({ minimum: 0 }, { minimum: 0 });
            expectCompatible({ const: 5 }, { minimum: 0 });
            expectCompatible({ enum: [1, 2] }, { minimum: 0 });
            expectCompatible({ type: "number", minimum: 0 }, { type: "number" });
            expectIncompatible({ enum: [1, 2] }, { const: 1 });
            expectIncompatible({ type: "number" }, { maximum: 5 });
            expectIncompatible({ minimum: 0 }, { maximum: 5 });
            expectIncompatible({ type: "number", const: 5 }, { type: "number", const: 7 });
        }
    );

    test(
        "checks literal moves against boolean and byte-exact destination schemas",
        { tags: "p1" },
        () => {
            const literalInput = new JsonSchema({
                type: "object",
                properties: {
                    open: true,
                    blocked: false,
                    exact: { const: 1 },
                    flag: { type: "boolean" }
                },
                additionalProperties: false
            });
            expect(() =>
                new CommandRuntime().install(
                    installation({ input: literalInput, mapping: moves(["/open", { literal: 1 }]) })
                )
            ).not.toThrow();
            for (const [destination, literal] of [
                ["blocked", 1],
                ["exact", 12],
                ["flag", 1]
            ] as const) {
                expectInstallError(
                    installation({
                        input: literalInput,
                        mapping: moves([`/${destination}`, { literal }])
                    }),
                    "operation.invalid-input",
                    new RegExp(`Command mapping literal does not match target /${destination}`, "u")
                );
            }
        }
    );

    test(
        "escapes tilde and slash property names on both sides of the required-coverage check",
        { tags: "p1" },
        () => {
            expect(() =>
                new CommandRuntime().install(
                    installation({
                        input: new JsonSchema({
                            type: "object",
                            required: ["a~b", "c/d"],
                            properties: { "a~b": { type: "number" }, "c/d": { type: "number" } },
                            additionalProperties: false
                        }),
                        mapping: moves(["/a~0b", { from: "/value" }], ["/c~1d", { from: "/value" }])
                    })
                )
            ).not.toThrow();
        }
    );

    test("accepts a required input covered by one of several destinations", { tags: "p1" }, () => {
        expect(() =>
            new CommandRuntime().install(
                installation({
                    input: new JsonSchema({
                        type: "object",
                        required: ["value"],
                        properties: { value: { type: "number" }, extra: { type: "number" } },
                        additionalProperties: false
                    }),
                    mapping: moves(["/value", { from: "/value" }], ["/extra", { literal: 1 }])
                })
            )
        ).not.toThrow();
    });

    test(
        "covers a boolean Operation input document only when it admits values",
        { tags: "p1" },
        () => {
            expect(() =>
                new CommandRuntime().install(
                    installation({ input: new JsonSchema(true), mapping: new FieldMapping([]) })
                )
            ).not.toThrow();
            expectInstallError(
                installation({ input: new JsonSchema(false), mapping: new FieldMapping([]) }),
                "operation.invalid-input",
                /does not produce every required Operation input/u
            );
        }
    );

    test("rejects unsafe mapping path segments", { tags: "p0" }, () => {
        expectInstallError(
            installation({ mapping: moves(["/constructor", { from: "/value" }]) }),
            "operation.invalid-input",
            /unsafe path segment/u
        );
    });

    test(
        "treats const and enum sources as compatible exactly when the destination accepts their values",
        { tags: "p1" },
        () => {
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
        }
    );

    test(
        "matches literal values against destination const, enum, and every primitive type form",
        { tags: "p2" },
        () => {
            const accepts = (
                schema: { readonly [key: string]: JsonValue },
                literal: JsonValue
            ): void => {
                expect(() =>
                    new CommandRuntime().install(
                        installation({
                            input: new JsonSchema({
                                type: "object",
                                properties: { value: { type: "number" }, extra: schema },
                                additionalProperties: false
                            }),
                            mapping: moves(["/value", { from: "/value" }], ["/extra", { literal }])
                        })
                    )
                ).not.toThrow();
            };
            const refuses = (
                schema: { readonly [key: string]: JsonValue },
                literal: JsonValue
            ): void => {
                expectInstallError(
                    installation({
                        input: new JsonSchema({
                            type: "object",
                            properties: { value: { type: "number" }, extra: schema },
                            additionalProperties: false
                        }),
                        mapping: moves(["/value", { from: "/value" }], ["/extra", { literal }])
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
            refuses({ type: "boolean" }, 1);
            accepts({ type: "integer" }, 3);
            refuses({ type: "integer" }, 3.5);
            accepts({ type: "null" }, null);
            refuses({ type: "null" }, 0);
            accepts({ type: "number" }, 3.5);
            accepts({ type: "object" }, { a: 1 });
            refuses({ type: "object" }, [1]);
            refuses({ type: "object" }, null);
            refuses({ type: "object" }, "text");
            accepts({ type: "string" }, "text");
            refuses({ type: "string" }, 1);
        }
    );
});

describe("CommandRuntime binding and invocation", () => {
    test(
        "binds arguments through nested and array pointers into a canonical input",
        { tags: "p1" },
        () => {
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
            expect(runtime.bind(command, { items: [10, 20], nested: { value: 3 } })).toEqual({
                value: 20,
                copy: { deep: 3 },
                kept: [7, { a: 1 }]
            });
        }
    );

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

    test(
        "rejects binding through a destination that traverses a non-object value",
        { tags: "p1" },
        () => {
            const runtime = new CommandRuntime();
            const command = makeCommand({
                arguments: numberArguments,
                mapping: moves(["/slot", { from: "/value" }], ["/slot/deeper", { from: "/value" }])
            });
            expect(() => runtime.bind(command, { value: 1 })).toThrowError(
                expect.objectContaining({
                    code: "operation.invalid-input",
                    message: expect.stringMatching(/target \/slot\/deeper is invalid/u)
                })
            );
        }
    );

    test(
        "rejects malformed, boundary, and multi-digit array indexes when binding",
        { tags: "p1" },
        () => {
            const runtime = new CommandRuntime();
            const arraySchema = new JsonSchema({
                type: "object",
                required: ["items"],
                properties: { items: { type: "array", items: { type: "number" } } },
                additionalProperties: false
            });
            const read = (pointer: string, items: readonly number[]): FacetData =>
                runtime.bind(
                    makeCommand({
                        arguments: arraySchema,
                        mapping: moves(["/value", { from: pointer }])
                    }),
                    { items: [...items] }
                );
            const wide = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
            expect(read("/items/12", wide)).toEqual({ value: 12 });
            for (const segment of ["x", "1x", "x1"]) {
                expect(() => read(`/items/${segment}`, [1, 2])).toThrowError(
                    expect.objectContaining({
                        code: "operation.invalid-input",
                        message: "Command mapping array index is invalid"
                    })
                );
            }
            expect(() => read("/items/2", [1, 2])).toThrowError(
                expect.objectContaining({
                    code: "operation.invalid-input",
                    message: "Command mapping array index is out of bounds"
                })
            );
        }
    );

    test("rejects binding whose source pointer traverses a null value", { tags: "p1" }, () => {
        const runtime = new CommandRuntime();
        const command = makeCommand({
            arguments: new JsonSchema({
                type: "object",
                required: ["nested"],
                properties: { nested: {} },
                additionalProperties: false
            }),
            mapping: moves(["/value", { from: "/nested/inner" }])
        });
        expect(() => runtime.bind(command, { nested: null })).toThrowError(
            expect.objectContaining({
                code: "operation.invalid-input",
                message: "Command mapping source /nested/inner is missing"
            })
        );
    });

    test(
        "rejects arguments their schema refuses before applying any mapping",
        { tags: "p0" },
        () => {
            const runtime = new CommandRuntime();
            expect(() => runtime.bind(makeCommand(), { value: "text" })).toThrowError(
                expect.objectContaining({
                    code: "operation.invalid-input",
                    message: expect.stringMatching(/arguments do not match their schema/u)
                })
            );
        }
    );

    test("invokes on every surface the Command declares", { tags: "p0" }, async () => {
        const runtime = new CommandRuntime();
        const surfaces = [new SlotName("palette"), new SlotName("sidebar")];
        const installed = runtime.install(installation({ surfaces }));
        const events = {
            invoked: async (): Promise<{ id: string }> => ({ id: "event-1" })
        };
        for (const surface of surfaces) {
            await expect(
                runtime.invoke(installed, { value: 1 }, { surface }, events)
            ).resolves.toEqual({ id: "event-1" });
        }
        await expect(
            runtime.invoke(installed, { value: 1 }, { surface: new SlotName("tray") }, events)
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            message: "Command acme.tools:render is not installed for surface tray"
        });
    });

    test(
        "only invokes through an installed Command on one of its declared surfaces",
        { tags: "p0" },
        async () => {
            const runtime = new CommandRuntime();
            const installed = runtime.install(installation());
            const events = {
                invoked: async (): Promise<{ id: string }> => ({ id: "event-1" })
            };

            const foreign = new CommandRuntime().install(installation());
            await expect(
                runtime.invoke(foreign, { value: 1 }, { surface: new SlotName("palette") }, events)
            ).rejects.toMatchObject({
                code: "facet.inactive",
                message: "Command acme.tools:render is not installed"
            });

            await expect(
                runtime.invoke(
                    installed,
                    { value: 1 },
                    { surface: new SlotName("sidebar") },
                    events
                )
            ).rejects.toMatchObject({
                code: "operation.invalid-input",
                message: expect.stringMatching(/not installed for surface/u)
            });

            await expect(
                runtime.invoke(
                    installed,
                    { value: 1 },
                    { surface: new SlotName("palette") },
                    events
                )
            ).resolves.toEqual({ id: "event-1" });
        }
    );

    test(
        "rejects an invocation whose bound input the installed Operation schema refuses",
        { tags: "p0" },
        async () => {
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
        }
    );
});
