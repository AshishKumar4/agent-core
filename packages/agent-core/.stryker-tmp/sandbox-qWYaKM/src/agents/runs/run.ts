// @ts-nocheck
import { RecordCodec, Revision, type JsonValue } from "../../core";
import { RunCommitId } from "../../execution-references";
import { AgentCoreError } from "../../errors";
import { AgentId } from "../id";
import {
    CodecRecord,
    digestFromData,
    requireArray,
    requireExactFields,
    requireObject,
    requireOptionalString,
    requireString,
    revisionData,
    revisionFromData
} from "../record-data";
import { RunBranchId, RunId } from "./id";
import { TerminalSnapshot } from "./settlement";
import { Digest } from "../../core";

export abstract class RunLifecycle {
    public static get active(): RunLifecycle {
        return activeRun;
    }
    public static get terminal(): RunLifecycle {
        return terminalRun;
    }
    public abstract readonly kind: "active" | "terminal";
    public abstract terminalize(): RunLifecycle;

    public static from(kind: "active" | "terminal"): RunLifecycle {
        return kind === "active" ? RunLifecycle.active : RunLifecycle.terminal;
    }
}

class ActiveRun extends RunLifecycle {
    public readonly kind = "active" as const;
    public terminalize(): RunLifecycle {
        return RunLifecycle.terminal;
    }
}

class TerminalRun extends RunLifecycle {
    public readonly kind = "terminal" as const;
    public terminalize(): RunLifecycle {
        throw new AgentCoreError("run.invalid-state", "Terminal Runs cannot transition");
    }
}

export interface RunInit {
    readonly id: RunId;
    readonly agent: AgentId;
    readonly configuration: Digest;
    readonly configurations?: readonly Digest[];
    readonly root: RunCommitId;
    readonly initialBranch: RunBranchId;
    readonly parent?: RunId;
    readonly lifecycle?: RunLifecycle;
    readonly terminal?: TerminalSnapshot;
    readonly revision: Revision;
}

export class Run extends CodecRecord {
    public static get codec(): RecordCodec<Run> {
        return RunCodec;
    }
    public readonly id: RunId;
    public readonly agent: AgentId;
    public readonly configuration: Digest;
    public readonly configurations: readonly Digest[];
    public readonly root: RunCommitId;
    public readonly initialBranch: RunBranchId;
    public readonly parent: RunId | undefined;
    public readonly lifecycle: RunLifecycle;
    public readonly terminal: TerminalSnapshot | undefined;
    public readonly revision: Revision;

    public constructor(init: RunInit) {
        super();
        this.id = init.id;
        this.agent = init.agent;
        this.configuration = init.configuration;
        const configurations = [...(init.configurations ?? [init.configuration])];
        if (
            configurations.length === 0 ||
            !configurations[0]!.equals(init.configuration) ||
            new Set(configurations.map((value) => value.value)).size !== configurations.length
        ) {
            throw new TypeError(
                "Run configuration history must begin with one unique genesis snapshot"
            );
        }
        this.configurations = Object.freeze(configurations);
        this.root = init.root;
        this.initialBranch = init.initialBranch;
        this.parent = init.parent;
        this.lifecycle = init.lifecycle ?? RunLifecycle.active;
        this.terminal = init.terminal;
        this.revision = init.revision;
        if ((this.lifecycle.kind === "terminal") !== (this.terminal !== undefined)) {
            throw new TypeError("Run terminal state requires exactly one terminal snapshot");
        }
        if (this.terminal !== undefined && !this.terminal.run.equals(this.id)) {
            throw new TypeError("Terminal snapshot belongs to a different Run");
        }
        Object.freeze(this);
    }

