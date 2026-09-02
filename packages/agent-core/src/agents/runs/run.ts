import { RecordCodec, Revision, compareCanonicalText, type JsonValue, TextId } from "../../core";
import { RunCommitId, TurnId } from "../../execution-references";
import { AgentCoreError } from "../../errors";
import { AgentId } from "../id";
import { ApprovalId, EffectAttemptId } from "../../invocation-references";
import { InvocationId, RouteReservationId } from "../../interaction-references";
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
import { AcceptanceId, RunBranchId, RunId } from "./id";
import { SettlementObligation, TerminalSnapshot } from "./settlement";
import type { ResourceDimension } from "./ceiling";
import { Currency, RealizedCost } from "./cost";
import {
    AdmissionCause,
    CancellationCause,
    RunInvocationDelivery,
    RunInvocationDeliveryCause,
    canonicalDeliveries
} from "./invocation-delivery";
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
    readonly costConsumed?: RealizedCost | undefined;
    readonly deliveries?: readonly RunInvocationDelivery[];
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
    // SPEC §5.2: `tokens` and `costMicros` are the two ceiling dimensions with no
    // derivation, so the Run carries a running total for each. `depth` and `wallClockMs`
    // stay derived. The cost total holds its currency, so one Run cannot hold two.
    public readonly tokensConsumed: number;
    public readonly costConsumed: RealizedCost | undefined;
    // SPEC §5.6: the durable messages this Run still owes the Invocation owners of the
    // items its Turns published. There is no cross-Actor transaction, so the Run keeps
    // each message until its owner acknowledges it.
    public readonly deliveries: readonly RunInvocationDelivery[];
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
        if (init.costConsumed !== undefined && init.costConsumed.constructor !== RealizedCost) {
            throw new TypeError("Run cost total must use the exact context class");
        }
        this.costConsumed = init.costConsumed;
        this.deliveries = canonicalDeliveries(init.deliveries ?? []);
        for (const delivery of this.deliveries) {
            if (!delivery.run.equals(init.id)) {
                throw new TypeError("Run invocation delivery belongs to a different Run");
            }
        }
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

    /**
     * Terminalizes the Run and, in the same transition, takes on the cancellation messages
     * its still-owed published items are owed (SPEC §5.2, §5.6). The messages arrive here
     * rather than through a later call because a terminal Run admits no second
     * terminalization: a message appended afterwards could be lost by exactly the response
     * loss it exists to survive.
     */
    public terminalize(
        snapshot: TerminalSnapshot,
        cancellations: readonly RunInvocationDelivery[] = []
    ): Run {
        if (!snapshot.run.equals(this.id)) {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal snapshot belongs to another Run"
            );
        }
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError("run.invalid-state", "Terminal Runs cannot transition");
        }
        for (const delivery of cancellations) {
            if (
                delivery.cause.kind !== "cancellation" ||
                delivery.cause.terminalCommit?.equals(snapshot.terminalCommit) !== true
            ) {
                throw new AgentCoreError(
                    "run.invalid-state",
                    "A Run cancellation message names the exact terminal commit it ended on"
                );
            }
        }
        return this.transition({
            terminal: snapshot,
            deliveries: [...this.deliveries, ...cancellations]
        });
    }

    /**
     * Takes on the message a published item's Invocation owner is owed once the Run holds
     * that item as its own obligation (SPEC §5.6). Publishing the same handle again is the
     * same message, so it changes nothing rather than owing the owner a second one.
     */
    public publishDelivery(delivery: RunInvocationDelivery): Run {
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal Runs publish no further admission"
            );
        }
        if (!delivery.run.equals(this.id)) {
            throw new AgentCoreError(
                "run.invalid-state",
                "Run invocation delivery belongs to another Run"
            );
        }
        if (delivery.cause.kind !== "admission") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Publishing a handle owes its owner an admission message"
            );
        }
        if (this.deliveries.some((pending) => pending.id.equals(delivery.id))) return this;
        return this.transition({ deliveries: [...this.deliveries, delivery] });
    }

    /**
     * Discharges one message its Invocation owner has acknowledged (SPEC §5.6, §6.1).
     *
     * Delivery is at-least-once, so a repeated acknowledgement is the ordinary case rather
     * than an error: the first one removed the message, and a second finds nothing to
     * remove and says so by changing nothing. A message of another Run is refused, because
     * that is a caller addressing state it does not hold rather than a duplicate.
     *
     * A terminal Run accepts this. A discharged message changes no lifecycle, and a
     * cancellation message exists only on a Run that has already ended.
     */
    public acknowledgeDelivery(delivery: RunInvocationDelivery): Run {
        if (!delivery.run.equals(this.id)) {
            throw new AgentCoreError(
                "run.invalid-state",
                "Run invocation delivery belongs to another Run"
            );
        }
        const remaining = this.deliveries.filter((pending) => !pending.id.equals(delivery.id));
        if (remaining.length === this.deliveries.length) return this;
        return this.transition({ deliveries: remaining });
    }

    public revise(): Run {
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal Runs reject ordinary mutations"
            );
        }
        return this.transition();
    }

    public recordEvidence(): Run {
        if (this.lifecycle.kind !== "terminal") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Only terminal Runs record captured evidence"
            );
        }
        return this.transition();
    }

    /**
     * One model call's consumption, accumulated where that call commits (SPEC §5.1, §5.2).
     * `tokens` and `costMicros` are the two ceiling dimensions with no derivation, and both
     * advance in this one transition, so a reader never sees a Run whose token total says a
     * call happened while its cost total says it did not.
     *
     * A host with no realized cost passes none, which leaves `costMicros` unbounded rather
     * than recording a zero that reads as a measured total. When a cost is present, the
     * caller supplies every currency the Run's lineage already records cost in, and this path
     * refuses to disagree with any of them: a comparison between amounts in two currencies is
     * not a comparison, and a ceiling is nothing but that comparison. The rule is about the
     * lineage and not about the order its Runs recorded in — a currency an ancestor or a
     * descendant already holds binds this cost the same way, whichever recorded first — and a
     * refusal moves neither total. A lineage that holds no currency adopts this cost's, and
     * every later cost in it answers to that.
     */
    public recordModelUsage(
        tokens: number,
        cost: RealizedCost | undefined,
        lineageCurrencies: readonly Currency[]
    ): Run {
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal Runs consume no further resources"
            );
        }
        const consumed = this.tokensConsumed + requireTokenUsage(tokens);
        if (cost === undefined) {
            return this.transition({ tokensConsumed: consumed });
        }
        const held =
            this.costConsumed === undefined
                ? lineageCurrencies
                : [this.costConsumed.currency, ...lineageCurrencies];
        // Canonical order and no repeats, so a refusal names every currency the lineage holds
        // that this cost disagrees with, and names them the same way whatever order the
        // lineage recorded them in.
        const divergent = [
            ...new Set(
                held
                    .filter((currency) => !currency.equals(cost.currency))
                    .map((currency) => currency.value)
            )
        ].sort(compareCanonicalText);
        if (divergent.length > 0) {
            throw new AgentCoreError(
                "run.invalid-state",
                `Run lineage records cost in ${divergent.join(", ")}, not ${cost.currency.value}`
            );
        }
        return this.transition({
            tokensConsumed: consumed,
            costConsumed: new RealizedCost(
                (this.costConsumed?.micros ?? 0) + cost.micros,
                cost.currency
            )
        });
    }

    public recordConfiguration(configuration: Digest): Run {
        if (this.lifecycle.kind !== "active") {
            throw new AgentCoreError(
                "run.invalid-state",
                "Terminal Runs reject configuration migration"
            );
        }
        if (this.configurations.some((value) => value.equals(configuration))) return this;
        return this.transition({ configurations: [...this.configurations, configuration] });
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
            deliveries: this.deliveries.map((delivery) => delivery.toData()),
            terminal: this.terminal === undefined ? null : this.terminal.toData(),
            costConsumed: this.costConsumed === undefined ? null : this.costConsumed.toData(),
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
                "costConsumed",
                "deliveries",
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
            deliveries: requireArray(object["deliveries"], "Run invocation deliveries").map(
                (entry) => RunInvocationDelivery.fromData(entry)
            ),
            tokensConsumed: requireInteger(object["tokensConsumed"], "Run token total"),
            costConsumed:
                object["costConsumed"] === null
                    ? undefined
                    : RealizedCost.fromData(object["costConsumed"] ?? null),
            revision: revisionFromData(object["revision"], "Run revision")
        });
    }

    private transition(changes: RunChanges = {}): Run {
        return new Run({
            id: this.id,
            agent: this.agent,
            configuration: this.configuration,
            configurations: changes.configurations ?? this.configurations,
            root: this.root,
            initialBranch: this.initialBranch,
            parent: this.parent,
            terminal: changes.terminal ?? this.terminal,
            tokensConsumed: changes.tokensConsumed ?? this.tokensConsumed,
            costConsumed: changes.costConsumed ?? this.costConsumed,
            deliveries: changes.deliveries ?? this.deliveries,
            revision: nextRunRevision(this.revision)
        });
    }
}

