import { AgentCoreError } from "@agent-core/core";
import { CloudflareSqlite, type CloudflareDurableObjectStorage } from "./sqlite.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import {
    SqliteApplicationMigrator,
    UNREADABLE_SCHEMA,
    cloudflareRuntimeMigrations,
    type SqliteApplicationMigration
} from "./migration.js";
import { DurableViewRevisionLog } from "./revision-log.js";
import {
    HibernatingViewSocketAdapter,
    type HibernatingWebSocketContextLike,
    type HibernatingWebSocketLike
} from "./websocket.js";
import { contentRepositoryFromR2Binding, type R2BucketBinding } from "./r2.js";
import type { R2ContentObjectRepository } from "./content-object.js";
import type { AlarmStorageLike } from "./reconciliation.js";
import { DurableAlarmClaims } from "./alarm-claims.js";
import { AlarmInvocation, type CloudflareAlarmInvocationInfoLike } from "./alarm-invocation.js";

export interface CloudflareDurableObjectAlarmStorage
    extends CloudflareDurableObjectStorage, AlarmStorageLike {}

export interface CloudflareDurableObjectStateLike extends HibernatingWebSocketContextLike {
    readonly storage: CloudflareDurableObjectAlarmStorage;
    blockConcurrencyWhile<Result>(callback: () => Promise<Result>): Promise<Result>;
}

/** The runtime's own claim on the object's single alarm. */
const RUNTIME_ALARM_OWNER = "agent-core.runtime";

/**
 * How long the object's own start-time alarm repair may take. `blockConcurrencyWhile`
 * stalls the whole object and the platform resets it at thirty seconds or on any throw
 * (https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile), so
 * a host callback that never settles would take the object down with no diagnosis. A
 * budget well inside that window turns the stall into a refusal the platform recovers
 * from: the outbox is untouched, the next instantiation repairs again, and no schedule is
 * lost because the outbox and not the alarm slot is the state repair reads.
 */
const STARTUP_REPAIR_BUDGET_MILLISECONDS = 10_000;

export interface CloudflareDurableObjectRuntime<Environment> {
    readonly state: CloudflareDurableObjectStateLike;
    readonly environment: Environment;
    readonly sqlite: CloudflareSqlite;
    readonly revisions: DurableViewRevisionLog;
    readonly webSockets: HibernatingViewSocketAdapter;
    /** The object's single alarm, arbitrated per owner; see `alarmClaims`. */
    readonly alarms: AlarmStorageLike;
    /** Mint an `AlarmStorageLike` per scheduler so two owners cannot clobber each other. */
    readonly alarmClaims: DurableAlarmClaims;
    readonly content: R2ContentObjectRepository | undefined;
}

export interface AuthoritativeDurableObjectHost {
    repairAlarm(): Promise<void>;
    fetch(request: Request): Response | Promise<Response>;
    /**
     * Runs one delivery of the object's single alarm. `invocation` reports what the
     * platform said about this delivery, so a sweep can see the re-firing budget running
     * out; a host that does not care may declare `alarm()` with no parameter.
     */
    alarm(invocation: AlarmInvocation): void | Promise<void>;
    webSocketMessage(
        socket: HibernatingWebSocketLike,
        message: string | ArrayBuffer
    ): void | Promise<void>;
    webSocketClose(
        socket: HibernatingWebSocketLike,
        code: number,
        reason: string,
        wasClean: boolean
    ): void | Promise<void>;
    webSocketError(socket: HibernatingWebSocketLike, error: Error): void | Promise<void>;
}

export interface AuthoritativeDurableObjectHostFactory<Environment> {
    create(runtime: CloudflareDurableObjectRuntime<Environment>): AuthoritativeDurableObjectHost;
}

export interface CloudflareDurableObjectClassOptions<Environment> {
    readonly errors: CloudflareErrorPort;
    readonly host: AuthoritativeDurableObjectHostFactory<Environment>;
    readonly migrations?: readonly SqliteApplicationMigration[];
    readonly contentBucket?: R2BucketBinding<Environment>;
}

export interface CloudflareDurableObjectInstance {
    fetch(request: Request): Response | Promise<Response>;
    alarm(alarmInfo?: CloudflareAlarmInvocationInfoLike): void | Promise<void>;
    webSocketMessage(
        socket: HibernatingWebSocketLike,
        message: string | ArrayBuffer
    ): void | Promise<void>;
    webSocketClose(
        socket: HibernatingWebSocketLike,
        code: number,
        reason: string,
        wasClean: boolean
    ): void | Promise<void>;
    webSocketError(socket: HibernatingWebSocketLike, error: Error): void | Promise<void>;
}

export interface CloudflareDurableObjectClass<Environment> {
    new (
        state: CloudflareDurableObjectStateLike,
        environment: Environment
    ): CloudflareDurableObjectInstance;
}

/**
 * Whether an instantiated object may serve. Construction always succeeds, so an object
 * whose applied schema this release cannot read carries the refusal its operations raise
 * instead of a host it must never reach.
 */
