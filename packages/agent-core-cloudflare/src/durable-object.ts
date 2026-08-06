import { CloudflareSqlite, type CloudflareDurableObjectStorage } from "./sqlite.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import {
    SqliteApplicationMigrator,
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

export interface CloudflareDurableObjectAlarmStorage
    extends CloudflareDurableObjectStorage, AlarmStorageLike {}

export interface CloudflareDurableObjectStateLike extends HibernatingWebSocketContextLike {
    readonly storage: CloudflareDurableObjectAlarmStorage;
    blockConcurrencyWhile<Result>(callback: () => Promise<Result>): Promise<Result>;
}

/** The runtime's own claim on the object's single alarm. */
const RUNTIME_ALARM_OWNER = "agent-core.runtime";

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
    alarm(): void | Promise<void>;
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
    webSocketError(socket: HibernatingWebSocketLike, error: unknown): void | Promise<void>;
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
    alarm(): void | Promise<void>;
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
    webSocketError(socket: HibernatingWebSocketLike, error: unknown): void | Promise<void>;
}

export interface CloudflareDurableObjectClass<Environment> {
    new (
        state: CloudflareDurableObjectStateLike,
        environment: Environment
    ): CloudflareDurableObjectInstance;
}

export function createCloudflareDurableObjectClass<Environment>(
    options: CloudflareDurableObjectClassOptions<Environment>
): CloudflareDurableObjectClass<Environment> {
    const migrations = Object.freeze([
        ...cloudflareRuntimeMigrations,
        ...(options.migrations ?? [])
    ]);
    return class CloudflareActorDurableObject implements CloudflareDurableObjectInstance {
        readonly #host: AuthoritativeDurableObjectHost;
        readonly #startup: Promise<void>;

        public constructor(state: CloudflareDurableObjectStateLike, environment: Environment) {
            const sqlite = new CloudflareSqlite(state.storage, options.errors);
            new SqliteApplicationMigrator(sqlite, options.errors, migrations).migrate();
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
            this.#host = options.host.create(runtime);
            // A throwing callback resets the object in the real runtime; retaining the
            // rejection keeps every entry point fail-closed everywhere else. The extra
            // handler only marks it observed — `#started` is what reports it.
            this.#startup = state.blockConcurrencyWhile(() => this.#host.repairAlarm());
            this.#startup.catch(() => undefined);
        }

        async #started(): Promise<void> {
            try {
                await this.#startup;
            } catch (cause) {
                operationalFailure(
                    options.errors,
                    "protocol.invalid-state",
                    "Durable Object startup alarm repair failed",
                    cause
                );
            }
        }

        public async fetch(request: Request): Promise<Response> {
            await this.#started();
            return this.#host.fetch(request);
        }

        public async alarm(): Promise<void> {
            await this.#started();
            return this.#host.alarm();
        }

        public async webSocketMessage(
            socket: HibernatingWebSocketLike,
            message: string | ArrayBuffer
        ): Promise<void> {
            await this.#started();
            return this.#host.webSocketMessage(socket, message);
        }

        public async webSocketClose(
            socket: HibernatingWebSocketLike,
            code: number,
            reason: string,
            wasClean: boolean
        ): Promise<void> {
            await this.#started();
            return this.#host.webSocketClose(socket, code, reason, wasClean);
        }

        public async webSocketError(
            socket: HibernatingWebSocketLike,
            error: unknown
        ): Promise<void> {
            await this.#started();
            return this.#host.webSocketError(socket, error);
        }
    };
}
