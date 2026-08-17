import { RecordCodec, Revision, type JsonValue } from "../../core";
import { RunCommitId } from "../../execution-references";
import { AgentCoreError } from "../../errors";
import { AgentId } from "../id";
import {
    CodecRecord,
    digestFromData,
    requireArray,
    requireExactFields,
    requireInteger,
    requireObject,
    requireOptionalString,
    requireString,
    revisionData,
    revisionFromData
} from "../record-data";
import { RunBranchId, RunId } from "./id";
import { TerminalSnapshot } from "./settlement";
import type { ResourceDimension } from "./ceiling";
import { Digest } from "../../core";

export abstract class RunLifecycle {
    public static get active(): RunLifecycle {
        return activeRun;
    }
    // SPEC §5.2: the terminal variant records which ceiling dimension exhaustion
    // cancelled the Run, and nothing when the Run ended for any other reason.
    public static terminal(exhausted?: ResourceDimension): RunLifecycle {
        return new TerminalRun(exhausted);
    }
    public abstract readonly kind: "active" | "terminal";
    public abstract readonly exhausted: ResourceDimension | undefined;
}

class ActiveRun extends RunLifecycle {
    public readonly kind = "active" as const;
    public readonly exhausted = undefined;
}

class TerminalRun extends RunLifecycle {
    public readonly kind = "terminal" as const;
    public constructor(public readonly exhausted: ResourceDimension | undefined = undefined) {
        super();
        Object.freeze(this);
    }
}

export interface RunInit {
    readonly id: RunId;
    readonly agent: AgentId;
    readonly configuration: Digest;
    readonly configurations?: readonly Digest[];
    readonly root: RunCommitId;
    readonly initialBranch: RunBranchId;
    readonly parent?: RunId | undefined;
    readonly terminal?: TerminalSnapshot | undefined;
    readonly tokensConsumed?: number;
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
    // SPEC §5.2: tokens are the one ceiling dimension with no derivation, so the Run
    // carries their running total. depth and wallClockMs stay derived.
    public readonly tokensConsumed: number;
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
        this.terminal = init.terminal;
        const tokensConsumed = init.tokensConsumed ?? 0;
        if (!Number.isSafeInteger(tokensConsumed) || tokensConsumed < 0) {
            throw new TypeError("Run token total must be a non-negative safe integer");
        }
        this.tokensConsumed = tokensConsumed;
        // A Run is terminal exactly when it holds its terminal snapshot. Storing the
        // state beside the evidence would only create two ways to answer one question.
        this.lifecycle =
            init.terminal === undefined
                ? RunLifecycle.active
                : RunLifecycle.terminal(init.terminal.exhausted);
        this.revision = init.revision;
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
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError("run.invalid-state", "Terminal Runs cannot transition");
        }
        return this.transition(snapshot);
    }

    public revise(): Run {
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal Runs reject ordinary mutations"
            );
        }
        return this.transition(this.terminal);
    }

    public recordEvidence(): Run {
        if (this.lifecycle.kind !== "terminal") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Only terminal Runs record captured evidence"
            );
        }
        return this.transition(this.terminal);
    }

    // Accumulated where a model call commits (SPEC §5.1, §5.2).
    public recordTokens(tokens: number): Run {
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal Runs consume no further tokens"
            );
        }
        return this.transition(
            this.terminal,
            this.configurations,
            this.tokensConsumed + requireTokenUsage(tokens)
        );
    }

    public recordConfiguration(configuration: Digest): Run {
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal Runs reject configuration migration"
            );
        }
        if (this.configurations.some((value) => value.equals(configuration))) return this;
        return this.transition(this.terminal, [...this.configurations, configuration]);
    }

    public toData(): JsonValue {
        return {
            agent: this.agent.value,
            configuration: this.configuration.value,
            configurations: this.configurations.map((value) => value.value),
            id: this.id.value,
            initialBranch: this.initialBranch.value,
            parent: this.parent?.value ?? null,
            revision: revisionData(this.revision),
            root: this.root.value,
            terminal: this.terminal === undefined ? null : this.terminal.toData(),
            tokensConsumed: this.tokensConsumed
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
                "parent",
                "revision",
                "root",
                "terminal",
                "tokensConsumed"
            ],
            [],
            "Run"
        );
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
            parent: parent === undefined ? undefined : new RunId(parent),
            terminal:
                object["terminal"] === null
                    ? undefined
                    : TerminalSnapshot.fromData(object["terminal"]),
            tokensConsumed: requireInteger(object["tokensConsumed"], "Run token total"),
            revision: revisionFromData(object["revision"], "Run revision")
        });
    }

    private transition(
        terminal: TerminalSnapshot | undefined,
        configurations: readonly Digest[] = this.configurations,
        tokensConsumed: number = this.tokensConsumed
    ): Run {
        return new Run({
            id: this.id,
            agent: this.agent,
            configuration: this.configuration,
            configurations,
            root: this.root,
            initialBranch: this.initialBranch,
            parent: this.parent,
            terminal,
            tokensConsumed,
            revision: nextRunRevision(this.revision)
        });
    }
}

