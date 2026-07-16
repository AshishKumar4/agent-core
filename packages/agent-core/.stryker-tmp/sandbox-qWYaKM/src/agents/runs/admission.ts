// @ts-nocheck
import { RecordCodec, type JsonValue } from "../../core";
import { AgentCoreError } from "../../errors";
import { RunCommitId } from "../../execution-references";
import { ApprovalId, EffectAttemptId } from "../../invocation-references";
import { InvocationId, RouteReservationId } from "../../interaction-references";
import {
    CodecRecord,
    requireArray,
    requireExactFields,
    requireInteger,
    requireObject,
    requireString
} from "../record-data";
import { RunId } from "./id";

export type RunObligation =
    | { readonly kind: "approval"; readonly approval: ApprovalId }
    | {
          readonly kind: "invocationItem";
          readonly invocation: InvocationId;
          readonly itemIndex: number;
          readonly itemKey: string;
      }
    | { readonly kind: "route"; readonly reservation: RouteReservationId }
    | { readonly kind: "reconciliation"; readonly attempt: EffectAttemptId }
    | { readonly kind: "systemCommit"; readonly commit: RunCommitId };

export interface RunAdmissionReservation {
    readonly run: RunId;
    readonly registryEpoch: number;
    readonly obligation: RunObligation;
}

export interface RunAdmissionRegistryInit {
    readonly run: RunId;
    readonly epoch: number;
    readonly accepting: boolean;
    readonly reserved: readonly RunObligation[];
    readonly completed: readonly RunObligation[];
}

export interface RunObligationReservation {
    readonly registry: RunAdmissionRegistry;
    readonly reservation: RunAdmissionReservation;
}

export class RunAdmissionRegistry extends CodecRecord {
    public static get codec(): RecordCodec<RunAdmissionRegistry> {
        return RunAdmissionRegistryCodec;
    }

    public readonly run: RunId;
    public readonly epoch: number;
    public readonly accepting: boolean;
    public readonly reserved: readonly RunObligation[];
    public readonly completed: readonly RunObligation[];

    public constructor(init: RunAdmissionRegistryInit) {
        super();
        if (init.run.constructor !== RunId) {
            throw new TypeError("Run admission registry requires an exact Run ID");
        }
        requireEpoch(init.epoch, "Run admission registry epoch");
        if (typeof init.accepting !== "boolean") {
            throw new TypeError("Run admission registry accepting state is invalid");
        }
        if (!init.accepting && init.epoch === 0) {
            throw new TypeError("Closed Run admission registry must have an advanced epoch");
        }
        const reserved = canonicalObligations(init.reserved, "Reserved Run obligation");
        const reservedByKey = new Map(reserved.map((value) => [runObligationKey(value), value]));
        const completed = canonicalObligations(init.completed, "Completed Run obligation").map(
            (value) => {
                const canonical = reservedByKey.get(runObligationKey(value));
                if (canonical === undefined) {
                    throw new TypeError("Completed Run obligations must be reserved");
                }
                return canonical;
            }
        );
        this.run = init.run;
        this.epoch = init.epoch;
        this.accepting = init.accepting;
        this.reserved = reserved;
        this.completed = Object.freeze(completed);
        Object.freeze(this);
    }

    public static initial(run: RunId): RunAdmissionRegistry {
        return new RunAdmissionRegistry({
            run,
            epoch: 0,
            accepting: true,
            reserved: [],
            completed: []
        });
    }

    public reserve(obligation: RunObligation): RunObligationReservation {
        if (!this.accepting) {
            throw invalid("Run admission registry is closed");
        }
        const candidate = copyRunObligation(obligation);
        const key = runObligationKey(candidate);
        const existing = this.reserved.find((value) => runObligationKey(value) === key);
        const registry =
            existing === undefined
                ? new RunAdmissionRegistry({
                      run: this.run,
                      epoch: this.epoch,
                      accepting: true,
                      reserved: [...this.reserved, candidate],
                      completed: this.completed
                  })
                : this;
        return Object.freeze({
            registry,
            reservation: Object.freeze({
                run: this.run,
                registryEpoch: this.epoch,
                obligation: existing ?? candidate
            })
        });
    }