/**
 * What one Run transition changes. Every field a transition leaves alone stays exactly what
 * the Run already held, so a new field cannot be dropped by a transition that predates it.
 * `terminal` is never cleared, which is why absence here means "keep" rather than "none".
 */
interface RunChanges {
    readonly terminal?: TerminalSnapshot;
    readonly configurations?: readonly Digest[];
    readonly tokensConsumed?: number;
    readonly costConsumed?: RealizedCost;
    readonly deliveries?: readonly RunInvocationDelivery[];
}

class RunRecordCodec extends RecordCodec<Run> {
    public constructor() {
        super(
            [
                Run,
                Revision,
                TextId,
                SettlementObligation,
                TerminalSnapshot,
                Digest,
                RunLifecycle,
                RunId,
                AgentId,
                RunCommitId,
                TurnId,
                RunBranchId,
                RunInvocationDelivery,
                RunInvocationDeliveryCause,
                AdmissionCause,
                CancellationCause,
                CodecRecord,
                TerminalRun,
                ApprovalId,
                InvocationId,
                AcceptanceId,
                RouteReservationId,
                EffectAttemptId,
                RealizedCost,
                Currency
            ],
            "run.record",
            {
                major: 4,
                minor: 0
            }
        );
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
        super(
            [RunBranch, Revision, TextId, RunId, RunCommitId, RunBranchId, CodecRecord],
            "run.branch",
            { major: 2, minor: 0 }
        );
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

/**
 * SPEC §8.5 gives a revision its own rejection outcome (`rejectedRevision`) beside the
 * lifecycle one, and a revision that cannot advance is a fact about the revision rather than
 * about the Run's state — so the ceiling is `protocol.revision-conflict`, exactly what
 * `Revision.next` raises for the same condition. This wrapper exists only to name whose
 * revision ran out; it never reports the condition differently from the one owner of
 * revision advancement.
 */
function nextRunRevision(revision: Revision): Revision {
    if (revision.value === Number.MAX_SAFE_INTEGER) {
        throw new AgentCoreError("protocol.revision-conflict", "Run revision is exhausted");
    }
    return revision.next();
}
