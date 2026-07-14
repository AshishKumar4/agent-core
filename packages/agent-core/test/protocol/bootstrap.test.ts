import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TurnId } from "../../src/agents";
import { ActorId, ActorRef } from "../../src/actors";
import { MemoryTenantControlStore } from "../../src/authority";
import { ContentRef, Digest, Revision, encodeCanonicalJson, type JsonValue } from "../../src/core";
import { AgentCoreError } from "../../src/errors";
import { PrincipalId, PrincipalRef, RoleName, ScopeRef, TenantId } from "../../src/identity";
import * as protocol from "../../src/protocol/public";
import {
    CommandEnvelope,
    CommandEnvelopeCodec,
    CommandAuthenticator,
    TenantBootstrapAnchorRecord,
    createTenantBootstrapCommand,
    createMemoryTenantBootstrap as createMemoryTenantBootstrapComposition,
    tenantBootstrapPayload,
    type CommandCaller,
    type LeaseToken,
    type MemoryTenantBootstrap,
    type MemoryTenantBootstrapInit,
    type MemoryTenantBootstrapSnapshot,
    type TenantBootstrapAnchor
} from "../../src/protocol";
import {
    createSqliteTenantControlStore,
    createSqliteTenantBootstrap as createSqliteTenantBootstrapComposition,
    type SqliteRow,
    type SqliteTenantBootstrapInit,
    type SqliteValue
} from "../../src/substrates";
import { FileSqlite, TestSqlite } from "../helpers/sqlite";
import { CounterContentStore } from "./counter-fixture";

const actor = new ActorRef("tenant", new ActorId("bootstrap-actor"));
const tenantId = new TenantId("bootstrap-tenant");
const principalId = new PrincipalId("bootstrap-owner");
const tenantScope = ScopeRef.tenant(tenantId);
const anchor: TenantBootstrapAnchor = Object.freeze({
    actorId: actor.id,
    tenantId,
    principalId,
    tenantKind: "organization",
    trustAnchor: Uint8Array.of(4, 5, 6)
});
const caller: CommandCaller = {
    kind: "principal",
    principal: new PrincipalRef(tenantId, principalId)
};
const ownerTransport = Symbol("bootstrap-owner");
const forgedTransport = Symbol("bootstrap-forged");
const foreignTransport = Symbol("bootstrap-foreign");
const forgedCaller: CommandCaller = {
    kind: "principal",
    principal: new PrincipalRef(tenantId, new PrincipalId("forged-owner"))
};
const foreignCaller: CommandCaller = {
    kind: "principal",
    principal: new PrincipalRef(
        new TenantId("foreign-bootstrap-tenant"),
        new PrincipalId("foreign-bootstrap-principal")
    )
};

class BootstrapAuthenticator extends CommandAuthenticator<symbol> {
    public constructor() {
        super(tenantId);
    }

    protected authenticateTransport(transport: symbol): CommandCaller | undefined {
        if (transport === ownerTransport) return caller;
        if (transport === forgedTransport) return forgedCaller;
        if (transport === foreignTransport) return foreignCaller;
        return undefined;
    }
}

function createMemoryTenantBootstrap(
    init: Omit<MemoryTenantBootstrapInit<symbol>, "authenticator">
): MemoryTenantBootstrap<symbol> {
    return createMemoryTenantBootstrapComposition({
        ...init,
        authenticator: new BootstrapAuthenticator()
    });
}

function createSqliteTenantBootstrap(
    init: Omit<SqliteTenantBootstrapInit<symbol>, "authenticator">
) {
    return createSqliteTenantBootstrapComposition({
        ...init,
        authenticator: new BootstrapAuthenticator()
    });
}