    public terminalize(snapshot: TerminalSnapshot): Run {
        if (!snapshot.run.equals(this.id)) {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal snapshot belongs to another Run"
            );
        }
        return this.transition(this.lifecycle.terminalize(), snapshot);
    }

    public revise(): Run {
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal Runs reject ordinary mutations"
            );
        }
        return this.transition(this.lifecycle, this.terminal);
    }

    public recordEvidence(): Run {
        if (this.lifecycle.kind !== "terminal") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Only terminal Runs record captured evidence"
            );
        }
        return this.transition(this.lifecycle, this.terminal);
    }

    public recordConfiguration(configuration: Digest): Run {
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal Runs reject configuration migration"
            );
        }
        if (this.configurations.some((value) => value.equals(configuration))) return this;
        return this.transition(this.lifecycle, this.terminal, [
            ...this.configurations,
            configuration
        ]);
    }

    public toData(): JsonValue {
        return {
            agent: this.agent.value,
            configuration: this.configuration.value,
            configurations: this.configurations.map((value) => value.value),
            id: this.id.value,
            initialBranch: this.initialBranch.value,
            lifecycle: this.lifecycle.kind,
            parent: this.parent?.value ?? null,
            revision: revisionData(this.revision),
            root: this.root.value,
            terminal: this.terminal === undefined ? null : this.terminal.toData()
        };
    }

    public static fromData(value: JsonValue): Run {
        const object = requireObject(value, "Run");
        requireExactFields(
            object,
            [
                "agent",
                "configuration",
                "configurations",
                "id",
                "initialBranch",
                "lifecycle",
                "parent",
                "revision",
                "root",
                "terminal"
            ],
            [],
            "Run"
        );
        const lifecycle = object["lifecycle"];
        if (lifecycle !== "active" && lifecycle !== "terminal")
            throw new TypeError("Run lifecycle is invalid");
        const parent = requireOptionalString(object["parent"], "Parent Run");
        return new Run({
            id: new RunId(requireString(object["id"], "Run ID")),
            agent: new AgentId(requireString(object["agent"], "Run Agent")),
            configuration: digestFromData(object["configuration"], "Run configuration"),
            configurations: requireArray(object["configurations"], "Run configurations").map(
                (entry) => digestFromData(entry, "Run configuration history")
            ),
            root: new RunCommitId(requireString(object["root"], "Run root")),
            initialBranch: new RunBranchId(
                requireString(object["initialBranch"], "Initial branch")
            ),
            ...(parent === undefined ? {} : { parent: new RunId(parent) }),
            lifecycle: RunLifecycle.from(lifecycle),
            ...(object["terminal"] === null
                ? {}
                : { terminal: TerminalSnapshot.fromData(object["terminal"]!) }),
            revision: revisionFromData(object["revision"], "Run revision")
        });
    }

    private transition(
        lifecycle: RunLifecycle,
        terminal: TerminalSnapshot | undefined,
        configurations: readonly Digest[] = this.configurations
    ): Run {
        return new Run({
            id: this.id,
            agent: this.agent,
            configuration: this.configuration,
            configurations,
            root: this.root,
            initialBranch: this.initialBranch,
            ...(this.parent === undefined ? {} : { parent: this.parent }),
            lifecycle,
            ...(terminal === undefined ? {} : { terminal }),
            revision: nextRunRevision(this.revision)
        });
    }
}

class RunRecordCodec extends RecordCodec<Run> {
    public constructor() {
        super("run.record", { major: 1, minor: 0 });
    }
    protected encodePayload(value: Run): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): Run {
        return Run.fromData(value);
    }
}

export const RunCodec: RecordCodec<Run> = new RunRecordCodec();

export class RunBranch extends CodecRecord {
    public static get codec(): RecordCodec<RunBranch> {
        return RunBranchCodec;
    }
    public constructor(
        public readonly id: RunBranchId,
        public readonly run: RunId,
        public readonly name: string,
        public readonly head: RunCommitId,
        public readonly revision: Revision
    ) {
        super();
        if (name.trim().length === 0) throw new TypeError("Run branch name must not be blank");
        Object.freeze(this);
    }

    public advance(head: RunCommitId): RunBranch {
        return new RunBranch(this.id, this.run, this.name, head, nextRunRevision(this.revision));
    }

    public toData(): JsonValue {
        return {
            head: this.head.value,
            id: this.id.value,
            name: this.name,
            revision: revisionData(this.revision),
            run: this.run.value
        };
    }

    public static fromData(value: JsonValue): RunBranch {
        const object = requireObject(value, "Run branch");
        requireExactFields(object, ["head", "id", "name", "revision", "run"], [], "Run branch");
        return new RunBranch(
            new RunBranchId(requireString(object["id"], "Run branch ID")),
            new RunId(requireString(object["run"], "Run branch Run")),
            requireString(object["name"], "Run branch name"),
            new RunCommitId(requireString(object["head"], "Run branch head")),
            revisionFromData(object["revision"], "Run branch revision")
        );
    }
}

class BranchCodec extends RecordCodec<RunBranch> {
    public constructor() {
        super("run.branch", { major: 1, minor: 0 });
    }
    protected encodePayload(value: RunBranch): JsonValue {
        return value.toData();
    }
    protected decodePayload(value: JsonValue): RunBranch {
        return RunBranch.fromData(value);
    }
}

export const RunBranchCodec: RecordCodec<RunBranch> = new BranchCodec();

const activeRun = Object.freeze(new ActiveRun());
const terminalRun = Object.freeze(new TerminalRun());

function nextRunRevision(revision: Revision): Revision {
    if (revision.value === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("run.invalid-state", "Run revision is exhausted");
    }
    return revision.next();
}