    public accepts(reservation: RunAdmissionReservation): boolean {
        if (
            !this.accepting ||
            !this.run.equals(reservation.run) ||
            this.epoch !== reservation.registryEpoch
        ) {
            return false;
        }
        try {
            const key = runObligationKey(reservation.obligation);
            return this.reserved.some((value) => runObligationKey(value) === key);
        } catch (error) {
            if (error instanceof TypeError) return false;
            throw error;
        }
    }

    public complete(reservation: RunAdmissionReservation): RunAdmissionRegistry {
        const key = this.completionKey(reservation);
        if (key === undefined) {
            throw invalid("Only an exact reserved Run obligation can complete");
        }
        if (this.completed.some((value) => runObligationKey(value) === key)) return this;
        const obligation = this.reserved.find((value) => runObligationKey(value) === key)!;
        return new RunAdmissionRegistry({
            run: this.run,
            epoch: this.epoch,
            accepting: this.accepting,
            reserved: this.reserved,
            completed: [...this.completed, obligation]
        });
    }

    public close(): RunAdmissionRegistry {
        if (!this.accepting) return this;
        if (this.epoch === Number.MAX_SAFE_INTEGER) {
            throw invalid("Run admission registry epoch is exhausted");
        }
        return new RunAdmissionRegistry({
            run: this.run,
            epoch: this.epoch + 1,
            accepting: false,
            reserved: this.reserved,
            completed: this.completed
        });
    }

    public frontier(): readonly RunObligation[] {
        const completed = new Set(this.completed.map(runObligationKey));
        return Object.freeze(
            this.reserved
                .filter((value) => !completed.has(runObligationKey(value)))
                .map(copyRunObligation)
        );
    }

    public toData(): JsonValue {
        return {
            accepting: this.accepting,
            completed: this.completed.map(runObligationData),
            epoch: this.epoch,
            reserved: this.reserved.map(runObligationData),
            run: this.run.value
        };
    }

    public static fromData(value: JsonValue): RunAdmissionRegistry {
        const object = requireObject(value, "Run admission registry");
        requireExactFields(
            object,
            ["accepting", "completed", "epoch", "reserved", "run"],
            [],
            "Run admission registry"
        );
        if (typeof object["accepting"] !== "boolean") {
            throw new TypeError("Run admission registry accepting state is invalid");
        }
        return new RunAdmissionRegistry({
            run: new RunId(requireString(object["run"], "Run admission registry Run")),
            epoch: requireInteger(object["epoch"], "Run admission registry epoch"),
            accepting: object["accepting"],
            reserved: requireArray(object["reserved"], "Reserved Run obligations").map(
                decodeRunObligation
            ),
            completed: requireArray(object["completed"], "Completed Run obligations").map(
                decodeRunObligation
            )
        });
    }

    private completionKey(reservation: RunAdmissionReservation): string | undefined {
        const reservationEpoch = this.accepting ? this.epoch : this.epoch - 1;
        if (!this.run.equals(reservation.run) || reservation.registryEpoch !== reservationEpoch) {
            return undefined;
        }
        try {
            const key = runObligationKey(reservation.obligation);
            return this.reserved.some((value) => runObligationKey(value) === key) ? key : undefined;
        } catch (error) {
            if (error instanceof TypeError) return undefined;
            throw error;
        }
    }
}

class RunAdmissionRegistryRecordCodec extends RecordCodec<RunAdmissionRegistry> {
    public constructor() {
        super("run.admission-registry", { major: 1, minor: 0 });
    }

    protected encodePayload(value: RunAdmissionRegistry): JsonValue {
        return value.toData();
    }

    protected decodePayload(value: JsonValue): RunAdmissionRegistry {
        return RunAdmissionRegistry.fromData(value);
    }
}

export const RunAdmissionRegistryCodec: RecordCodec<RunAdmissionRegistry> =
    new RunAdmissionRegistryRecordCodec();

export abstract class RunAdmissionValidationPort<Transaction> {
    public abstract accepts(
        transaction: Transaction,
        reservation: RunAdmissionReservation
    ): boolean;
}

export function runObligationKey(obligation: RunObligation): string {
    const data = runObligationData(copyRunObligation(obligation));
    return JSON.stringify(data);
}

