import { describe, expect, test } from "vitest";
import { Revision, type JsonValue } from "../../../src/core";
import { AgentCoreError } from "../../../src/errors";
import { FacetRef } from "../../../src/facets";
import { RunCommitId } from "../../../src/execution-references";
import { AgentId, AgentPolicyId, AgentProfileId, ModelPolicyId } from "../../../src/agents/id";
import { bytesEqual, requireExactFields, requireString } from "../../../src/agents/record-data";
import {
    RunBranchId,
    RunCheckpointId,
    RunId,
    SpawnReservationId,
    TurnId,
    TurnInboxEntryId
} from "../../../src/agents/runs/id";
import { requireTerminalOutcome } from "../../../src/agents/runs/outcome";
import { BlueprintPin, RunConfigurationSnapshot, RunPins } from "../../../src/agents/runs/pins";
import { PlacementPin, TurnPlacementSnapshot } from "../../../src/agents/runs/placement";
import { Run, RunBranch } from "../../../src/agents/runs/run";
import { SettlementObligation, TerminalSnapshot } from "../../../src/agents/runs/settlement";
import { SpawnReservation } from "../../../src/agents/runs/spawn";
import {
    AgentPolicyRevisionRecord,
    AgentRevisionRecord,
    ModelPolicyRevisionRecord
} from "../../../src/agents/source";
import { configuration, content, digest, genesis, ids, pins, refs, sourceRecords } from "./fixture";

function expectTypeError(label: string, operation: () => unknown, message: string): void {
    try {
        operation();
        throw new Error(`Expected TypeError: ${label}`);
    } catch (error) {
        expect(error, label).toBeInstanceOf(TypeError);
        expect((error as TypeError).message, label).toBe(message);
    }
}

function expectCode(
    label: string,
    operation: () => unknown,
    code: AgentCoreError["code"],
    message: string
): void {
    try {
        operation();
        throw new Error(`Expected AgentCoreError: ${label}`);
    } catch (error) {
        expect(error, label).toBeInstanceOf(AgentCoreError);
        expect((error as AgentCoreError).code, label).toBe(code);
        expect((error as AgentCoreError).message, label).toBe(message);
    }
}

function mutated(data: JsonValue, update: (object: Record<string, unknown>) => void): never {
    const clone = structuredClone(data) as Record<string, unknown>;
    update(clone);
    return clone as never;
}

describe("nominal identifier subjects", () => {
    test("every Agent and Run scoped ID names its exact subject", { tags: "p2" }, () => {
        const cases = [
            { label: "Run ID", make: () => new RunId("") },
            { label: "Turn ID", make: () => new TurnId("") },
            { label: "Run commit ID", make: () => new RunCommitId("") },
            { label: "Run branch ID", make: () => new RunBranchId("") },
            { label: "Run checkpoint ID", make: () => new RunCheckpointId("") },
            { label: "Turn inbox entry ID", make: () => new TurnInboxEntryId("") },
            { label: "Spawn reservation ID", make: () => new SpawnReservationId("") },
            { label: "Agent ID", make: () => new AgentId("") },
            { label: "Agent profile ID", make: () => new AgentProfileId("") },
            { label: "Agent policy ID", make: () => new AgentPolicyId("") },
            { label: "Model policy ID", make: () => new ModelPolicyId("") }
        ] as const;
        for (const { label, make } of cases) {
            expectTypeError(label, make, `${label} must contain between 1 and 256 characters`);
        }
    });
});

