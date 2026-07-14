import { CloudflareSqlite, type CloudflareDurableObjectStorage } from "./sqlite.js";
import type { CloudflareErrorPort } from "./error.js";
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

export interface CloudflareDurableObjectAlarmStorage
    extends CloudflareDurableObjectStorage, AlarmStorageLike {}

export interface CloudflareDurableObjectStateLike extends HibernatingWebSocketContextLike {
    readonly storage: CloudflareDurableObjectAlarmStorage;
    blockConcurrencyWhile<Result>(callback: () => Promise<Result>): Promise<Result>;
}

export interface CloudflareDurableObjectRuntime<Environment> {
    readonly state: CloudflareDurableObjectStateLike;
    readonly environment: Environment;
    readonly sqlite: CloudflareSqlite;
    readonly revisions: DurableViewRevisionLog;
    readonly webSockets: HibernatingViewSocketAdapter;
    readonly alarms: AlarmStorageLike;
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

        public constructor(state: CloudflareDurableObjectStateLike, environment: Environment) {
            const sqlite = new CloudflareSqlite(state.storage, options.errors);
            new SqliteApplicationMigrator(sqlite, options.errors, migrations).migrate();
            const revisions = new DurableViewRevisionLog(sqlite, options.errors);
            const runtime = Object.freeze({
                state,
                environment,
                sqlite,
                revisions,
                webSockets: new HibernatingViewSocketAdapter(state, revisions, options.errors),
                alarms: state.storage,
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
            void state.blockConcurrencyWhile(() => this.#host.repairAlarm());
        }

        public fetch(request: Request): Response | Promise<Response> {
            return this.#host.fetch(request);
        }

        public alarm(): void | Promise<void> {
            return this.#host.alarm();
        }

        public webSocketMessage(
            socket: HibernatingWebSocketLike,
            message: string | ArrayBuffer
        ): void | Promise<void> {
            return this.#host.webSocketMessage(socket, message);
        }

        public webSocketClose(
            socket: HibernatingWebSocketLike,
            code: number,
            reason: string,
            wasClean: boolean
        ): void | Promise<void> {
            return this.#host.webSocketClose(socket, code, reason, wasClean);
        }

        public webSocketError(
            socket: HibernatingWebSocketLike,
            error: unknown
        ): void | Promise<void> {
            return this.#host.webSocketError(socket, error);
        }
    };
}