type DurableObjectAdmission =
    | {
          readonly serving: true;
          readonly host: AuthoritativeDurableObjectHost;
          readonly startup: Promise<void>;
      }
    | { readonly serving: false; readonly refusal: AgentCoreError };

export function createCloudflareDurableObjectClass<Environment>(
    options: CloudflareDurableObjectClassOptions<Environment>
): CloudflareDurableObjectClass<Environment> {
    const migrations = Object.freeze([
        ...cloudflareRuntimeMigrations,
        ...(options.migrations ?? [])
    ]);
    return class CloudflareActorDurableObject implements CloudflareDurableObjectInstance {
        readonly #admission: DurableObjectAdmission;

        public constructor(state: CloudflareDurableObjectStateLike, environment: Environment) {
            const sqlite = new CloudflareSqlite(state.storage, options.errors);
            try {
                new SqliteApplicationMigrator(sqlite, options.errors, migrations).migrate();
            } catch (failure) {
                // A schema this release cannot read is permanent: the object stays
                // unreadable until a release that declares its markers is deployed, and an
                // object that throws here can never be reached to diagnose or drain. Every
                // other failure is transient, and letting it reset the object is what makes
                // the platform's retry worth having.
                if (!(failure instanceof AgentCoreError) || failure.code !== UNREADABLE_SCHEMA) {
                    throw failure;
                }
                this.#admission = Object.freeze({ serving: false, refusal: failure });
                return;
            }
            const revisions = new DurableViewRevisionLog(sqlite, options.errors);
            const alarmClaims = new DurableAlarmClaims(sqlite, options.errors);
            const runtime = Object.freeze({
                state,
                environment,
                sqlite,
                revisions,
                webSockets: new HibernatingViewSocketAdapter(state, revisions, options.errors),
                alarms: alarmClaims.owner(RUNTIME_ALARM_OWNER, state.storage),
                alarmClaims,
                content:
                    options.contentBucket === undefined
                        ? undefined
                        : contentRepositoryFromR2Binding(
                              environment,
                              options.contentBucket,
                              options.errors
                          )
            });
            const host = options.host.create(runtime);
            // Touching the alarm from the constructor is a documented hazard, because the
            // constructor runs before the alarm handler on wake
            // (https://developers.cloudflare.com/durable-objects/api/alarms/#setalarm). It is
            // sound here for one reason: the repair derives the wakeup from the claim table
            // rather than calling setAlarm unconditionally, so an armed schedule the object
            // is about to serve survives being rebuilt from the state it was armed out of.
            // A throwing callback resets the object in the real runtime; retaining the
            // rejection keeps every entry point fail-closed everywhere else. The extra
            // handler only marks it observed — `#serving` is what reports it.
            const startup = state.blockConcurrencyWhile(() =>
                withinStartupBudget(host.repairAlarm())
            );
            startup.catch(() => undefined);
            this.#admission = Object.freeze({ serving: true, host, startup });
        }

        async #serving(): Promise<AuthoritativeDurableObjectHost> {
            const admission = this.#admission;
            if (!admission.serving) throw admission.refusal;
            try {
                await admission.startup;
            } catch (cause) {
                operationalFailure(
                    options.errors,
                    "protocol.invalid-state",
                    "Durable Object startup alarm repair failed",
                    { value: cause }
                );
            }
            return admission.host;
        }

        public async fetch(request: Request): Promise<Response> {
            return (await this.#serving()).fetch(request);
        }

        public async alarm(alarmInfo?: CloudflareAlarmInvocationInfoLike): Promise<void> {
            return (await this.#serving()).alarm(AlarmInvocation.from(alarmInfo));
        }

        public async webSocketMessage(
            socket: HibernatingWebSocketLike,
            message: string | ArrayBuffer
        ): Promise<void> {
            return (await this.#serving()).webSocketMessage(socket, message);
        }

        public async webSocketClose(
            socket: HibernatingWebSocketLike,
            code: number,
            reason: string,
            wasClean: boolean
        ): Promise<void> {
            return (await this.#serving()).webSocketClose(socket, code, reason, wasClean);
        }

        public async webSocketError(socket: HibernatingWebSocketLike, error: Error): Promise<void> {
            return (await this.#serving()).webSocketError(socket, error);
        }
    };
}

/**
 * Settles with the repair, or rejects once the startup budget passes. The timer is always
 * cleared, because a pending one would hold the object alive past the work it was watching.
 */
async function withinStartupBudget(repair: Promise<void>): Promise<void> {
    let cancel: (() => void) | undefined;
    const budget = new Promise<never>((_resolve, reject) => {
        const handle = setTimeout(() => {
            reject(
                new AgentCoreError(
                    "protocol.invalid-state",
                    "Durable Object startup alarm repair exceeded its " +
                        `${STARTUP_REPAIR_BUDGET_MILLISECONDS}ms budget`
                )
            );
        }, STARTUP_REPAIR_BUDGET_MILLISECONDS);
        cancel = () => clearTimeout(handle);
    });
    try {
        await Promise.race([repair, budget]);
    } finally {
        cancel?.();
    }
}