describe("record data helpers", () => {
    test("rejects a partially missing required field set", { tags: "p1" }, () => {
        expectTypeError(
            "partial required",
            () => requireExactFields({ present: 1 }, ["present", "absent"], [], "Partial fields"),
            "Partial fields contains missing or unknown fields"
        );
        expect(
            requireExactFields({ present: 1 }, ["present"], ["optional"], "Partial fields")
        ).toBeUndefined();
    });

    test("rejects non-string values distinctly from empty strings", { tags: "p1" }, () => {
        expectTypeError(
            "numeric string",
            () => requireString(42 as never, "Numeric subject"),
            "Numeric subject must be a non-empty string"
        );
        expect(requireString("ok", "Numeric subject")).toBe("ok");
    });

    test("bytesEqual compares both length and content", { tags: "p1" }, () => {
        expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
        expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
        expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    });

    test("terminal outcomes admit only the closed vocabulary", { tags: "p1" }, () => {
        expect(requireTerminalOutcome("succeeded", "Terminal outcome")).toBe("succeeded");
        expect(requireTerminalOutcome("failed", "Terminal outcome")).toBe("failed");
        expect(requireTerminalOutcome("cancelled", "Terminal outcome")).toBe("cancelled");
        expectTypeError(
            "unknown outcome",
            () => requireTerminalOutcome("bogus", "Terminal outcome"),
            "Terminal outcome is invalid"
        );
        expectTypeError(
            "numeric outcome",
            () => requireTerminalOutcome(42, "Terminal outcome"),
            "Terminal outcome is invalid"
        );
    });
});