describe("tenant.bootstrap concrete compositions", () => {
    test("[protocol.tenant-bootstrap-anchor] memory composition creates and restores the complete closure", async () => {
        const content = new CounterContentStore(() => undefined);
        const first = createMemoryTenantBootstrap({ actor, anchor, content });
        const raw = envelope(content, { key: "memory-bootstrap" });

        const committed = await first.dispatch(raw, ownerTransport);
        const restarted = createMemoryTenantBootstrap({
            actor,
            anchor,
            content: new CounterContentStore(() => undefined),
            snapshot: first.snapshot()
        });
        const duplicate = await restarted.dispatch(raw, ownerTransport);

        expect(committed.outcome).toBe("committed");
        expect(duplicate.outcome).toBe("duplicate");
        expect(duplicate.reply).toEqual(committed.reply);
        expect(memoryClosure(restarted)).toEqual(completeClosure());
        expect(memoryEvidence(restarted)).toEqual({ audits: 4, identities: 1, writes: 2 });
    });

    test("[protocol.tenant-bootstrap-anchor] [protocol.tenant-bootstrap-marker] file SQLite composition creates and restores the complete closure", async () => {
        const directory = mkdtempSync(join(tmpdir(), "tenant-bootstrap-composition-"));
        const path = join(directory, "tenant.sqlite");
        let database: FileSqlite | undefined;
        try {
            database = new FileSqlite(path);
            const content = new CounterContentStore(() => undefined);
            const first = createSqliteTenantBootstrap({ database, actor, anchor, content });
            const raw = envelope(content, { key: "sqlite-bootstrap" });
            const committed = await first.dispatch(raw, ownerTransport);
            database.close();
            database = undefined;

            database = new FileSqlite(path);
            const restarted = createSqliteTenantBootstrap({
                database,
                actor,
                content: new CounterContentStore(() => undefined)
            });
            const duplicate = await restarted.dispatch(raw, ownerTransport);

            expect(committed.outcome).toBe("committed");
            expect(duplicate.outcome).toBe("duplicate");
            expect(sqliteClosure(database)).toEqual(completeClosure());
            expect(sqliteEvidence(database)).toEqual({ audits: 4, identities: 1, writes: 2 });
        } finally {
            database?.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test.each(["memory", "SQLite"] as const)(
        "%s rejects forged caller, revision, lease, and payload records",
        async (kind) => {
            const content = new CounterContentStore(() => undefined);
            const composition =
                kind === "memory"
                    ? createMemoryTenantBootstrap({ actor, anchor, content })
                    : createSqliteTenantBootstrap({
                          database: new TestSqlite(),
                          actor,
                          anchor,
                          content
                      });
            const lease: LeaseToken = {
                turn: new TurnId("forbidden-turn"),
                holder: caller.principal,
                epoch: 1
            };

            expect(
                (
                    await composition.dispatch(
                        envelope(content, { caller: forgedCaller }),
                        forgedTransport
                    )
                ).outcome
            ).toBe("rejectedAuthority");
            expect(
                (
                    await composition.dispatch(
                        envelope(content, {
                            caller: foreignCaller,
                            key: "foreign-tenant-caller"
                        }),
                        foreignTransport
                    )
                ).outcome
            ).toBe("rejectedAuthentication");
            expect(
                (
                    await composition.dispatch(
                        envelope(content, {
                            expectedRevision: Revision.initial().next(),
                            key: "wrong-revision"
                        }),
                        ownerTransport
                    )
                ).outcome
            ).toBe("rejectedRevision");
            expect(
                (
                    await composition.dispatch(
                        envelope(content, {
                            key: "forbidden-lease",
                            lease
                        }),
                        ownerTransport
                    )
                ).outcome
            ).toBe("rejectedLease");
            expect(
                (
                    await composition.dispatch(
                        envelope(content, {
                            key: "supplied-records",
                            payload: encodeCanonicalJson({ grants: [], tenant: "forged" })
                        }),
                        ownerTransport
                    )
                ).outcome
            ).toBe("rejectedMalformed");
        }
    );

    test.each(["memory", "SQLite"] as const)(
        "%s rejects an unauthenticated bootstrap before creating Tenant state",
        async (kind) => {
            const content = new CounterContentStore(() => undefined);
            const composition =
                kind === "memory"
                    ? createMemoryTenantBootstrap({ actor, anchor, content })
                    : createSqliteTenantBootstrap({
                          database: new TestSqlite(),
                          actor,
                          anchor,
                          content
                      });

            const result = await composition.dispatch(
                envelope(content, { key: `unauthenticated-${kind}` }),
                Symbol(`unknown-${kind}`)
            );

            expect(result.outcome).toBe("rejectedAuthentication");
            expect(result.write.caller).toEqual(caller);
            expect(result.write.idempotencyKey).toBeUndefined();
        }
    );

    test("SQLite composition rejects wrong Actor kind and corrupt protocol ID state", async () => {
        const content = new CounterContentStore(() => undefined);
        expect(() =>
            createSqliteTenantBootstrap({
                database: new TestSqlite(),
                actor: new ActorRef("workspace", new ActorId("wrong-bootstrap-kind")),
                anchor,
                content
            })
        ).toThrow(AgentCoreError);

        const database = new TestSqlite();
        const composition = createSqliteTenantBootstrap({ database, actor, anchor, content });
        database.run("DELETE FROM tenant_bootstrap_protocol_ids", []);
        await expect(
            composition.dispatch(
                envelope(content, {
                    key: "missing-protocol-id"
                }),
                ownerTransport
            )
        ).rejects.toThrow(/protocol ID state/);
        database.run(
            "INSERT INTO tenant_bootstrap_protocol_ids (singleton, next_id) VALUES (1, ?)",
            [Number.MAX_SAFE_INTEGER + 1]
        );
        expect(() => createSqliteTenantBootstrap({ database, actor, content })).toThrow(
            AgentCoreError
        );
    });

    test("SQLite composition rejects Actor drift and protocol ID exhaustion", async () => {
        const content = new CounterContentStore(() => undefined);
        const database = new TestSqlite();
        const composition = createSqliteTenantBootstrap({ database, actor, anchor, content });
        expect(() =>
            createSqliteTenantBootstrap({
                database,
                actor: new ActorRef("tenant", new ActorId("different-bootstrap-actor")),
                content
            })
        ).toThrow(AgentCoreError);

        database.run("UPDATE tenant_bootstrap_protocol_ids SET next_id = ? WHERE singleton = 1", [
            Number.MAX_SAFE_INTEGER
        ]);
        await expect(
            composition.dispatch(
                envelope(content, {
                    key: "exhausted-sqlite-id"
                }),
                ownerTransport
            )
        ).rejects.toMatchObject({ code: "protocol.invalid-state" });
        expect(
            database.all(
                "SELECT next_id FROM tenant_bootstrap_protocol_ids WHERE singleton = 1",
                []
            )[0]?.["next_id"]
        ).toBe(Number.MAX_SAFE_INTEGER);
    });

    test("SQLite composition rejects negative persisted protocol IDs", () => {
        const content = new CounterContentStore(() => undefined);
        const database = new TestSqlite();
        createSqliteTenantBootstrap({ database, actor, anchor, content });
        database.run("PRAGMA ignore_check_constraints = ON", []);
        database.run(
            "UPDATE tenant_bootstrap_protocol_ids SET next_id = -1 WHERE singleton = 1",
            []
        );
        expect(() => createSqliteTenantBootstrap({ database, actor, content })).toThrow(
            AgentCoreError
        );
    });

    test.each(["raw-write", "typed-write", "typed-read", "lost-write"] as const)(
        "SQLite composition translates %s protocol ID failures",
        async (failure) => {
            const content = new CounterContentStore(() => undefined);
            const database = new FaultSqlite();
            const composition = createSqliteTenantBootstrap({ database, actor, anchor, content });
            database.failure = failure;
            await expect(
                composition.dispatch(
                    envelope(content, {
                        key: `sqlite-id-${failure}`
                    }),
                    ownerTransport
                )
            ).rejects.toBeInstanceOf(AgentCoreError);
        }
    );

    test("SQLite bootstrap payload codec rejects non-object canonical payloads", async () => {
        const content = new CounterContentStore(() => undefined);
        const composition = createSqliteTenantBootstrap({
            database: new TestSqlite(),
            actor,
            anchor,
            content
        });
        expect(
            (
                await composition.dispatch(
                    envelope(content, {
                        key: "null-payload",
                        payload: encodeCanonicalJson(null)
                    }),
                    ownerTransport
                )
            ).outcome
        ).toBe("rejectedMalformed");
        expect(
            (
                await composition.dispatch(
                    envelope(content, {
                        key: "array-payload",
                        payload: encodeCanonicalJson([])
                    }),
                    ownerTransport
                )
            ).outcome
        ).toBe("rejectedMalformed");
    });

    test("memory bootstrap restart rejects changed durable anchor", () => {
        const content = new CounterContentStore(() => undefined);
        const composition = createMemoryTenantBootstrap({ actor, anchor, content });
        expect(() =>
            createMemoryTenantBootstrap({
                actor,
                anchor: { ...anchor, trustAnchor: Uint8Array.of(9) },
                content,
                snapshot: composition.snapshot()
            })
        ).toThrow(AgentCoreError);
    });

    test("memory bootstrap rejects deep snapshot corruption and ID exhaustion", async () => {
        const content = new CounterContentStore(() => undefined);
        const composition = createMemoryTenantBootstrap({ actor, anchor, content });
        const snapshot = composition.snapshot();
        const opaque = snapshot.opaque as {
            readonly state: { readonly protocol: unknown; readonly nextId: number };
        };
        try {
            createMemoryTenantBootstrap({
                actor,
                anchor,
                content,
                snapshot: {
                    version: 1,
                    opaque: {
                        ...(snapshot.opaque as object),
                        state: { ...opaque.state, protocol: {} }
                    }
                }
            });
            throw new Error("Expected corrupt snapshot rejection");
        } catch (error) {
            expect(error).toBeInstanceOf(AgentCoreError);
            expect(error).toMatchObject({ code: "codec.invalid" });
        }

        const exhausted = createMemoryTenantBootstrap({
            actor,
            anchor,
            content,
            snapshot: {
                version: 1,
                opaque: {
                    ...(snapshot.opaque as object),
                    state: { ...opaque.state, nextId: Number.MAX_SAFE_INTEGER }
                }
            }
        });
        await expect(
            exhausted.dispatch(
                envelope(content, {
                    key: "exhausted-memory-id"
                }),
                ownerTransport
            )
        ).rejects.toMatchObject({ code: "protocol.invalid-state" });
    });

    test("memory bootstrap rejects malformed snapshot envelopes and Actor state", () => {
        const content = new CounterContentStore(() => undefined);
        const composition = createMemoryTenantBootstrap({ actor, anchor, content });
        const snapshot = composition.snapshot();
        const opaque = snapshot.opaque as {
            readonly actor: unknown;
            readonly recoveryState: Uint8Array | null;
            readonly state: { readonly control: { readonly version: number } };
        };
        const restore = (value: unknown) =>
            createMemoryTenantBootstrap({
                actor,
                anchor,
                content,
                snapshot: value as MemoryTenantBootstrapSnapshot
            });

        expect(() => restore(null)).toThrow(AgentCoreError);
        expect(() =>
            restore({
                version: 1,
                opaque: {
                    ...(snapshot.opaque as object),
                    state: {
                        ...opaque.state,
                        control: { ...opaque.state.control, version: 2 }
                    }
                }
            })
        ).toThrow(AgentCoreError);
        expect(() =>
            restore({
                version: 1,
                opaque: {
                    ...(snapshot.opaque as object),
                    actor: null,
                    recoveryState: Uint8Array.of(0)
                }
            })
        ).toThrow(AgentCoreError);
        expect(() =>
            restore({
                version: 1,
                opaque: {
                    ...(snapshot.opaque as object),
                    actor: { kind: "tenant", id: "x".repeat(257) },
                    recoveryState: null
                }
            })
        ).toThrow(AgentCoreError);
        expect(() =>
            restore({
                version: 1,
                opaque: {
                    ...(snapshot.opaque as object),
                    state: { ...opaque.state, nextId: -1 }
                }
            })
        ).toThrow(AgentCoreError);
        expect(() =>
            createMemoryTenantBootstrap({
                actor: new ActorRef("tenant", new ActorId("different-bootstrap-actor")),
                anchor,
                content,
                snapshot
            })
        ).toThrow(AgentCoreError);
    });

    test("anchor codec rejects malformed payloads and accepts every Tenant kind", () => {
        expect(() => TenantBootstrapAnchorRecord.decode(anchorEnvelope(null))).toThrow(
            AgentCoreError
        );
        expect(() => TenantBootstrapAnchorRecord.decode(anchorEnvelope({}))).toThrow(
            AgentCoreError
        );
        expect(() =>
            TenantBootstrapAnchorRecord.decode(
                anchorEnvelope({
                    actorId: 3,
                    principalId: principalId.value,
                    tenantId: tenantId.value,
                    tenantKind: "organization",
                    trustAnchor: "BAUG"
                })
            )
        ).toThrow(AgentCoreError);
        expect(() => new TenantBootstrapAnchorRecord({ ...anchor, actorId: "" as never })).toThrow(
            TypeError
        );

        const service = TenantBootstrapAnchorRecord.decode(
            anchorEnvelope({
                actorId: actor.id.value,
                principalId: principalId.value,
                tenantId: tenantId.value,
                tenantKind: "service",
                trustAnchor: "BAUG"
            })
        );
        expect(service.tenantKind).toBe("service");
    });

    test("typed bootstrap reply and observation codecs reject malformed wire values", () => {
        let currentAnchor: TenantBootstrapAnchor | undefined = anchor;
        const store = {
            anchor: () => currentAnchor,
            anchorInTransaction: () => currentAnchor,
            eligible: () => true,
            currentRevision: () => Revision.initial(),
            bootstrapTenant: () => undefined
        };
        const command = createTenantBootstrapCommand(store, { actor, tenantId });
        const content = new CounterContentStore(() => undefined);
        const commandEnvelope = CommandEnvelopeCodec.decode(
            envelope(content, { key: "typed-bootstrap-codecs" })
        );
        const execution = command.execute(store, commandEnvelope, {}, new Date(1_000));
        if (execution instanceof Uint8Array) throw new TypeError("Expected typed bootstrap reply");
        const replyCodec = command.replyCodec!;
        const observationCodec = command.observationCodec!;

        expect(replyCodec.decode(replyCodec.encode(execution.reply))).toEqual(execution.reply);
        expect(observationCodec.decode(observationCodec.encode(execution.observation!))).toEqual(
            execution.observation
        );
        currentAnchor = undefined;
        expect(command.currentRevision(store, commandEnvelope, {})).toBeUndefined();
        expect(() => command.execute(store, commandEnvelope, {}, new Date(1_000))).toThrow(
            /anchor disappeared/
        );

        for (const malformed of [
            null,
            {},
            { owner: null, tenant: tenantId.value },
            {
                owner: { principal: principalId.value, tenant: tenantId.value, extra: true },
                tenant: tenantId.value
            },
            {
                owner: { principal: "", tenant: tenantId.value },
                tenant: tenantId.value
            }
        ]) {
            expect(() => replyCodec.decode(encodeCanonicalJson(malformed as never))).toThrow(
                TypeError
            );
        }
        for (const malformed of [
            {},
            { at: "not-a-date", reply: "AA==" },
            { at: new Date(1_000).toISOString(), reply: "AA==", extra: true }
        ]) {
            expect(() =>
                observationCodec.decode(encodeCanonicalJson(malformed as never))
            ).toThrow();
        }
    });

    test("memory bootstrap payload codec rejects non-object canonical payloads", async () => {
        const content = new CounterContentStore(() => undefined);
        const composition = createMemoryTenantBootstrap({ actor, anchor, content });
        expect(
            (
                await composition.dispatch(
                    envelope(content, {
                        key: "memory-null-payload",
                        payload: encodeCanonicalJson(null)
                    }),
                    ownerTransport
                )
            ).outcome
        ).toBe("rejectedMalformed");
    });

    test("exports no callback backend, plan, writer, or raw bootstrap command", () => {
        for (const symbol of [
            "TenantBootstrapBackend",
            "TenantBootstrapCommand",
            "TenantBootstrapPlan",
            "TenantBootstrapStore",
            "TenantBootstrapWriter",
            "applyTenantBootstrapPlan",
            "createMemoryTenantBootstrapCommand",
            "createSqliteTenantBootstrapCommand",
            "createTenantBootstrapCommand",
            "createTenantBootstrapPlan"
        ])
            expect(protocol).not.toHaveProperty(symbol);
        expect(protocol.createMemoryTenantBootstrap).toBeTypeOf("function");
    });

    test("fails closed on malformed anchor codec and non-Tenant Actors", () => {
        expect(() =>
            TenantBootstrapAnchorRecord.decode(new TextEncoder().encode("null"))
        ).toThrow();
        expect(() =>
            createMemoryTenantBootstrap({
                actor: new ActorRef("workspace", actor.id),
                anchor,
                content: new CounterContentStore(() => undefined)
            })
        ).toThrow(/Tenant Actor/);
    });
});

interface EnvelopeInit {
    readonly caller?: CommandCaller;
    readonly expectedRevision?: Revision;
    readonly key?: string;
    readonly lease?: LeaseToken;
    readonly payload?: Uint8Array;
}

function envelope(content: CounterContentStore, init: EnvelopeInit): Uint8Array {
    const payload = init.payload ?? tenantBootstrapPayload();
    const digest = Digest.sha256(payload);
    const ref = ContentRef.fromDigest(digest);
    content.install(ref.value, payload);
    return CommandEnvelopeCodec.encode(
        new CommandEnvelope({
            command: "tenant.bootstrap",
            caller: init.caller ?? caller,
            idempotencyKey: init.key ?? "tenant-bootstrap-key",
            expectedRevision: init.expectedRevision ?? Revision.initial(),
            ...(init.lease === undefined ? {} : { lease: init.lease }),
            payload: ref,
            payloadDigest: digest
        })
    );
}

function anchorEnvelope(payload: JsonValue): Uint8Array {
    return encodeCanonicalJson({
        kind: "protocol.tenant-bootstrap-anchor",
        version: { major: 1, minor: 0 },
        payload
    });
}

function memoryClosure(composition: MemoryTenantBootstrap<symbol>) {
    const snapshot = composition.snapshot().opaque as {
        readonly state: { readonly control: ReturnType<MemoryTenantControlStore["snapshot"]> };
    };
    const control = MemoryTenantControlStore.restore(snapshot.state.control);
    return {
        tenant: control.tenant(tenantId) !== undefined,
        owner: control.principal(principalId) !== undefined,
        roles: control
            .roles()
            .map((role) => role.name.value)
            .sort(),
        membership: control.memberships().some((member) => member.role.value === "owner"),
        grants: control.grants().length,
        epoch: control.epoch(tenantScope).epoch,
        marker: control.bootstrapMarker() !== undefined
    };
}

function memoryEvidence(composition: MemoryTenantBootstrap<symbol>) {
    const snapshot = composition.snapshot().opaque as {
        readonly state: {
            readonly protocol: {
                snapshot(): {
                    readonly audits: readonly unknown[];
                    readonly identities: readonly unknown[];
                    readonly writes: readonly unknown[];
                };
            };
        };
    };
    const records = snapshot.state.protocol.snapshot();
    return {
        audits: records.audits.length,
        identities: records.identities.length,
        writes: records.writes.length
    };
}

function sqliteClosure(database: FileSqlite) {
    const control = createSqliteTenantControlStore(database);
    return {
        tenant: control.loadTenant(tenantId) !== undefined,
        owner: control.principal(principalId) !== undefined,
        roles: ["editor", "owner", "reader"].filter(
            (name) => control.role(new RoleName(name)) !== undefined
        ),
        membership: control.memberships().some((member) => member.role.value === "owner"),
        grants: control.grants().length,
        epoch: control.epoch(tenantScope).epoch,
        marker: control.bootstrapMarker() !== undefined
    };
}

function sqliteEvidence(database: FileSqlite) {
    return {
        audits: count(database, "protocol_audit_records"),
        identities: count(database, "protocol_command_identities"),
        writes: count(database, "protocol_write_records")
    };
}

function count(database: FileSqlite, table: string): number {
    const value = database.all(`SELECT COUNT(*) AS count FROM ${table}`, [])[0]?.["count"];
    if (typeof value !== "number") throw new TypeError(`Expected count from ${table}`);
    return value;
}

function completeClosure() {
    return {
        tenant: true,
        owner: true,
        roles: ["editor", "owner", "reader"],
        membership: true,
        grants: 1,
        epoch: 1,
        marker: true
    };
}

class FaultSqlite extends TestSqlite {
    public failure: "raw-write" | "typed-write" | "typed-read" | "lost-write" | undefined;

    public override all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        if (
            this.failure === "typed-read" &&
            statement.includes("SELECT next_id FROM tenant_bootstrap_protocol_ids")
        ) {
            throw new AgentCoreError("protocol.invalid-state", "injected typed ID read failure");
        }
        return super.all(statement, bindings);
    }

    public override run(statement: string, bindings: readonly SqliteValue[]): void {
        if (statement.startsWith("UPDATE tenant_bootstrap_protocol_ids")) {
            if (this.failure === "raw-write") throw new Error("injected raw ID write failure");
            if (this.failure === "typed-write") {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "injected typed ID write failure"
                );
            }
            if (this.failure === "lost-write") return;
        }
        super.run(statement, bindings);
    }
}