export function copyRunObligation(obligation: RunObligation): RunObligation {
    switch (obligation.kind) {
        case "approval":
            if (obligation.approval.constructor !== ApprovalId) requireExactIdentity("Approval");
            return Object.freeze({ kind: obligation.kind, approval: obligation.approval });
        case "invocationItem":
            if (obligation.invocation.constructor !== InvocationId) {
                requireExactIdentity("Invocation");
            }
            requireEpoch(obligation.itemIndex, "Run invocation item index");
            if (obligation.itemKey.length === 0) {
                throw new TypeError("Run invocation item key must be non-empty");
            }
            return Object.freeze({
                kind: obligation.kind,
                invocation: obligation.invocation,
                itemIndex: obligation.itemIndex,
                itemKey: obligation.itemKey
            });
        case "route":
            if (obligation.reservation.constructor !== RouteReservationId) {
                requireExactIdentity("Route reservation");
            }
            return Object.freeze({ kind: obligation.kind, reservation: obligation.reservation });
        case "reconciliation":
            if (obligation.attempt.constructor !== EffectAttemptId) {
                requireExactIdentity("Effect attempt");
            }
            return Object.freeze({ kind: obligation.kind, attempt: obligation.attempt });
        case "systemCommit":
            if (obligation.commit.constructor !== RunCommitId) {
                requireExactIdentity("Run commit");
            }
            return Object.freeze({ kind: obligation.kind, commit: obligation.commit });
        default:
            throw new TypeError("Run obligation kind is invalid");
    }
}

export function runObligationData(obligation: RunObligation): JsonValue {
    switch (obligation.kind) {
        case "approval":
            return { approval: obligation.approval.value, kind: obligation.kind };
        case "invocationItem":
            return {
                invocation: obligation.invocation.value,
                itemIndex: obligation.itemIndex,
                itemKey: obligation.itemKey,
                kind: obligation.kind
            };
        case "route":
            return { kind: obligation.kind, reservation: obligation.reservation.value };
        case "reconciliation":
            return { attempt: obligation.attempt.value, kind: obligation.kind };
        case "systemCommit":
            return { commit: obligation.commit.value, kind: obligation.kind };
    }
}

export function decodeRunObligation(value: JsonValue): RunObligation {
    const object = requireObject(value, "Run obligation");
    const kind = requireString(object["kind"], "Run obligation kind");
    switch (kind) {
        case "approval":
            requireExactFields(object, ["approval", "kind"], [], "Approval obligation");
            return copyRunObligation({
                kind,
                approval: new ApprovalId(requireString(object["approval"], "Approval obligation"))
            });
        case "invocationItem":
            requireExactFields(
                object,
                ["invocation", "itemIndex", "itemKey", "kind"],
                [],
                "Invocation item obligation"
            );
            return copyRunObligation({
                kind,
                invocation: new InvocationId(
                    requireString(object["invocation"], "Invocation item obligation")
                ),
                itemIndex: requireInteger(object["itemIndex"], "Invocation item obligation index"),
                itemKey: requireString(object["itemKey"], "Invocation item obligation key")
            });
        case "route":
            requireExactFields(object, ["kind", "reservation"], [], "Route obligation");
            return copyRunObligation({
                kind,
                reservation: new RouteReservationId(
                    requireString(object["reservation"], "Route obligation")
                )
            });
        case "reconciliation":
            requireExactFields(object, ["attempt", "kind"], [], "Reconciliation obligation");
            return copyRunObligation({
                kind,
                attempt: new EffectAttemptId(
                    requireString(object["attempt"], "Reconciliation obligation")
                )
            });
        case "systemCommit":
            requireExactFields(object, ["commit", "kind"], [], "System commit obligation");
            return copyRunObligation({
                kind,
                commit: new RunCommitId(requireString(object["commit"], "System commit obligation"))
            });
        default:
            throw new TypeError("Run obligation kind is invalid");
    }
}

function canonicalObligations(
    values: readonly RunObligation[],
    subject: string
): readonly RunObligation[] {
    if (!Array.isArray(values)) throw new TypeError(`${subject}s must be an array`);
    const result = values
        .map(copyRunObligation)
        .sort((left, right) => runObligationKey(left).localeCompare(runObligationKey(right)));
    if (new Set(result.map(runObligationKey)).size !== result.length) {
        throw new TypeError(`${subject}s must have unique canonical identities`);
    }
    return Object.freeze(result);
}

function requireEpoch(value: number, subject: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
}

function requireExactIdentity(subject: string): never {
    throw new TypeError(`${subject} obligation requires an exact canonical ID`);
}

function invalid(message: string): AgentCoreError {
    return new AgentCoreError("run.invalid-state", message);
}