describe("Run lifecycle record", () => {
    test("appends configuration history exactly once per digest", { tags: "p1" }, () => {
        const base = genesis().run;
        const extra = digest("9");
        const appended = base.recordConfiguration(extra);

        expect(appended.configurations.map((value) => value.value)).toEqual([
            base.configuration.value,
            extra.value
        ]);
        expect(appended.revision.value).toBe(base.revision.value + 1);
        expect(appended.recordConfiguration(extra)).toBe(appended);
        expect(appended.recordConfiguration(base.configuration)).toBe(appended);
    });

    test("reports exact closed codes for terminal transitions", { tags: "p1" }, () => {
        const obligation = new SettlementObligation({ registryEpoch: 1, obligations: [] });
        const snapshot = new TerminalSnapshot(
            ids.run,
            ids.turn,
            ids.root,
            new RunCommitId("records-terminal"),
            "succeeded",
            obligation,
            new Date(1000)
        );
        const active = genesis().run;
        const terminal = active.terminalize(snapshot);

        expectCode(
            "terminalize twice",
            () => terminal.terminalize(snapshot),
            "run.invalid-state",
            "Terminal Runs cannot transition"
        );
        expectCode(
            "revise terminal",
            () => terminal.revise(),
            "run.invalid-state",
            "Terminal Runs reject ordinary mutations"
        );
        expectCode(
            "record evidence on active",
            () => active.recordEvidence(),
            "run.invalid-state",
            "Only terminal Runs record captured evidence"
        );
        expectCode(
            "configure terminal",
            () => terminal.recordConfiguration(digest("9")),
            "run.invalid-state",
            "Terminal Runs reject configuration migration"
        );
        const exhausted = new Run({
            id: ids.run,
            agent: ids.agent,
            configuration: active.configuration,
            root: ids.root,
            initialBranch: ids.branch,
            revision: new Revision(Number.MAX_SAFE_INTEGER)
        });
        expectCode(
            "revision exhaustion",
            () => exhausted.revise(),
            "run.invalid-state",
            "Run revision is exhausted"
        );
    });

    test("names each Run field in decode errors", { tags: "p2" }, () => {
        const data = genesis().run.toData();
        const cases = [
            { label: "id", message: "Run ID must be a non-empty string" },
            { label: "agent", message: "Run Agent must be a non-empty string" },
            { label: "configuration", message: "Run configuration must be a non-empty string" },
            { label: "root", message: "Run root must be a non-empty string" },
            { label: "initialBranch", message: "Initial branch must be a non-empty string" }
        ] as const;
        for (const { label, message } of cases) {
            expectTypeError(
                label,
                () =>
                    Run.fromData(
                        mutated(data, (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
        expectTypeError(
            "configurations entry",
            () =>
                Run.fromData(
                    mutated(data, (object) => {
                        object["configurations"] = [42];
                    })
                ),
            "Run configuration history must be a non-empty string"
        );
        expectTypeError(
            "revision",
            () =>
                Run.fromData(
                    mutated(data, (object) => {
                        object["revision"] = "x";
                    })
                ),
            "Run revision must be a non-negative safe integer"
        );
    });

    test("rejects unknown Run and Run branch fields", { tags: "p1" }, () => {
        expectTypeError(
            "run extra field",
            () =>
                Run.fromData(
                    mutated(genesis().run.toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Run contains missing or unknown fields"
        );
        expectTypeError(
            "branch extra field",
            () =>
                RunBranch.fromData(
                    mutated(genesis().branch.toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Run branch contains missing or unknown fields"
        );
    });

    test("names each Run branch field in decode errors", { tags: "p2" }, () => {
        const data = genesis().branch.toData();
        const cases = [
            { label: "id", message: "Run branch ID must be a non-empty string" },
            { label: "run", message: "Run branch Run must be a non-empty string" },
            { label: "name", message: "Run branch name must be a non-empty string" },
            { label: "head", message: "Run branch head must be a non-empty string" }
        ] as const;
        for (const { label, message } of cases) {
            expectTypeError(
                label,
                () =>
                    RunBranch.fromData(
                        mutated(data, (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
        expectTypeError(
            "revision",
            () =>
                RunBranch.fromData(
                    mutated(data, (object) => {
                        object["revision"] = "x";
                    })
                ),
            "Run branch revision must be a non-negative safe integer"
        );
    });
});

function placementPin(overrides: Partial<ConstructorParameters<typeof PlacementPin>[0]> = {}) {
    return new PlacementPin({
        facet: new FacetRef("core:records-facet"),
        manifest: ["dynamic"],
        policy: ["dynamic"],
        substrate: ["dynamic"],
        trust: ["dynamic"],
        selected: "dynamic",
        ...overrides
    });
}

describe("placement pins", () => {
    test("selects the first preference shared by every source set", { tags: "p1" }, () => {
        const both = ["dynamic", "provider"] as const;
        const cases = [
            { label: "manifest", overrides: { manifest: ["provider"] as const } },
            { label: "policy", overrides: { policy: ["provider"] as const } },
            { label: "substrate", overrides: { substrate: ["provider"] as const } },
            { label: "trust", overrides: { trust: ["provider"] as const } }
        ] as const;
        for (const { label, overrides } of cases) {
            const pin = placementPin({
                manifest: both,
                policy: both,
                substrate: both,
                trust: both,
                selected: "provider",
                ...overrides
            });
            expect(pin.selected, label).toBe("provider");
            expect(Object.isFrozen(pin), label).toBe(true);
        }
        expectTypeError(
            "preference order",
            () =>
                placementPin({
                    manifest: both,
                    policy: both,
                    substrate: both,
                    trust: both,
                    selected: "provider"
                }),
            "Placement selection must use the fixed preference order"
        );
    });

    test("names each mode source in canonicalization errors", { tags: "p2" }, () => {
        expectTypeError(
            "manifest duplicates",
            () => placementPin({ manifest: ["dynamic", "dynamic"] }),
            "Manifest modes must be nonempty and unique"
        );
        expectTypeError(
            "policy empty",
            () => placementPin({ policy: [] }),
            "Policy modes must be nonempty and unique"
        );
        expectTypeError(
            "substrate duplicates",
            () => placementPin({ substrate: ["dynamic", "dynamic"] }),
            "Substrate modes must be nonempty and unique"
        );
        expectTypeError(
            "trust empty",
            () => placementPin({ trust: [] }),
            "Trust modes must be nonempty and unique"
        );
    });

    test("rejects unknown modes before preference selection", { tags: "p1" }, () => {
        expectTypeError(
            "unknown manifest mode",
            () => placementPin({ manifest: ["dynamic", "unknown" as never] }),
            "Manifest modes contains an unknown mode"
        );
        expectTypeError(
            "unknown trust mode",
            () => placementPin({ trust: ["dynamic", "unknown" as never] }),
            "Trust modes contains an unknown mode"
        );
    });

    test("decodes bundled selections exactly", { tags: "p1" }, () => {
        const only = ["bundled"] as const;
        const bundled = placementPin({
            manifest: only,
            policy: only,
            substrate: only,
            trust: only,
            selected: "bundled"
        });
        const decoded = PlacementPin.fromData(structuredClone(bundled.toData()) as never);

        expect(decoded.selected).toBe("bundled");
        expect(decoded.manifest).toEqual(["bundled"]);
        expectTypeError(
            "unknown selected",
            () =>
                PlacementPin.fromData(
                    mutated(bundled.toData(), (object) => {
                        object["selected"] = "unknown";
                    })
                ),
            "Selected mode contains an unknown isolation mode"
        );
        expectTypeError(
            "unknown manifest entry",
            () =>
                PlacementPin.fromData(
                    mutated(bundled.toData(), (object) => {
                        object["manifest"] = ["bundled", 42];
                    })
                ),
            "Manifest modes contains an unknown isolation mode"
        );
    });

    test("names each placement field in decode errors", { tags: "p2" }, () => {
        const data = placementPin().toData();
        expectTypeError(
            "facet",
            () =>
                PlacementPin.fromData(
                    mutated(data, (object) => {
                        object["facet"] = 42;
                    })
                ),
            "Placement Facet must be a non-empty string"
        );
        const arrays = [
            { label: "manifest", message: "Manifest modes must be an array" },
            { label: "policy", message: "Policy modes must be an array" },
            { label: "substrate", message: "Substrate modes must be an array" },
            { label: "trust", message: "Trust modes must be an array" }
        ] as const;
        for (const { label, message } of arrays) {
            expectTypeError(
                label,
                () =>
                    PlacementPin.fromData(
                        mutated(data, (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
    });

    test("canonicalizes snapshot placements by facet order", { tags: "p1" }, () => {
        const zeta = placementPin({ facet: new FacetRef("core:zeta") });
        const alpha = placementPin({ facet: new FacetRef("core:alpha") });
        const snapshot = new TurnPlacementSnapshot(ids.turn, pins(), [zeta, alpha]);

        expect(snapshot.placements.map((value) => value.facet.value)).toEqual([
            "core:alpha",
            "core:zeta"
        ]);
        expect(Object.isFrozen(snapshot.placements)).toBe(true);
        const decoded = TurnPlacementSnapshot.fromData(structuredClone(snapshot.toData()) as never);
        expect(decoded.placements.map((value) => value.facet.value)).toEqual([
            "core:alpha",
            "core:zeta"
        ]);
        expect(decoded.digest.value).toBe(snapshot.digest.value);
    });

    test("names snapshot fields and rejects unknown placement fields", { tags: "p2" }, () => {
        const snapshot = new TurnPlacementSnapshot(ids.turn, pins(), [placementPin()]);
        expectTypeError(
            "snapshot turn",
            () =>
                TurnPlacementSnapshot.fromData(
                    mutated(snapshot.toData(), (object) => {
                        object["turn"] = 42;
                    })
                ),
            "Placement Turn must be a non-empty string"
        );
        expectTypeError(
            "snapshot placements",
            () =>
                TurnPlacementSnapshot.fromData(
                    mutated(snapshot.toData(), (object) => {
                        object["placements"] = 42;
                    })
                ),
            "Placement entries must be an array"
        );
        expectTypeError(
            "snapshot extra field",
            () =>
                TurnPlacementSnapshot.fromData(
                    mutated(snapshot.toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Turn placement snapshot contains missing or unknown fields"
        );
        expectTypeError(
            "pin extra field",
            () =>
                PlacementPin.fromData(
                    mutated(placementPin().toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Placement pin contains missing or unknown fields"
        );
    });
});

describe("Run pins", () => {
    test("names each pin field in decode errors", { tags: "p2" }, () => {
        const data = pins().toData();
        expectTypeError(
            "packages",
            () =>
                RunPins.fromData(
                    mutated(data, (object) => {
                        object["packages"] = 42;
                    })
                ),
            "Run pin packages must be an array"
        );
        const objects = [
            { label: "agent", message: "Agent pin must be an object" },
            { label: "modelPolicy", message: "Model policy pin must be an object" },
            { label: "environment", message: "Environment pin must be an object" }
        ] as const;
        for (const { label, message } of objects) {
            expectTypeError(
                label,
                () =>
                    RunPins.fromData(
                        mutated(data, (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
        expectTypeError(
            "agent pin id",
            () =>
                RunPins.fromData(
                    mutated(data, (object) => {
                        (object["agent"] as Record<string, unknown>)["id"] = 42;
                    })
                ),
            "Agent pin ID must be a non-empty string"
        );
        expectTypeError(
            "agent pin revision",
            () =>
                RunPins.fromData(
                    mutated(data, (object) => {
                        (object["agent"] as Record<string, unknown>)["revision"] = "x";
                    })
                ),
            "Agent pin revision must be a non-negative safe integer"
        );
        expectTypeError(
            "agent pin digest",
            () =>
                RunPins.fromData(
                    mutated(data, (object) => {
                        (object["agent"] as Record<string, unknown>)["digest"] = 42;
                    })
                ),
            "Agent pin digest must be a non-empty string"
        );
    });

    test("rejects unknown pin record fields", { tags: "p1" }, () => {
        expectTypeError(
            "pins extra field",
            () =>
                RunPins.fromData(
                    mutated(pins().toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Run pins contains missing or unknown fields"
        );
        expectTypeError(
            "agent pin extra field",
            () =>
                RunPins.fromData(
                    mutated(pins().toData(), (object) => {
                        (object["agent"] as Record<string, unknown>)["Stryker was here"] = true;
                    })
                ),
            "Agent pin contains missing or unknown fields"
        );
        expectTypeError(
            "blueprint extra field",
            () =>
                BlueprintPin.fromData(
                    mutated(pins().blueprint.toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Blueprint pin contains missing or unknown fields"
        );
        expectTypeError(
            "configuration extra field",
            () =>
                RunConfigurationSnapshot.fromData(
                    mutated(configuration().toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Run configuration snapshot contains missing or unknown fields"
        );
    });

    test("names each blueprint pin field in decode errors", { tags: "p2" }, () => {
        const data = pins().blueprint.toData();
        const cases = [
            { label: "name", message: "Blueprint pin name must be a non-empty string" },
            { label: "version", message: "Blueprint pin version must be a non-empty string" },
            { label: "digest", message: "Blueprint pin digest must be a non-empty string" }
        ] as const;
        for (const { label, message } of cases) {
            expectTypeError(
                label,
                () =>
                    BlueprintPin.fromData(
                        mutated(data, (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
    });
});

function spawnReservation(): SpawnReservation {
    return new SpawnReservation(
        new SpawnReservationId("records-spawn"),
        ids.run,
        ids.turn,
        new RunId("records-spawn-child"),
        { turn: ids.turn, holder: ids.holder, epoch: 1 },
        configuration().id,
        content("d"),
        refs.invocation,
        refs.receipt,
        digest("d"),
        new Date(3000)
    );
}

describe("spawn reservations", () => {
    test("accepts epoch zero and rejects malformed token holders", { tags: "p0" }, () => {
        const zero = new SpawnReservation(
            new SpawnReservationId("records-spawn-zero"),
            ids.run,
            ids.turn,
            new RunId("records-spawn-child"),
            { turn: ids.turn, holder: ids.holder, epoch: 0 },
            configuration().id,
            content("d"),
            refs.invocation,
            refs.receipt,
            digest("d"),
            new Date(4000)
        );
        expect(zero.token.epoch).toBe(0);
        expect(zero.recordedAt.getTime()).toBe(4000);
        expect(Object.isFrozen(zero)).toBe(true);

        expectTypeError(
            "holder class",
            () =>
                new SpawnReservation(
                    new SpawnReservationId("records-spawn-holder"),
                    ids.run,
                    ids.turn,
                    new RunId("records-spawn-child"),
                    { turn: ids.turn, holder: new TurnId("not-a-holder") as never, epoch: 1 },
                    configuration().id,
                    content("d"),
                    refs.invocation,
                    refs.receipt,
                    digest("d"),
                    new Date(4000)
                ),
            "Spawn reservation token epoch is invalid"
        );
        expectTypeError(
            "fractional epoch",
            () =>
                new SpawnReservation(
                    new SpawnReservationId("records-spawn-fraction"),
                    ids.run,
                    ids.turn,
                    new RunId("records-spawn-child"),
                    { turn: ids.turn, holder: ids.holder, epoch: 1.5 },
                    configuration().id,
                    content("d"),
                    refs.invocation,
                    refs.receipt,
                    digest("d"),
                    new Date(4000)
                ),
            "Spawn reservation token epoch is invalid"
        );
    });

    test("names each spawn field in decode errors", { tags: "p2" }, () => {
        const data = spawnReservation().toData();
        const cases = [
            { label: "id", message: "Spawn reservation ID must be a non-empty string" },
            { label: "parentRun", message: "Spawn parent Run must be a non-empty string" },
            { label: "parentTurn", message: "Spawn parent Turn must be a non-empty string" },
            { label: "childRun", message: "Spawn child Run must be a non-empty string" },
            { label: "configuration", message: "Spawn configuration must be a non-empty string" },
            { label: "rootContent", message: "Spawn root content must be a non-empty string" },
            { label: "invocation", message: "Spawn Invocation must be a non-empty string" },
            { label: "receipt", message: "Spawn Receipt must be a non-empty string" },
            { label: "attenuation", message: "Spawn attenuation must be a non-empty string" }
        ] as const;
        for (const { label, message } of cases) {
            expectTypeError(
                label,
                () =>
                    SpawnReservation.fromData(
                        mutated(data, (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
        expectCode(
            "token",
            () =>
                SpawnReservation.fromData(
                    mutated(data, (object) => {
                        object["token"] = 42;
                    })
                ),
            "codec.invalid",
            "Spawn token must be an object"
        );
    });

    test("rejects unknown spawn reservation fields", { tags: "p1" }, () => {
        expectTypeError(
            "spawn extra field",
            () =>
                SpawnReservation.fromData(
                    mutated(spawnReservation().toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Spawn reservation contains missing or unknown fields"
        );
    });
});

describe("source revision records", () => {
    test("names each agent revision field in decode errors", { tags: "p2" }, () => {
        const data = sourceRecords().agent.toData();
        const cases = [
            { label: "id", message: "Agent revision ID must be a non-empty string" },
            { label: "content", message: "Agent revision content must be a non-empty string" },
            { label: "digest", message: "Agent revision digest must be a non-empty string" },
            { label: "profile", message: "Agent profile must be a non-empty string" },
            { label: "policy", message: "Agent policy must be a non-empty string" },
            { label: "model", message: "Model policy must be a non-empty string" },
            { label: "environment", message: "Environment source must be a non-empty string" }
        ] as const;
        for (const { label, message } of cases) {
            expectTypeError(
                label,
                () =>
                    AgentRevisionRecord.fromData(
                        mutated(data, (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
        expectTypeError(
            "revision",
            () =>
                AgentRevisionRecord.fromData(
                    mutated(data, (object) => {
                        object["revision"] = "x";
                    })
                ),
            "Agent revision must be a non-negative safe integer"
        );
    });

    test("names policy and model revision subjects in decode errors", { tags: "p2" }, () => {
        expectTypeError(
            "policy object",
            () => AgentPolicyRevisionRecord.fromData(42 as never),
            "Agent policy revision must be an object"
        );
        expectTypeError(
            "model object",
            () => ModelPolicyRevisionRecord.fromData(42 as never),
            "Model policy revision must be an object"
        );
        const data = sourceRecords().model.toData();
        const cases = [
            { label: "id", message: "Model policy revision ID must be a non-empty string" },
            {
                label: "content",
                message: "Model policy revision content must be a non-empty string"
            },
            { label: "digest", message: "Model policy revision digest must be a non-empty string" }
        ] as const;
        for (const { label, message } of cases) {
            expectTypeError(
                label,
                () =>
                    ModelPolicyRevisionRecord.fromData(
                        mutated(data, (object) => {
                            object[label] = 42;
                        })
                    ),
                message
            );
        }
    });

    test("rejects unknown source revision fields", { tags: "p1" }, () => {
        expectTypeError(
            "agent revision extra field",
            () =>
                AgentRevisionRecord.fromData(
                    mutated(sourceRecords().agent.toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Agent revision contains missing or unknown fields"
        );
        expectTypeError(
            "model revision extra field",
            () =>
                ModelPolicyRevisionRecord.fromData(
                    mutated(sourceRecords().model.toData(), (object) => {
                        object["Stryker was here"] = true;
                    })
                ),
            "Model policy revision contains missing or unknown fields"
        );
    });
});
