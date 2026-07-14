import type { TransientContentAccess } from "../content";
import { Digest } from "../core";
import { AgentCoreError } from "../errors";
import { CommandAuthenticator, type CommandAuthentication } from "./authentication";
import {
    CommandCommitUnknownError,
    type CommandAdmission,
    type CommandDispatcher,
    type CommandDispatchResult
} from "./dispatcher";
import type { CommandEnvelope } from "./envelope";
import {
    PayloadLeaseBinding,
    inspectPreparedCommandPayload,
    issueLeasedCommandPayload,
    issueMalformedCommandPayload,
    type PreparedCommandPayload
} from "./payload";

export type PreDispatchPhase = "admissionPreflight" | "dispatch";
export type CommitCertainty = "notAttempted" | "rolledBack" | "unknown";
export type RetryInstruction = "mayRetry" | "retrySameKey";

export interface PreDispatchFailure {
    readonly kind: "preDispatchFailure";
    readonly phase: PreDispatchPhase;
    readonly commit: CommitCertainty;
    readonly retry: RetryInstruction;
    readonly cause: unknown;
}

export type CommandIngressResult = CommandDispatchResult | PreDispatchFailure;

export interface CommandIngressInit<
    Transaction,
    Read,
    ReadTransaction = Transaction,
    Transport = unknown
> {
    readonly dispatcher: CommandDispatcher<Transaction, Read, ReadTransaction>;
    readonly content: TransientContentAccess;
    readonly authenticator?: CommandAuthenticator<Transport>;
    readonly leaseForMilliseconds?: number;
    // Removed once W2/W4 rename their owned composition input.
    readonly holdForMilliseconds?: number;
    readonly now?: () => Date;
}

export class CommandIngress<Transaction, Read, ReadTransaction = Transaction, Transport = unknown> {
    readonly #dispatcher: CommandDispatcher<Transaction, Read, ReadTransaction>;
    readonly #content: TransientContentAccess;
    readonly #authenticator: CommandAuthenticator<Transport>;
    readonly #leaseForMilliseconds: number;
    readonly #now: () => Date;

    public constructor(init: CommandIngressInit<Transaction, Read, ReadTransaction, Transport>) {
        const leaseForMilliseconds = init.leaseForMilliseconds ?? init.holdForMilliseconds;
        if (
            !Number.isSafeInteger(leaseForMilliseconds) ||
            leaseForMilliseconds === undefined ||
            leaseForMilliseconds <= 0
        ) {
            throw new TypeError("Command payload lease duration must be a positive safe integer");
        }
        this.#dispatcher = init.dispatcher;
        this.#content = init.content;
        if (!(init.authenticator instanceof CommandAuthenticator)) {
            throw new TypeError("Command ingress requires a transport authenticator");
        }
        this.#authenticator = init.authenticator;
        this.#leaseForMilliseconds = leaseForMilliseconds;
        this.#now = init.now ?? (() => new Date());
    }

    public async accept(
        rawEnvelope: Uint8Array,
        transport: Transport,
        submittedBytes?: Uint8Array
    ): Promise<CommandIngressResult> {
        const submittedEnvelope = rawEnvelope.slice();
        const submittedPayload = submittedBytes?.slice();
        const speculativeEnvelope = this.#dispatcher.decodeForPreparation(submittedEnvelope);
        const authenticationEnvelope = this.#dispatcher.decodeForAuthentication(submittedEnvelope);

        let authentication: CommandAuthentication | undefined;
        try {
            authentication =
                authenticationEnvelope === undefined
                    ? undefined
                    : await this.#authenticator.authenticate(
                          transport,
                          authenticationEnvelope,
                          Digest.sha256(submittedEnvelope)
                      );
        } catch (error) {
            return preDispatchFailure("admissionPreflight", error, false);
        }

        let admission: CommandAdmission;
        try {
            admission = await this.#dispatcher.admit(submittedEnvelope, authentication);
        } catch (error) {
            return preDispatchFailure("admissionPreflight", error, true);
        }
        if (admission.kind === "completed") return admission.result;

        let prepared: PreparedCommandPayload;
        try {
            prepared =
                speculativeEnvelope === undefined
                    ? issueMalformedCommandPayload("absent")
                    : await this.prepare(submittedEnvelope, speculativeEnvelope, submittedPayload);
        } catch (error) {
            return preDispatchFailure("admissionPreflight", error, false);
        }

        try {
            return await admission.dispatch(prepared);
        } catch (error) {
            return preDispatchFailure("dispatch", error, true);
        } finally {
            try {
                await inspectPreparedCommandPayload(prepared)?.lease?.close();
            } catch {
                // Expiry provides cleanup recovery; closing cannot alter the command result.
            }
        }
    }

    private async prepare(
        rawEnvelope: Uint8Array,
        envelope: CommandEnvelope,
        submittedBytes: Uint8Array | undefined
    ): Promise<PreparedCommandPayload> {
        const binding = new PayloadLeaseBinding(
            this.#dispatcher.tenant,
            this.#dispatcher.actor,
            Digest.sha256(rawEnvelope),
            envelope.payload,
            envelope.payloadDigest,
            leaseExpiry(this.#now(), this.#leaseForMilliseconds)
        );
        if (!envelope.payload.digest.equals(envelope.payloadDigest)) {
            return issueMalformedCommandPayload("referenceMismatch");
        }
        if (submittedBytes !== undefined) {
            if (submittedBytes.byteLength > this.#dispatcher.limits.payloadBytes) {
                return issueMalformedCommandPayload("tooLarge");
            }
            const submittedDigest = Digest.sha256(submittedBytes);
            if (!submittedDigest.equals(envelope.payloadDigest)) {
                return issueMalformedCommandPayload("submittedMismatch");
            }
        }
        const lease = await this.#content.acquire(binding, submittedBytes);
        return lease === undefined
            ? issueMalformedCommandPayload("missing")
            : issueLeasedCommandPayload(lease, binding);
    }
}

function preDispatchFailure(
    phase: PreDispatchPhase,
    cause: unknown,
    transactionAttempted: boolean
): PreDispatchFailure {
    const unknown = transactionAttempted && cause instanceof CommandCommitUnknownError;
    const retrySameKey = unknown && cause.retrySameKey;
    return {
        kind: "preDispatchFailure",
        phase,
        commit: unknown ? "unknown" : transactionAttempted ? "rolledBack" : "notAttempted",
        retry: retrySameKey ? "retrySameKey" : "mayRetry",
        cause
    };
}

function leaseExpiry(now: Date, duration: number): Date {
    const nowTime = now.getTime();
    const expiresAt = nowTime + duration;
    if (!Number.isFinite(nowTime) || !Number.isSafeInteger(expiresAt)) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Command payload lease expiry is invalid"
        );
    }
    return new Date(expiresAt);
}