class RunRecordCodec extends RecordCodec<Run> {
    public constructor() {
        super("run.record", { major: 2, minor: 0 });
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
        public readonly revision: Revision,
        /**
         * The planned rewrite commit this branch has reserved and not yet closed. A branch
         * holds at most one, which is what makes a second rewrite attempt on it rejected
         * rather than raced (§5.2, C13-RUN-REWRITE-BRACKET).
         */
        public readonly rewrite?: RunCommitId | undefined
    ) {
        super();
        if (name.trim().length === 0) throw new TypeError("Run branch name must not be blank");
        if (rewrite?.equals(head) === true) {
            throw new TypeError("Run branch cannot reserve a rewrite it already holds as head");
        }
        Object.freeze(this);
    }

    /** Advancing onto the reserved rewrite closes the reservation, by identity. */
    public advance(head: RunCommitId): RunBranch {
        return new RunBranch(
            this.id,
            this.run,
            this.name,
            head,
            nextRunRevision(this.revision),
            this.rewrite?.equals(head) === true ? undefined : this.rewrite
        );
    }

    public reserveRewrite(commit: RunCommitId): RunBranch {
        if (this.rewrite !== undefined) {
            throw new AgentCoreError(
                "run.invalid-state",
                "Run branch already holds an uncompleted rewrite reservation"
            );
        }
        return new RunBranch(
            this.id,
            this.run,
            this.name,
            this.head,
            nextRunRevision(this.revision),
            commit
        );
    }

    public toData(): JsonValue {
        return {
            head: this.head.value,
            id: this.id.value,
            name: this.name,
            revision: revisionData(this.revision),
            rewrite: this.rewrite?.value ?? null,
            run: this.run.value
        };
    }

    public static fromData(value: JsonValue): RunBranch {
        const object = requireObject(value, "Run branch");
        requireExactFields(
            object,
            ["head", "id", "name", "revision", "rewrite", "run"],
            [],
            "Run branch"
        );
        const rewrite = requireOptionalString(object["rewrite"], "Run branch rewrite");
        return new RunBranch(
            new RunBranchId(requireString(object["id"], "Run branch ID")),
            new RunId(requireString(object["run"], "Run branch Run")),
            requireString(object["name"], "Run branch name"),
            new RunCommitId(requireString(object["head"], "Run branch head")),
            revisionFromData(object["revision"], "Run branch revision"),
            rewrite === undefined ? undefined : new RunCommitId(rewrite)
        );
    }
}

class BranchCodec extends RecordCodec<RunBranch> {
    public constructor() {
        super("run.branch", { major: 2, minor: 0 });
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

function requireTokenUsage(tokens: number): number {
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new TypeError("Run token usage must be a non-negative safe integer");
    }
    return tokens;
}

function nextRunRevision(revision: Revision): Revision {
    if (revision.value === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("run.invalid-state", "Run revision is exhausted");
    }
    return revision.next();
}
