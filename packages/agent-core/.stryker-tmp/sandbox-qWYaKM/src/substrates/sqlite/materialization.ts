// @ts-nocheck
import {
    ActorId,
    type ActorRef,
    type SynchronousResultGuard,
    type TransactionOperation
} from "../../actors";
import { Digest, Revision, SemVer } from "../../core";
import {
    Blueprint,
    DeploymentId,
    DeploymentRecord,
    ManagedStateRecord,
    MaterializationControlStore,
    MaterializationGeneration,
    MaterializationGenerationId,
    MaterializationGenerationPointer,
    MaterializationOutboxEntry,
    MaterializationPlan,
    MaterializationRollout,
    ValidationAttestation,
    isLegalDeploymentTransition,
    isLegalOutboxTransition,
    requirePlanAttestation,
    requireExactOutboxClosure
} from "../../definition";
import { AgentCoreError } from "../../errors";
import { TenantId } from "../../identity";
import type { SqliteRow } from "./sqlite";
import { TransactionalSqlite } from "./sqlite";

const DIGEST_CHECK = (column: string): string => `
        length(${column}) = 64
        AND ${column} NOT GLOB '*[^0-9a-f]*'
    `;

const ACTOR_KIND_CHECK = (column: string): string => `
        ${column} IN ('tenant', 'workspace', 'run', 'environment', 'slate')
    `;

const MATERIALIZATION_SCHEMA_VERSION = 2;
const MATERIALIZATION_SCHEMA_TABLE = "definition_materialization_schema";
const LEGACY_COMPOSITION_TABLE_PREFIX = "composition_slot_";

const CREATE_SCHEMA = `CREATE TABLE IF NOT EXISTS ${MATERIALIZATION_SCHEMA_TABLE} (
    version INTEGER PRIMARY KEY CHECK (version = ${MATERIALIZATION_SCHEMA_VERSION}),
    owner_kind TEXT NOT NULL CHECK (${ACTOR_KIND_CHECK("owner_kind")}),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0)
) STRICT`;

const INSERT_SCHEMA = `INSERT INTO ${MATERIALIZATION_SCHEMA_TABLE} (
    version, owner_kind, owner_id
) VALUES (?, ?, ?)`;

const CREATE_BLUEPRINTS = `CREATE TABLE IF NOT EXISTS definition_blueprints (
    name TEXT NOT NULL CHECK (length(name) > 0),
    version TEXT NOT NULL CHECK (length(version) > 0),
    digest TEXT NOT NULL CHECK (${DIGEST_CHECK("digest")}),
    record BLOB NOT NULL,
    PRIMARY KEY (name, version)
) STRICT`;

const CREATE_PLANS = `CREATE TABLE IF NOT EXISTS definition_materialization_plans (
    id TEXT PRIMARY KEY CHECK (${DIGEST_CHECK("id")}),
    blueprint_digest TEXT NOT NULL CHECK (${DIGEST_CHECK("blueprint_digest")}),
    package_lock_digest TEXT NOT NULL CHECK (${DIGEST_CHECK("package_lock_digest")}),
    config_digest TEXT NOT NULL CHECK (${DIGEST_CHECK("config_digest")}),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_GENERATIONS = `CREATE TABLE IF NOT EXISTS definition_materialization_generations (
    id TEXT PRIMARY KEY CHECK (${DIGEST_CHECK("id")}),
    actor_kind TEXT NOT NULL CHECK (${ACTOR_KIND_CHECK("actor_kind")}),
    actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
    blueprint_digest TEXT NOT NULL CHECK (${DIGEST_CHECK("blueprint_digest")}),
    package_lock_digest TEXT NOT NULL CHECK (${DIGEST_CHECK("package_lock_digest")}),
    config_digest TEXT NOT NULL CHECK (${DIGEST_CHECK("config_digest")}),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    record BLOB NOT NULL
) STRICT`;

const CREATE_MANAGED_STATE = `CREATE TABLE IF NOT EXISTS definition_managed_state (
    id TEXT PRIMARY KEY CHECK (${DIGEST_CHECK("id")}),
    generation_id TEXT NOT NULL CHECK (${DIGEST_CHECK("generation_id")}),
    actor_kind TEXT NOT NULL CHECK (${ACTOR_KIND_CHECK("actor_kind")}),
    actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
    logical_key TEXT NOT NULL CHECK (length(logical_key) > 0),
    record_kind TEXT NOT NULL CHECK (${requireMaterializationKindCheck("record_kind")}),
    desired_digest TEXT NOT NULL CHECK (${DIGEST_CHECK("desired_digest")}),
    record BLOB NOT NULL,
    UNIQUE (generation_id, logical_key)
) STRICT`;

const CREATE_POINTERS = `CREATE TABLE IF NOT EXISTS definition_materialization_pointers (
    actor_kind TEXT NOT NULL CHECK (${ACTOR_KIND_CHECK("actor_kind")}),
    actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
    deployment_id TEXT NOT NULL CHECK (${DIGEST_CHECK("deployment_id")}),
    generation_id TEXT NOT NULL CHECK (${DIGEST_CHECK("generation_id")}),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL,
    PRIMARY KEY (actor_kind, actor_id, deployment_id)
) STRICT`;

const CREATE_GENERATION_ACTOR_INDEX = `CREATE INDEX IF NOT EXISTS
    definition_materialization_generations_actor
    ON definition_materialization_generations (actor_kind, actor_id, id)`;

const CREATE_MANAGED_GENERATION_INDEX = `CREATE INDEX IF NOT EXISTS
    definition_managed_state_generation
    ON definition_managed_state (generation_id, logical_key, id)`;

const MATERIALIZATION_TABLES = new Map<string, string>([
    [MATERIALIZATION_SCHEMA_TABLE, CREATE_SCHEMA],
    ["definition_blueprints", CREATE_BLUEPRINTS],
    ["definition_materialization_plans", CREATE_PLANS],
    ["definition_materialization_generations", CREATE_GENERATIONS],
    ["definition_managed_state", CREATE_MANAGED_STATE],
    ["definition_materialization_pointers", CREATE_POINTERS]
]);
const MATERIALIZATION_INDEXES = new Map<string, string>([
    ["definition_materialization_generations_actor", CREATE_GENERATION_ACTOR_INDEX],
    ["definition_managed_state_generation", CREATE_MANAGED_GENERATION_INDEX]
]);

interface StoredBlueprint {
    readonly name: string;
    readonly version: string;
    readonly digest: string;
    readonly bytes: Uint8Array;
}

const CONTROL_SCHEMA_VERSION = 1;
const CONTROL_SCHEMA_TABLE = "definition_materialization_control_schema";
const CONTROL_TABLES = [
    CONTROL_SCHEMA_TABLE,
    "definition_validation_attestations",
    "definition_deployments",
    "definition_materialization_rollouts",
    "definition_materialization_outbox"
] as const;
const CREATE_CONTROL_SCHEMA = `CREATE TABLE ${CONTROL_SCHEMA_TABLE} (
    version INTEGER PRIMARY KEY CHECK (version = ${CONTROL_SCHEMA_VERSION}),
    owner_kind TEXT NOT NULL CHECK (owner_kind = 'tenant'),
    owner_id TEXT NOT NULL CHECK (length(owner_id) > 0)
) STRICT`;
const CREATE_CONTROL_DEPLOYMENTS = `CREATE TABLE definition_deployments (
    id TEXT PRIMARY KEY CHECK (${DIGEST_CHECK("id")}),
    tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
    deployment_key TEXT NOT NULL CHECK (length(deployment_key) > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL,
    UNIQUE (tenant_id, deployment_key)
) STRICT`;
const CREATE_CONTROL_ATTESTATIONS = `CREATE TABLE definition_validation_attestations (
    id TEXT PRIMARY KEY CHECK (${DIGEST_CHECK("id")}),
    record BLOB NOT NULL
) STRICT`;
const CREATE_CONTROL_ROLLOUTS = `CREATE TABLE definition_materialization_rollouts (
    id TEXT PRIMARY KEY CHECK (${DIGEST_CHECK("id")}),
    deployment_id TEXT NOT NULL CHECK (${DIGEST_CHECK("deployment_id")}),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    record BLOB NOT NULL
) STRICT`;
const CREATE_CONTROL_OUTBOX = `CREATE TABLE definition_materialization_outbox (
    id TEXT PRIMARY KEY CHECK (${DIGEST_CHECK("id")}),
    rollout_id TEXT NOT NULL CHECK (${DIGEST_CHECK("rollout_id")}),
    target_kind TEXT NOT NULL CHECK (${ACTOR_KIND_CHECK("target_kind")}),
    target_id TEXT NOT NULL CHECK (length(target_id) > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    record BLOB NOT NULL
) STRICT`;
const CREATE_CONTROL_OUTBOX_INDEX = `CREATE INDEX definition_materialization_outbox_rollout
    ON definition_materialization_outbox (rollout_id, id)`;
const CONTROL_SCHEMA_SQL = new Map<string, string>([
    [CONTROL_SCHEMA_TABLE, CREATE_CONTROL_SCHEMA],
    ["definition_validation_attestations", CREATE_CONTROL_ATTESTATIONS],
    ["definition_deployments", CREATE_CONTROL_DEPLOYMENTS],
    ["definition_materialization_rollouts", CREATE_CONTROL_ROLLOUTS],
    ["definition_materialization_outbox", CREATE_CONTROL_OUTBOX]
]);

export class SqliteMaterializationControlStore extends MaterializationControlStore<TransactionalSqlite> {
    public constructor(
        private readonly controlDatabase: TransactionalSqlite,
        public readonly owner: ActorRef
    ) {
        super();
        if (owner.kind !== "tenant") {
            throw invalidMaterializationState(
                "Materialization rollout control requires a Tenant Actor"
            );
        }
        controlDatabase.transaction(() => {
            const objects = sqliteObjects(controlDatabase);
            const hasMarker = objects.tables.has(CONTROL_SCHEMA_TABLE);
            const hasAny = CONTROL_TABLES.some((table) => objects.tables.has(table));
            if (!hasMarker && hasAny) {
                throw resetRequired(
                    "Unmarked materialization control schema requires explicit reset"
                );
            }
            if (!hasMarker) createControlSchema(controlDatabase, owner);
            requireControlSchema(controlDatabase, owner);
            this.validateControlState(controlDatabase);
        });
    }

    public transaction<Result>(
        operation: TransactionOperation<TransactionalSqlite, Result>,
        ...guard: SynchronousResultGuard<Result>
    ): Result {
        return this.controlDatabase.transaction(() => operation(this.controlDatabase), ...guard);
    }

    public loadDeployment(
        transaction: TransactionalSqlite,
        id: DeploymentId
    ): DeploymentRecord | undefined {
        const row = transaction.all(
            `SELECT tenant_id, deployment_key, revision, record
             FROM definition_deployments WHERE id = ?`,
            [id.value]
        )[0];
        if (row === undefined) return undefined;
        const record = DeploymentRecord.decode(bytes(row, "record"));
        if (
            !record.id.equals(id) ||
            !record.tenantId.equals(new TenantId(this.owner.id.value)) ||
            text(row, "tenant_id") !== record.tenantId.value ||
            text(row, "deployment_key") !== record.key.value ||
            integer(row, "revision") !== record.revision.value
        ) {
            throw corruptMaterialization(
                "Stored deployment key or Tenant does not match codec bytes"
            );
        }
        return record;
    }

    public insertAttestation(
        transaction: TransactionalSqlite,
        attestation: ValidationAttestation
    ): void {
        const encoded = ValidationAttestation.encode(attestation);
        transaction.run(
            `INSERT INTO definition_validation_attestations (id, record) VALUES (?, ?)
             ON CONFLICT (id) DO NOTHING`,
            [attestation.id.value, encoded]
        );
        const stored = this.loadAttestation(transaction, attestation.id);
        if (stored === undefined || !equalBytes(ValidationAttestation.encode(stored), encoded)) {
            throw invalidMaterializationState(
                `Validation attestation ${attestation.id.value} is immutable`
            );
        }
    }

    public loadAttestation(
        transaction: TransactionalSqlite,
        id: Digest
    ): ValidationAttestation | undefined {
        const row = transaction.all(
            `SELECT record FROM definition_validation_attestations WHERE id = ?`,
            [id.value]
        )[0];
        if (row === undefined) return undefined;
        const attestation = ValidationAttestation.decode(bytes(row, "record"));
        if (!attestation.id.equals(id)) {
            throw corruptMaterialization(
                "Stored validation attestation key does not match codec bytes"
            );
        }
        return attestation;
    }

    public compareAndSetDeployment(
        transaction: TransactionalSqlite,
        expected: Revision | undefined,
        deployment: DeploymentRecord
    ): boolean {
        const record = DeploymentRecord.decode(DeploymentRecord.encode(deployment));
        const current = this.loadDeployment(transaction, record.id);
        const matches =
            expected === undefined
                ? current === undefined
                : current?.revision.equals(expected) === true;
        if (!matches) return false;
        if (
            !isLegalDeploymentTransition(current, record) ||
            !this.isDeploymentLineageValid(transaction, current, record) ||
            record.tenantId.value !== this.owner.id.value
        ) {
            throw materializationRevisionConflict(
                "Deployment CAS has a foreign owner or skipped revision"
            );
        }
        const rows =
            expected === undefined
                ? transaction.all(
                      `INSERT INTO definition_deployments (id, tenant_id, deployment_key, revision, record)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO NOTHING RETURNING record`,
                      [
                          record.id.value,
                          record.tenantId.value,
                          record.key.value,
                          record.revision.value,
                          DeploymentRecord.encode(record)
                      ]
                  )
                : transaction.all(
                      `UPDATE definition_deployments SET revision = ?, record = ?
                 WHERE id = ? AND revision = ? RETURNING record`,
                      [
                          record.revision.value,
                          DeploymentRecord.encode(record),
                          record.id.value,
                          expected.value
                      ]
                  );
        if (rows.length === 0) return false;
        if (rows.length !== 1) throw corruptMaterialization("Deployment CAS changed multiple rows");
        DeploymentRecord.decode(bytes(rows[0]!, "record"));
        return true;
    }

    public insertRollout(transaction: TransactionalSqlite, rollout: MaterializationRollout): void {
        if (this.loadDeployment(transaction, rollout.plan.origin.deploymentId) === undefined) {
            throw invalidMaterializationState(
                "Materialization rollout requires its stored deployment"
            );
        }
        const attestation = this.loadAttestation(
            transaction,
            rollout.plan.origin.attestationDigest
        );
        if (attestation === undefined) {
            throw invalidMaterializationState(
                "Materialization rollout requires its stored validation attestation"
            );
        }
        requirePlanAttestation(rollout.plan, attestation);
        const encoded = MaterializationRollout.encode(rollout);
        transaction.run(
            `INSERT INTO definition_materialization_rollouts (
                id, deployment_id, generation, record
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING`,
            [
                rollout.id.value,
                rollout.plan.origin.deploymentId.value,
                rollout.plan.generation,
                encoded
            ]
        );
        const stored = this.loadRollout(transaction, rollout.id);
        if (stored === undefined || !equalBytes(MaterializationRollout.encode(stored), encoded)) {
            throw invalidMaterializationState(
                `Materialization rollout ${rollout.id.value} is immutable`
            );
        }
    }

    public loadRollout(
        transaction: TransactionalSqlite,
        id: Digest
    ): MaterializationRollout | undefined {
        const row = transaction.all(
            `SELECT deployment_id, generation, record
             FROM definition_materialization_rollouts WHERE id = ?`,
            [id.value]
        )[0];
        if (row === undefined) return undefined;
        const rollout = MaterializationRollout.decode(bytes(row, "record"));
        if (
            !rollout.id.equals(id) ||
            text(row, "deployment_id") !== rollout.plan.origin.deploymentId.value ||
            integer(row, "generation") !== rollout.plan.generation
        ) {
            throw corruptMaterialization("Stored rollout projection does not match codec bytes");
        }
        return rollout;
    }

    public loadPlan(transaction: TransactionalSqlite, id: Digest): MaterializationPlan | undefined {
        for (const row of transaction.all(
            `SELECT record FROM definition_materialization_rollouts`,
            []
        )) {
            const plan = MaterializationRollout.decode(bytes(row, "record")).plan;
            if (plan.id.equals(id)) return plan;
        }
        return undefined;
    }

    public insertOutbox(transaction: TransactionalSqlite, entry: MaterializationOutboxEntry): void {
        if (this.loadRollout(transaction, entry.rolloutId) === undefined) {
            throw invalidMaterializationState(
                "Materialization outbox entry requires its stored rollout"
            );
        }
        const encoded = MaterializationOutboxEntry.encode(entry);
        transaction.run(
            `INSERT INTO definition_materialization_outbox (
                id, rollout_id, target_kind, target_id, status, revision, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING`,
            [
                entry.id.value,
                entry.rolloutId.value,
                entry.target.kind,
                entry.target.id.value,
                entry.status,
                entry.revision.value,
                encoded
            ]
        );
        const stored = this.loadOutbox(transaction, entry.id);
        if (
            stored === undefined ||
            !equalBytes(MaterializationOutboxEntry.encode(stored), encoded)
        ) {
            throw invalidMaterializationState(
                `Materialization outbox entry ${entry.id.value} is immutable`
            );
        }
    }

    public loadOutbox(
        transaction: TransactionalSqlite,
        id: Digest
    ): MaterializationOutboxEntry | undefined {
        const row = transaction.all(
            `SELECT rollout_id, target_kind, target_id, status, revision, record
             FROM definition_materialization_outbox WHERE id = ?`,
            [id.value]
        )[0];
        return row === undefined ? undefined : decodeControlOutbox(row, id);
    }

    public listOutbox(
        transaction: TransactionalSqlite,
        rolloutId: Digest
    ): readonly MaterializationOutboxEntry[] {
        return Object.freeze(
            transaction
                .all(
                    `SELECT rollout_id, target_kind, target_id, status, revision, record
             FROM definition_materialization_outbox WHERE rollout_id = ? ORDER BY id`,
                    [rolloutId.value]
                )
                .map((row) => decodeControlOutbox(row))
        );
    }

    public compareAndSetOutbox(
        transaction: TransactionalSqlite,
        expected: Revision,
        entry: MaterializationOutboxEntry
    ): boolean {
        const encoded = MaterializationOutboxEntry.encode(entry);
        const current = this.loadOutbox(transaction, entry.id);
        if (current?.revision.equals(expected) !== true) return false;
        if (!isLegalOutboxTransition(current, entry)) {
            throw materializationRevisionConflict("Materialization outbox transition is invalid");
        }
        const rows = transaction.all(
            `UPDATE definition_materialization_outbox
             SET status = ?, revision = ?, record = ?
             WHERE id = ? AND revision = ? RETURNING record`,
            [entry.status, entry.revision.value, encoded, entry.id.value, expected.value]
        );
        if (rows.length === 0) return false;
        if (rows.length !== 1 || !equalBytes(bytes(rows[0]!, "record"), encoded)) {
            throw corruptMaterialization("Materialization outbox CAS returned malformed state");
        }
        return true;
    }

    private validateControlState(transaction: TransactionalSqlite): void {
        for (const row of transaction.all(
            `SELECT id, record FROM definition_validation_attestations`,
            []
        )) {
            this.loadAttestation(transaction, new Digest(text(row, "id")));
        }
        for (const row of transaction.all(`SELECT id, record FROM definition_deployments`, [])) {
            this.loadDeployment(transaction, new DeploymentId(text(row, "id")));
        }
        for (const row of transaction.all(
            `SELECT id FROM definition_materialization_rollouts`,
            []
        )) {
            const rollout = this.loadRollout(transaction, new Digest(text(row, "id")))!;
            if (this.loadDeployment(transaction, rollout.plan.origin.deploymentId) === undefined) {
                throw corruptMaterialization("Stored rollout has no deployment");
            }
            const attestation = this.loadAttestation(
                transaction,
                rollout.plan.origin.attestationDigest
            );
            if (attestation === undefined) {
                throw corruptMaterialization("Stored rollout has no validation attestation");
            }
            try {
                requirePlanAttestation(rollout.plan, attestation);
                requireExactOutboxClosure(rollout, this.listOutbox(transaction, rollout.id));
            } catch (error) {
                throw corruptMaterialization(
                    error instanceof Error ? error.message : "Stored rollout closure is corrupt"
                );
            }
        }
        for (const row of transaction.all(
            `SELECT id, rollout_id, target_kind, target_id, status, revision, record
             FROM definition_materialization_outbox`,
            []
        )) {
            const entry = decodeControlOutbox(row, new Digest(text(row, "id")));
            if (this.loadRollout(transaction, entry.rolloutId) === undefined) {
                throw corruptMaterialization("Stored outbox entry has no rollout");
            }
        }
    }

    private isDeploymentLineageValid(
        transaction: TransactionalSqlite,
        current: DeploymentRecord | undefined,
        next: DeploymentRecord
    ): boolean {
        if (current === undefined) return true;
        if (current.pendingRolloutId === undefined) {
            const rollout =
                next.pendingRolloutId === undefined
                    ? undefined
                    : this.loadRollout(transaction, next.pendingRolloutId);
            return (
                rollout !== undefined &&
                rollout.plan.origin.deploymentId.equals(current.id) &&
                rollout.plan.generation === current.nextGeneration
            );
        }
        if (next.pendingRolloutId === undefined) {
            return (
                this.loadRollout(transaction, current.pendingRolloutId)?.plan.id.equals(
                    next.activePlanId!
                ) === true
            );
        }
        const compensation = this.loadRollout(transaction, next.pendingRolloutId);
        return (
            compensation?.compensates?.equals(current.pendingRolloutId) === true &&
            compensation.plan.origin.deploymentId.equals(current.id) &&
            compensation.plan.generation === current.nextGeneration
        );
    }
}

function createControlSchema(database: TransactionalSqlite, owner: ActorRef): void {
    for (const sql of CONTROL_SCHEMA_SQL.values()) database.run(sql, []);
    database.run(CREATE_CONTROL_OUTBOX_INDEX, []);
    database.run(
        `INSERT INTO ${CONTROL_SCHEMA_TABLE} (version, owner_kind, owner_id) VALUES (?, ?, ?)`,
        [CONTROL_SCHEMA_VERSION, owner.kind, owner.id.value]
    );
}

function requireControlSchema(database: TransactionalSqlite, owner: ActorRef): void {
    const objects = sqliteObjects(database);
    for (const [table, expectedSql] of CONTROL_SCHEMA_SQL) {
        const actual = objects.tables.get(table);
        if (
            actual === undefined ||
            normalizeSchemaSql(actual.sql ?? "") !== normalizeSchemaSql(expectedSql)
        ) {
            throw resetRequired(`Materialization control schema is missing ${table}`);
        }
    }
    const index = objects.indexes.get("definition_materialization_outbox_rollout");
    if (
        index === undefined ||
        normalizeSchemaSql(index.sql ?? "") !== normalizeSchemaSql(CREATE_CONTROL_OUTBOX_INDEX)
    ) {
        throw resetRequired(
            "Materialization control schema has a missing or malformed outbox index"
        );
    }
    if (
        [...objects.indexes.values()].some(
            (candidate) =>
                candidate.sql !== null &&
                CONTROL_TABLES.includes(candidate.table as (typeof CONTROL_TABLES)[number]) &&
                candidate.name !== "definition_materialization_outbox_rollout"
        )
    ) {
        throw resetRequired("Materialization control schema contains an unexpected index");
    }
    if (
        [...objects.triggers.values()].some((trigger) =>
            CONTROL_TABLES.includes(trigger.table as (typeof CONTROL_TABLES)[number])
        )
    ) {
        throw resetRequired("Materialization control schema must not contain triggers");
    }
    const rows = database.all(
        `SELECT version, owner_kind, owner_id FROM ${CONTROL_SCHEMA_TABLE}`,
        []
    );
    if (
        rows.length !== 1 ||
        rows[0]?.["version"] !== CONTROL_SCHEMA_VERSION ||
        rows[0]?.["owner_kind"] !== owner.kind ||
        rows[0]?.["owner_id"] !== owner.id.value
    ) {
        throw resetRequired("Materialization control schema owner or version is unsupported");
    }
}

function decodeControlOutbox(row: SqliteRow, expectedId?: Digest): MaterializationOutboxEntry {
    const entry = MaterializationOutboxEntry.decode(bytes(row, "record"));
    if (
        (expectedId !== undefined && !entry.id.equals(expectedId)) ||
        text(row, "rollout_id") !== entry.rolloutId.value ||
        text(row, "target_kind") !== entry.target.kind ||
        text(row, "target_id") !== entry.target.id.value ||
        text(row, "status") !== entry.status ||
        integer(row, "revision") !== entry.revision.value
    ) {
        throw corruptMaterialization("Stored outbox projection does not match codec bytes");
    }
    return entry;
}

interface StoredMaterializationPlan {
    readonly id: string;
    readonly blueprintDigest: string;
    readonly packageLockDigest: string;
    readonly configDigest: string;
    readonly generation: number;
    readonly bytes: Uint8Array;
}

interface StoredMaterializationGeneration {
    readonly id: MaterializationGenerationId;
    readonly actorKind: string;
    readonly actorId: ActorId;
    readonly blueprintDigest: string;
    readonly packageLockDigest: string;
    readonly configDigest: string;
    readonly generation: number;
    readonly bytes: Uint8Array;
}

interface StoredManagedStateRecord {
    readonly id: string;
    readonly generationId: MaterializationGenerationId;
    readonly actorKind: string;
    readonly actorId: ActorId;
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desiredDigest: string;
    readonly bytes: Uint8Array;
}

interface StoredMaterializationGenerationPointer {
    readonly actorKind: string;
    readonly actorId: ActorId;
    readonly deploymentId: DeploymentId["value"];
    readonly generationId: MaterializationGenerationId;
    readonly revision: number;
    readonly bytes: Uint8Array;
}

export class SqliteMaterializationStore {
    public static control(
        database: TransactionalSqlite,
        owner: ActorRef
    ): MaterializationControlStore<TransactionalSqlite> {
        return new SqliteMaterializationControlStore(database, owner);
    }

    public readonly owner: ActorRef;

    public constructor(
        private readonly database: TransactionalSqlite,
        owner: ActorRef
    ) {
        this.owner = owner;
        database.transaction(() => {
            const objects = sqliteObjects(database);
            requireNoLegacyComposition(objects.tables);
            if (!objects.tables.has(MATERIALIZATION_SCHEMA_TABLE)) {
                requirePristineMaterializationSchema(objects);
                createMaterializationSchema(database, owner);
                const created = sqliteObjects(database);
                requireCompleteMaterializationSchema(created);
                requireSchemaVersion(database, owner);
            } else {
                requireCompleteMaterializationSchema(objects);
                requireSchemaVersion(database, owner);
                this.requireSupportedStoredState(database);
            }
        });
    }

    public transaction<TResult>(
        operation: TransactionOperation<TransactionalSqlite, TResult>,
        ...guard: SynchronousResultGuard<TResult>
    ): TResult {
        return this.database.transaction(() => operation(this.database), ...guard);
    }

    public addBlueprint(blueprint: Blueprint): void {
        requireTenantDefinitionOwner(this.owner, "Blueprint");
        this.transaction((transaction) => {
            const candidateBytes = Blueprint.encode(blueprint);
            const candidate = Blueprint.decode(candidateBytes);
            const stored = this.writeBlueprint(
                transaction,
                projectBlueprint(candidate, candidateBytes)
            );
            this.decodeBlueprint(stored, candidate.meta.name, candidate.meta.version);
            requireEqualImmutable(
                stored.bytes,
                candidateBytes,
                `Blueprint ${candidate.meta.name}@${candidate.meta.version.toString()}`
            );
        });
    }

    public getBlueprint(name: string, version: SemVer): Blueprint | undefined {
        requireTenantDefinitionOwner(this.owner, "Blueprint");
        const stored = this.findBlueprint(this.database, name, version.toString());
        return stored === undefined ? undefined : this.decodeBlueprint(stored, name, version);
    }

    public listBlueprints(name?: string): readonly Blueprint[] {
        requireTenantDefinitionOwner(this.owner, "Blueprint");
        const blueprints = this.blueprintRecords(this.database, name)
            .map((stored) => this.decodeBlueprint(stored, name))
            .sort(compareBlueprints);
        requireUnique(
            blueprints.map((value) => `${value.meta.name}\0${value.meta.version.toString()}`),
            "Stored Blueprints contain a duplicate immutable key"
        );
        return Object.freeze(blueprints);
    }

    public addPlan(plan: MaterializationPlan): void {
        requireTenantDefinitionOwner(this.owner, "Materialization plan");
        this.transaction((transaction) => {
            const candidateBytes = MaterializationPlan.encode(plan);
            const candidate = MaterializationPlan.decode(candidateBytes);
            requireOwnedPlan(candidate, this.owner);
            const stored = this.writePlan(transaction, projectPlan(candidate, candidateBytes));
            this.decodePlan(stored);
            requireEqualImmutable(
                stored.bytes,
                candidateBytes,
                `Materialization plan ${candidate.id.value}`
            );
        });
    }

    public getPlan(id: Digest): MaterializationPlan | undefined {
        requireTenantDefinitionOwner(this.owner, "Materialization plan");
        const stored = this.findPlan(this.database, id.value);
        if (stored === undefined) return undefined;
        const plan = this.decodePlan(stored);
        if (!plan.id.equals(id)) {
            throw corruptMaterialization(
                "Stored materialization-plan key does not match codec bytes"
            );
        }
        requireOwnedPlan(plan, this.owner);
        return plan;
    }

    public listPlans(): readonly MaterializationPlan[] {
        requireTenantDefinitionOwner(this.owner, "Materialization plan");
        const plans = this.planRecords(this.database)
            .map((stored) => this.decodePlan(stored))
            .sort((left, right) => compareText(left.id.value, right.id.value));
        requireUnique(
            plans.map((plan) => plan.id.value),
            "Stored materialization plans contain a duplicate immutable key"
        );
        for (const plan of plans) requireOwnedPlan(plan, this.owner);
        return Object.freeze(plans);
    }

    public addGeneration(generation: MaterializationGeneration): void {
        this.transaction((transaction) => this.insertGeneration(transaction, generation));
    }

    public getGeneration(id: MaterializationGenerationId): MaterializationGeneration | undefined {
        return this.loadGeneration(this.database, id);
    }

    public listGenerations(actor?: ActorRef): readonly MaterializationGeneration[] {
        if (actor !== undefined) requireOwnedActor(actor, this.owner, "Generation query");
        const generations = this.generationRecords(this.database)
            .map((stored) => this.decodeGeneration(this.database, stored))
            .sort(compareGenerations);
        requireUnique(
            generations.map((generation) => generation.id.value),
            "Stored materialization generations contain a duplicate immutable key"
        );
        for (const generation of generations) {
            requireOwnedActor(generation.actor, this.owner, "Stored materialization generation");
        }
        return Object.freeze(generations);
    }

    public addManagedState(record: ManagedStateRecord): void {
        const canonical = ManagedStateRecord.decode(ManagedStateRecord.encode(record));
        this.transaction((transaction) => {
            this.insertManagedState(transaction, canonical);
            const generation = this.loadGeneration(transaction, canonical.generationId);
            if (
                generation === undefined ||
                !generation.managedRecordIds.some((id) => id.equals(canonical.id))
            ) {
                throw invalidMaterializationState(
                    "Standalone managed state must belong to a stored generation"
                );
            }
        });
    }

    public getManagedState(id: Digest): ManagedStateRecord | undefined {
        return this.loadManagedState(this.database, id);
    }

    public listManagedState(
        generationId?: MaterializationGenerationId
    ): readonly ManagedStateRecord[] {
        const records = this.managedStateRecords(this.database, generationId)
            .map((stored) => this.decodeManagedState(stored))
            .sort(compareManagedState);
        requireUnique(
            records.map((record) => record.id.value),
            "Stored managed state contains a duplicate immutable key"
        );
        for (const record of records) {
            requireOwnedActor(record.actor, this.owner, "Stored managed state");
        }
        return Object.freeze(records);
    }

    public getGenerationPointer(
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined {
        requireOwnedActor(actor, this.owner, "Generation pointer query");
        return this.loadGenerationPointer(this.database, actor, deploymentId);
    }

    public listGenerationPointers(): readonly MaterializationGenerationPointer[] {
        const pointers = this.generationPointerRecords(this.database)
            .map((stored) => this.decodeGenerationPointer(this.database, stored))
            .sort(
                (left, right) =>
                    compareActors(left.actor, right.actor) ||
                    compareText(left.deploymentId.value, right.deploymentId.value)
            );
        requireUnique(
            pointers.map(
                (pointer) =>
                    `${pointer.actor.kind}\0${pointer.actor.id.value}\0${pointer.deploymentId.value}`
            ),
            "Stored generation pointers contain a duplicate Actor key"
        );
        for (const pointer of pointers) {
            requireOwnedActor(pointer.actor, this.owner, "Stored generation pointer");
        }
        return Object.freeze(pointers);
    }

    public loadGeneration(
        transaction: TransactionalSqlite,
        id: MaterializationGenerationId
    ): MaterializationGeneration | undefined {
        const stored = this.findGeneration(transaction, id);
        if (stored === undefined) return undefined;
        const generation = this.decodeGeneration(transaction, stored);
        if (!generation.id.equals(id)) {
            throw corruptMaterialization("Stored generation key does not match codec bytes");
        }
        requireOwnedActor(generation.actor, this.owner, "Stored materialization generation");
        return generation;
    }

    public insertGeneration(
        transaction: TransactionalSqlite,
        generation: MaterializationGeneration
    ): void {
        const candidateBytes = MaterializationGeneration.encode(generation);
        const candidate = MaterializationGeneration.decode(candidateBytes);
        requireOwnedActor(candidate.actor, this.owner, "Materialization generation");
        const existing = this.findGeneration(transaction, candidate.id);
        if (existing !== undefined && !equalBytes(existing.bytes, candidateBytes)) {
            throw invalidMaterializationState(
                `Materialization generation ${candidate.id.value} is immutable`
            );
        }
        const ordinalConflict = this.generationRecords(transaction, candidate.actor)
            .map((stored) => this.decodeGeneration(transaction, stored))
            .find(
                (generation) =>
                    generation.origin.deploymentId.equals(candidate.origin.deploymentId) &&
                    generation.origin.generation === candidate.origin.generation &&
                    !generation.id.equals(candidate.id)
            );
        if (ordinalConflict !== undefined) {
            throw invalidMaterializationState(
                `Materialization generation ${candidate.origin.generation} is immutable per deployment`
            );
        }
        this.requireGenerationRecords(transaction, candidate);
        const stored = this.writeGeneration(
            transaction,
            projectGeneration(candidate, candidateBytes)
        );
        this.decodeGeneration(transaction, stored);
        requireEqualImmutable(
            stored.bytes,
            candidateBytes,
            `Materialization generation ${candidate.id.value}`
        );
    }

    public loadManagedState(
        transaction: TransactionalSqlite,
        id: Digest
    ): ManagedStateRecord | undefined {
        const stored = this.findManagedState(transaction, id.value);
        if (stored === undefined) return undefined;
        const record = this.decodeManagedState(stored);
        if (!record.id.equals(id)) {
            throw corruptMaterialization("Stored managed-state key does not match codec bytes");
        }
        requireOwnedActor(record.actor, this.owner, "Stored managed state");
        return record;
    }

    public insertManagedState(transaction: TransactionalSqlite, record: ManagedStateRecord): void {
        const candidateBytes = ManagedStateRecord.encode(record);
        const candidate = ManagedStateRecord.decode(candidateBytes);
        requireOwnedActor(candidate.actor, this.owner, "Managed state");
        const generation = this.findGeneration(transaction, candidate.generationId);
        if (generation !== undefined) {
            const decoded = this.decodeGeneration(transaction, generation);
            if (!decoded.managedRecordIds.some((id) => id.equals(candidate.id))) {
                throw invalidMaterializationState(
                    `Materialization generation ${candidate.generationId.value} is immutable`
                );
            }
        }
        const conflict = this.managedStateRecords(transaction, candidate.generationId).find(
            (stored) =>
                stored.logicalKey === candidate.logicalKey && stored.id !== candidate.id.value
        );
        if (conflict !== undefined) {
            throw invalidMaterializationState(
                `Managed state logical key ${candidate.logicalKey} is immutable per generation`
            );
        }
        const stored = this.writeManagedState(
            transaction,
            projectManagedState(candidate, candidateBytes)
        );
        this.decodeManagedState(stored);
        requireEqualImmutable(stored.bytes, candidateBytes, `Managed state ${candidate.id.value}`);
    }

    public loadGenerationPointer(
        transaction: TransactionalSqlite,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): MaterializationGenerationPointer | undefined {
        requireOwnedActor(actor, this.owner, "Generation pointer query");
        const stored = this.findGenerationPointer(transaction, actor, deploymentId);
        if (stored === undefined) return undefined;
        const pointer = this.decodeGenerationPointer(transaction, stored);
        if (!pointer.actor.equals(actor) || !pointer.deploymentId.equals(deploymentId)) {
            throw corruptMaterialization(
                "Stored generation pointer key does not match codec bytes"
            );
        }
        return pointer;
    }

    public compareAndSetGenerationPointer(
        transaction: TransactionalSqlite,
        actor: ActorRef,
        deploymentId: DeploymentId,
        expectedRevision: Revision | undefined,
        next: MaterializationGenerationPointer
    ): boolean {
        requireOwnedActor(actor, this.owner, "Generation pointer");
        const candidateBytes = MaterializationGenerationPointer.encode(next);
        const candidate = MaterializationGenerationPointer.decode(candidateBytes);
        if (!candidate.actor.equals(actor) || !candidate.deploymentId.equals(deploymentId)) {
            throw invalidMaterializationState(
                "Materialization generation pointer belongs to a different Actor"
            );
        }
        const current = this.loadGenerationPointer(transaction, actor, deploymentId);
        const matches =
            expectedRevision === undefined
                ? current === undefined
                : current?.revision.equals(expectedRevision) === true;
        if (!matches) return false;
        const requiredRevision =
            expectedRevision === undefined ? Revision.initial() : expectedRevision.next();
        if (!candidate.revision.equals(requiredRevision)) {
            throw materializationRevisionConflict(
                "Materialization generation pointer must advance exactly one revision"
            );
        }
        const generation = this.loadGeneration(transaction, candidate.generationId);
        if (
            generation === undefined ||
            !generation.actor.equals(actor) ||
            !generation.origin.deploymentId.equals(deploymentId)
        ) {
            throw invalidMaterializationState(
                "Materialization generation pointer must target a stored generation"
            );
        }
        if (current !== undefined) {
            const currentGeneration = this.loadGeneration(transaction, current.generationId);
            if (
                currentGeneration === undefined ||
                generation.origin.generation <= currentGeneration.origin.generation
            ) {
                throw materializationRevisionConflict(
                    "Materialization generation pointer must strictly increase generation"
                );
            }
        }
        if (
            !this.writeGenerationPointer(
                transaction,
                expectedRevision,
                projectGenerationPointer(candidate, candidateBytes)
            )
        ) {
            return false;
        }
        const persisted = this.loadGenerationPointer(transaction, actor, deploymentId);
        if (
            persisted === undefined ||
            !equalBytes(MaterializationGenerationPointer.encode(persisted), candidateBytes)
        ) {
            throw corruptMaterialization("Generation pointer CAS did not persist codec bytes");
        }
        return true;
    }

    protected findBlueprint(
        _transaction: TransactionalSqlite,
        name: string,
        version: string
    ): StoredBlueprint | undefined {
        const row = this.database.all(
            `SELECT name, version, digest, record FROM definition_blueprints
             WHERE name = ? AND version = ?`,
            [name, version]
        )[0];
        return row === undefined ? undefined : storedBlueprint(row);
    }

    protected blueprintRecords(
        _transaction: TransactionalSqlite,
        name?: string
    ): readonly StoredBlueprint[] {
        const rows =
            name === undefined
                ? this.database.all(
                      `SELECT name, version, digest, record FROM definition_blueprints
                 ORDER BY name, version`,
                      []
                  )
                : this.database.all(
                      `SELECT name, version, digest, record FROM definition_blueprints
                 WHERE name = ? ORDER BY name, version`,
                      [name]
                  );
        return rows.map(storedBlueprint);
    }

    protected writeBlueprint(
        transaction: TransactionalSqlite,
        blueprint: StoredBlueprint
    ): StoredBlueprint {
        transaction.run(
            `INSERT OR IGNORE INTO definition_blueprints (name, version, digest, record)
             VALUES (?, ?, ?, ?)`,
            [blueprint.name, blueprint.version, blueprint.digest, blueprint.bytes]
        );
        return requireStored(
            this.findBlueprint(transaction, blueprint.name, blueprint.version),
            "Blueprint"
        );
    }

    protected findPlan(
        _transaction: TransactionalSqlite,
        id: string
    ): StoredMaterializationPlan | undefined {
        const row = this.database.all(
            `SELECT id, blueprint_digest, package_lock_digest, config_digest,
                    generation, record
             FROM definition_materialization_plans WHERE id = ?`,
            [id]
        )[0];
        return row === undefined ? undefined : storedPlan(row);
    }

    protected planRecords(_transaction: TransactionalSqlite): readonly StoredMaterializationPlan[] {
        return this.database
            .all(
                `SELECT id, blueprint_digest, package_lock_digest, config_digest,
                    generation, record
             FROM definition_materialization_plans ORDER BY id`,
                []
            )
            .map(storedPlan);
    }

    protected writePlan(
        transaction: TransactionalSqlite,
        plan: StoredMaterializationPlan
    ): StoredMaterializationPlan {
        transaction.run(
            `INSERT OR IGNORE INTO definition_materialization_plans (
                id, blueprint_digest, package_lock_digest, config_digest, generation, record
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
                plan.id,
                plan.blueprintDigest,
                plan.packageLockDigest,
                plan.configDigest,
                plan.generation,
                plan.bytes
            ]
        );
        return requireStored(this.findPlan(transaction, plan.id), "materialization plan");
    }

    protected findGeneration(
        _transaction: TransactionalSqlite,
        id: MaterializationGenerationId
    ): StoredMaterializationGeneration | undefined {
        const row = this.database.all(
            `SELECT id, actor_kind, actor_id, blueprint_digest, package_lock_digest,
                    config_digest, generation, record
             FROM definition_materialization_generations WHERE id = ?`,
            [id.value]
        )[0];
        return row === undefined ? undefined : storedGeneration(row);
    }

    protected generationRecords(
        _transaction: TransactionalSqlite,
        actor?: ActorRef
    ): readonly StoredMaterializationGeneration[] {
        const rows =
            actor === undefined
                ? this.database.all(
                      `SELECT id, actor_kind, actor_id, blueprint_digest, package_lock_digest,
                        config_digest, generation, record
                 FROM definition_materialization_generations
                 ORDER BY actor_kind, actor_id, id`,
                      []
                  )
                : this.database.all(
                      `SELECT id, actor_kind, actor_id, blueprint_digest, package_lock_digest,
                        config_digest, generation, record
                 FROM definition_materialization_generations
                 WHERE actor_kind = ? AND actor_id = ?
                 ORDER BY actor_kind, actor_id, id`,
                      [actor.kind, actor.id.value]
                  );
        return rows.map(storedGeneration);
    }

    protected writeGeneration(
        transaction: TransactionalSqlite,
        generation: StoredMaterializationGeneration
    ): StoredMaterializationGeneration {
        transaction.run(
            `INSERT OR IGNORE INTO definition_materialization_generations (
                id, actor_kind, actor_id, blueprint_digest, package_lock_digest,
                config_digest, generation, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                generation.id.value,
                generation.actorKind,
                generation.actorId.value,
                generation.blueprintDigest,
                generation.packageLockDigest,
                generation.configDigest,
                generation.generation,
                generation.bytes
            ]
        );
        return requireStored(
            this.findGeneration(transaction, generation.id),
            "materialization generation"
        );
    }

    protected findManagedState(
        _transaction: TransactionalSqlite,
        id: string
    ): StoredManagedStateRecord | undefined {
        const row = this.database.all(
            `SELECT id, generation_id, actor_kind, actor_id, logical_key,
                    record_kind, desired_digest, record
             FROM definition_managed_state WHERE id = ?`,
            [id]
        )[0];
        return row === undefined ? undefined : storedManagedState(row);
    }

    protected managedStateRecords(
        _transaction: TransactionalSqlite,
        generationId?: MaterializationGenerationId
    ): readonly StoredManagedStateRecord[] {
        const rows =
            generationId === undefined
                ? this.database.all(
                      `SELECT id, generation_id, actor_kind, actor_id, logical_key,
                        record_kind, desired_digest, record
                 FROM definition_managed_state
                 ORDER BY generation_id, logical_key, id`,
                      []
                  )
                : this.database.all(
                      `SELECT id, generation_id, actor_kind, actor_id, logical_key,
                        record_kind, desired_digest, record
                 FROM definition_managed_state
                 WHERE generation_id = ? ORDER BY generation_id, logical_key, id`,
                      [generationId.value]
                  );
        return rows.map(storedManagedState);
    }

    protected writeManagedState(
        transaction: TransactionalSqlite,
        record: StoredManagedStateRecord
    ): StoredManagedStateRecord {
        transaction.run(
            `INSERT OR IGNORE INTO definition_managed_state (
                id, generation_id, actor_kind, actor_id, logical_key,
                record_kind, desired_digest, record
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                record.id,
                record.generationId.value,
                record.actorKind,
                record.actorId.value,
                record.logicalKey,
                record.recordKind,
                record.desiredDigest,
                record.bytes
            ]
        );
        return requireStored(this.findManagedState(transaction, record.id), "managed state");
    }

    protected findGenerationPointer(
        _transaction: TransactionalSqlite,
        actor: ActorRef,
        deploymentId: DeploymentId
    ): StoredMaterializationGenerationPointer | undefined {
        const row = this.database.all(
            `SELECT actor_kind, actor_id, deployment_id, generation_id, revision, record
             FROM definition_materialization_pointers
             WHERE actor_kind = ? AND actor_id = ? AND deployment_id = ?`,
            [actor.kind, actor.id.value, deploymentId.value]
        )[0];
        return row === undefined ? undefined : storedPointer(row);
    }

    protected generationPointerRecords(
        _transaction: TransactionalSqlite
    ): readonly StoredMaterializationGenerationPointer[] {
        return this.database
            .all(
                `SELECT actor_kind, actor_id, deployment_id, generation_id, revision, record
             FROM definition_materialization_pointers
             ORDER BY actor_kind, actor_id, deployment_id`,
                []
            )
            .map(storedPointer);
    }

    protected writeGenerationPointer(
        transaction: TransactionalSqlite,
        expectedRevision: Revision | undefined,
        pointer: StoredMaterializationGenerationPointer
    ): boolean {
        const rows =
            expectedRevision === undefined
                ? transaction.all(
                      `INSERT INTO definition_materialization_pointers (
                    actor_kind, actor_id, deployment_id, generation_id, revision, record
                 ) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (actor_kind, actor_id, deployment_id) DO NOTHING
                 RETURNING record`,
                      [
                          pointer.actorKind,
                          pointer.actorId.value,
                          pointer.deploymentId,
                          pointer.generationId.value,
                          pointer.revision,
                          pointer.bytes
                      ]
                  )
                : transaction.all(
                      `UPDATE definition_materialization_pointers
                 SET generation_id = ?, revision = ?, record = ?
                 WHERE actor_kind = ? AND actor_id = ? AND deployment_id = ? AND revision = ?
                 RETURNING record`,
                      [
                          pointer.generationId.value,
                          pointer.revision,
                          pointer.bytes,
                          pointer.actorKind,
                          pointer.actorId.value,
                          pointer.deploymentId,
                          expectedRevision.value
                      ]
                  );
        if (rows.length === 0) return false;
        if (rows.length !== 1 || !equalBytes(bytes(rows[0]!, "record"), pointer.bytes)) {
            throw corruptMaterialization("Generation pointer CAS returned malformed state");
        }
        return true;
    }

    private decodeBlueprint(
        stored: StoredBlueprint,
        expectedName?: string,
        expectedVersion?: SemVer
    ): Blueprint {
        const recordBytes = copyCodecBytes(stored.bytes, "Blueprint");
        const blueprint = Blueprint.decode(recordBytes);
        const projection = projectBlueprint(blueprint, recordBytes);
        if (
            stored.name !== projection.name ||
            stored.version !== projection.version ||
            stored.digest !== projection.digest ||
            (expectedName !== undefined && blueprint.meta.name !== expectedName) ||
            (expectedVersion !== undefined &&
                blueprint.meta.version.toString() !== expectedVersion.toString())
        ) {
            throw corruptMaterialization(
                "Stored Blueprint key or projection does not match codec bytes"
            );
        }
        return blueprint;
    }

    private decodePlan(stored: StoredMaterializationPlan): MaterializationPlan {
        const recordBytes = copyCodecBytes(stored.bytes, "materialization plan");
        const plan = decodeStoredMaterialization(() => MaterializationPlan.decode(recordBytes));
        const projection = projectPlan(plan, recordBytes);
        if (!equalPlanProjection(stored, projection)) {
            throw corruptMaterialization(
                "Stored materialization-plan projection does not match codec bytes"
            );
        }
        return plan;
    }

    private decodeGeneration(
        transaction: TransactionalSqlite,
        stored: StoredMaterializationGeneration
    ): MaterializationGeneration {
        const recordBytes = copyCodecBytes(stored.bytes, "materialization generation");
        const generation = MaterializationGeneration.decode(recordBytes);
        const projection = projectGeneration(generation, recordBytes);
        if (!equalGenerationProjection(stored, projection)) {
            throw corruptMaterialization("Stored generation projection does not match codec bytes");
        }
        this.requireGenerationRecords(transaction, generation);
        return generation;
    }

    private decodeManagedState(stored: StoredManagedStateRecord): ManagedStateRecord {
        requireSupportedStoredRecordKind(stored.recordKind);
        const recordBytes = copyCodecBytes(stored.bytes, "managed state");
        const record = decodeStoredMaterialization(() => ManagedStateRecord.decode(recordBytes));
        const projection = projectManagedState(record, recordBytes);
        if (!equalManagedStateProjection(stored, projection)) {
            throw corruptMaterialization(
                "Stored managed-state projection does not match codec bytes"
            );
        }
        return record;
    }

    private decodeGenerationPointer(
        transaction: TransactionalSqlite,
        stored: StoredMaterializationGenerationPointer
    ): MaterializationGenerationPointer {
        const recordBytes = copyCodecBytes(stored.bytes, "generation pointer");
        const pointer = MaterializationGenerationPointer.decode(recordBytes);
        const projection = projectGenerationPointer(pointer, recordBytes);
        if (!equalGenerationPointerProjection(stored, projection)) {
            throw corruptMaterialization(
                "Stored generation-pointer projection does not match codec bytes"
            );
        }
        const generation = this.loadGeneration(transaction, pointer.generationId);
        if (
            generation === undefined ||
            !generation.actor.equals(pointer.actor) ||
            !generation.origin.deploymentId.equals(pointer.deploymentId)
        ) {
            throw corruptMaterialization(
                "Stored generation pointer targets missing or foreign state"
            );
        }
        return pointer;
    }

    private requireGenerationRecords(
        transaction: TransactionalSqlite,
        generation: MaterializationGeneration
    ): void {
        const records = this.managedStateRecords(transaction, generation.id).map((stored) =>
            this.decodeManagedState(stored)
        );
        const expectedIds = new Set(generation.managedRecordIds.map((id) => id.value));
        if (
            records.length !== expectedIds.size ||
            records.some((record) => !expectedIds.has(record.id.value))
        ) {
            throw corruptMaterialization(
                "Materialization generation closure does not match managed state"
            );
        }
        const logicalKeys = new Set<string>();
        for (const record of records) {
            if (
                !record.generationId.equals(generation.id) ||
                !record.actor.equals(generation.actor)
            ) {
                throw corruptMaterialization("Managed state does not belong to its generation");
            }
            if (logicalKeys.has(record.logicalKey)) {
                throw corruptMaterialization(
                    "Materialization generation contains conflicting logical keys"
                );
            }
            logicalKeys.add(record.logicalKey);
        }
    }

    private requireSupportedStoredState(transaction: TransactionalSqlite): void {
        const managedState = this.managedStateRecords(transaction);
        for (const stored of managedState) requireSupportedStoredRecordKind(stored.recordKind);
        for (const stored of this.blueprintRecords(transaction)) this.decodeBlueprint(stored);
        for (const stored of this.planRecords(transaction)) {
            requireOwnedPlan(this.decodePlan(stored), this.owner);
        }
        const records = managedState.map((stored) => this.decodeManagedState(stored));
        for (const record of records)
            requireOwnedActor(record.actor, this.owner, "Stored managed state");
        for (const stored of this.generationRecords(transaction)) {
            requireOwnedActor(
                this.decodeGeneration(transaction, stored).actor,
                this.owner,
                "Stored materialization generation"
            );
        }
        for (const record of records) {
            const generation = this.loadGeneration(transaction, record.generationId);
            if (
                generation === undefined ||
                !generation.managedRecordIds.some((id) => id.equals(record.id))
            ) {
                throw corruptMaterialization("Managed state is not referenced by its generation");
            }
        }
        for (const stored of this.generationPointerRecords(transaction)) {
            requireOwnedActor(
                this.decodeGenerationPointer(transaction, stored).actor,
                this.owner,
                "Stored generation pointer"
            );
        }
    }
}

interface SqliteObject {
    readonly name: string;
    readonly table: string;
    readonly sql: string | null;
}

interface SqliteObjects {
    readonly tables: ReadonlyMap<string, SqliteObject>;
    readonly indexes: ReadonlyMap<string, SqliteObject>;
    readonly triggers: ReadonlyMap<string, SqliteObject>;
}

function sqliteObjects(database: TransactionalSqlite): SqliteObjects {
    const rows = database.all(
        `SELECT name, type, tbl_name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger')`,
        []
    );
    const tables = new Map<string, SqliteObject>();
    const indexes = new Map<string, SqliteObject>();
    const triggers = new Map<string, SqliteObject>();
    for (const row of rows) {
        const name = text(row, "name");
        const type = text(row, "type");
        const object = {
            name,
            table: text(row, "tbl_name").toLowerCase(),
            sql: nullableText(row, "sql")
        };
        const key = name.toLowerCase();
        if (type === "table") tables.set(key, object);
        if (type === "index") indexes.set(key, object);
        if (type === "trigger") triggers.set(key, object);
    }
    return { indexes, tables, triggers };
}

function requireNoLegacyComposition(tables: ReadonlyMap<string, SqliteObject>): void {
    const legacy = [...tables.keys()].find((table) =>
        table.startsWith(LEGACY_COMPOSITION_TABLE_PREFIX)
    );
    if (legacy !== undefined) {
        throw resetRequired(`legacy table ${legacy} exists`);
    }
}

function requirePristineMaterializationSchema(objects: SqliteObjects): void {
    const existingTable = [...MATERIALIZATION_TABLES.keys()].find((table) =>
        objects.tables.has(table)
    );
    const existingIndex = [...MATERIALIZATION_INDEXES.keys()].find((index) =>
        objects.indexes.has(index)
    );
    if (existingTable !== undefined || existingIndex !== undefined) {
        throw resetRequired("definition materialization objects exist without a schema marker");
    }
}

function requireCompleteMaterializationSchema(objects: SqliteObjects): void {
    const missingTable = [...MATERIALIZATION_TABLES.keys()].find(
        (table) => !objects.tables.has(table)
    );
    const missingIndex = [...MATERIALIZATION_INDEXES.keys()].find(
        (index) => !objects.indexes.has(index)
    );
    if (missingTable !== undefined || missingIndex !== undefined) {
        throw resetRequired("the marked definition materialization schema is incomplete");
    }
    requireExactSchemaObjects(objects.tables, MATERIALIZATION_TABLES, "table");
    requireExactSchemaObjects(objects.indexes, MATERIALIZATION_INDEXES, "index");
    requireNoUnexpectedSchemaObjects(objects);
}

function requireExactSchemaObjects(
    actual: ReadonlyMap<string, SqliteObject>,
    expected: ReadonlyMap<string, string>,
    objectType: string
): void {
    for (const [name, expectedSql] of expected) {
        const actualObject = actual.get(name);
        if (
            actualObject?.sql === null ||
            actualObject === undefined ||
            normalizeSchemaSql(actualObject.sql) !== normalizeSchemaSql(expectedSql)
        ) {
            throw resetRequired(
                `the marked definition materialization ${objectType} ${name} is malformed`
            );
        }
    }
}

function requireNoUnexpectedSchemaObjects(objects: SqliteObjects): void {
    const protectedTables = new Set(MATERIALIZATION_TABLES.keys());
    for (const [name, index] of objects.indexes) {
        if (
            index.sql !== null &&
            protectedTables.has(index.table) &&
            !MATERIALIZATION_INDEXES.has(name)
        ) {
            throw resetRequired(
                `unexpected index ${index.name} targets definition materialization state`
            );
        }
    }
    for (const trigger of objects.triggers.values()) {
        if (protectedTables.has(trigger.table)) {
            throw resetRequired(
                `unexpected trigger ${trigger.name} targets definition materialization state`
            );
        }
    }
}

function requireSchemaVersion(database: TransactionalSqlite, owner: ActorRef): void {
    try {
        const rows = database.all(
            `SELECT version, owner_kind, owner_id
             FROM ${MATERIALIZATION_SCHEMA_TABLE} ORDER BY version`,
            []
        );
        if (
            rows.length === 1 &&
            rows[0]?.["version"] === MATERIALIZATION_SCHEMA_VERSION &&
            rows[0]?.["owner_kind"] === owner.kind &&
            rows[0]?.["owner_id"] === owner.id.value
        ) {
            return;
        }
    } catch {
        throw resetRequired("the definition materialization schema marker is malformed");
    }
    throw resetRequired("the definition materialization schema version is unsupported");
}

function createMaterializationSchema(database: TransactionalSqlite, owner: ActorRef): void {
    database.run(CREATE_SCHEMA, []);
    database.run(INSERT_SCHEMA, [MATERIALIZATION_SCHEMA_VERSION, owner.kind, owner.id.value]);
    database.run(CREATE_BLUEPRINTS, []);
    database.run(CREATE_PLANS, []);
    database.run(CREATE_GENERATIONS, []);
    database.run(CREATE_MANAGED_STATE, []);
    database.run(CREATE_POINTERS, []);
    database.run(CREATE_GENERATION_ACTOR_INDEX, []);
    database.run(CREATE_MANAGED_GENERATION_INDEX, []);
}

function requireSupportedStoredRecordKind(recordKind: string): void {
    if (ManagedStateRecord.supportedRecordKinds().includes(recordKind)) return;
    throw resetRequired(`unsupported managed-state kind ${recordKind}`);
}

function decodeStoredMaterialization<Value>(decode: () => Value): Value {
    try {
        return decode();
    } catch (error) {
        if (isUnsupportedMaterializationKindError(error)) {
            throw resetRequired(
                "stored codec bytes contain an unsupported materialization closure"
            );
        }
        throw corruptMaterialization(
            error instanceof Error ? error.message : "Stored materialization codec decode failed"
        );
    }
}

function isUnsupportedMaterializationKindError(error: unknown): boolean {
    return (
        error instanceof Error && error.message.includes("Unsupported materialization record kind")
    );
}

function projectBlueprint(blueprint: Blueprint, recordBytes: Uint8Array): StoredBlueprint {
    return {
        name: blueprint.meta.name,
        version: blueprint.meta.version.toString(),
        digest: Digest.sha256(recordBytes).value,
        bytes: recordBytes.slice()
    };
}

function projectPlan(
    plan: MaterializationPlan,
    recordBytes: Uint8Array
): StoredMaterializationPlan {
    return {
        id: plan.id.value,
        blueprintDigest: plan.blueprintDigest.value,
        packageLockDigest: plan.packageLockDigest.value,
        configDigest: plan.configDigest.value,
        generation: plan.generation,
        bytes: recordBytes.slice()
    };
}

function projectGeneration(
    generation: MaterializationGeneration,
    recordBytes: Uint8Array
): StoredMaterializationGeneration {
    return {
        id: generation.id,
        actorKind: generation.actor.kind,
        actorId: new ActorId(generation.actor.id.value),
        blueprintDigest: generation.origin.blueprintDigest.value,
        packageLockDigest: generation.origin.packageLockDigest.value,
        configDigest: generation.origin.configDigest.value,
        generation: generation.origin.generation,
        bytes: recordBytes.slice()
    };
}

function projectManagedState(
    record: ManagedStateRecord,
    recordBytes: Uint8Array
): StoredManagedStateRecord {
    return {
        id: record.id.value,
        generationId: record.generationId,
        actorKind: record.actor.kind,
        actorId: new ActorId(record.actor.id.value),
        logicalKey: record.logicalKey,
        recordKind: record.recordKind,
        desiredDigest: record.desiredDigest.value,
        bytes: recordBytes.slice()
    };
}

function projectGenerationPointer(
    pointer: MaterializationGenerationPointer,
    recordBytes: Uint8Array
): StoredMaterializationGenerationPointer {
    return {
        actorKind: pointer.actor.kind,
        actorId: new ActorId(pointer.actor.id.value),
        deploymentId: pointer.deploymentId.value,
        generationId: pointer.generationId,
        revision: pointer.revision.value,
        bytes: recordBytes.slice()
    };
}

function equalPlanProjection(
    left: StoredMaterializationPlan,
    right: StoredMaterializationPlan
): boolean {
    return (
        left.id === right.id &&
        left.blueprintDigest === right.blueprintDigest &&
        left.packageLockDigest === right.packageLockDigest &&
        left.configDigest === right.configDigest &&
        left.generation === right.generation
    );
}

function equalGenerationProjection(
    left: StoredMaterializationGeneration,
    right: StoredMaterializationGeneration
): boolean {
    return (
        left.id.equals(right.id) &&
        left.actorKind === right.actorKind &&
        left.actorId.equals(right.actorId) &&
        left.blueprintDigest === right.blueprintDigest &&
        left.packageLockDigest === right.packageLockDigest &&
        left.configDigest === right.configDigest &&
        left.generation === right.generation
    );
}

function equalManagedStateProjection(
    left: StoredManagedStateRecord,
    right: StoredManagedStateRecord
): boolean {
    return (
        left.id === right.id &&
        left.generationId.equals(right.generationId) &&
        left.actorKind === right.actorKind &&
        left.actorId.equals(right.actorId) &&
        left.logicalKey === right.logicalKey &&
        left.recordKind === right.recordKind &&
        left.desiredDigest === right.desiredDigest
    );
}

function equalGenerationPointerProjection(
    left: StoredMaterializationGenerationPointer,
    right: StoredMaterializationGenerationPointer
): boolean {
    return (
        left.actorKind === right.actorKind &&
        left.actorId.equals(right.actorId) &&
        left.deploymentId === right.deploymentId &&
        left.generationId.equals(right.generationId) &&
        left.revision === right.revision
    );
}

function compareBlueprints(left: Blueprint, right: Blueprint): number {
    return (
        compareText(left.meta.name, right.meta.name) ||
        compareText(left.meta.version.toString(), right.meta.version.toString())
    );
}

function compareGenerations(
    left: MaterializationGeneration,
    right: MaterializationGeneration
): number {
    return compareActors(left.actor, right.actor) || compareText(left.id.value, right.id.value);
}

function compareManagedState(left: ManagedStateRecord, right: ManagedStateRecord): number {
    return (
        compareText(left.generationId.value, right.generationId.value) ||
        compareText(left.logicalKey, right.logicalKey) ||
        compareText(left.id.value, right.id.value)
    );
}

function compareActors(left: ActorRef, right: ActorRef): number {
    return compareText(left.kind, right.kind) || compareText(left.id.value, right.id.value);
}

function requireOwnedPlan(plan: MaterializationPlan, owner: ActorRef): void {
    if (plan.actors.length !== 1 || !plan.actors[0]!.actor.equals(owner)) {
        throw invalidMaterializationState(
            "Materialization plan must target exactly the store owner"
        );
    }
}

function requireOwnedActor(actor: ActorRef, owner: ActorRef, subject: string): void {
    if (!actor.equals(owner))
        throw invalidMaterializationState(`${subject} belongs to a different Actor`);
}

function requireTenantDefinitionOwner(owner: ActorRef, subject: string): void {
    if (owner.kind !== "tenant") {
        throw invalidMaterializationState(`${subject} is stored only by its Tenant control Actor`);
    }
}

function storedBlueprint(row: SqliteRow): StoredBlueprint {
    return {
        name: text(row, "name"),
        version: text(row, "version"),
        digest: text(row, "digest"),
        bytes: bytes(row, "record")
    };
}

function storedPlan(row: SqliteRow): StoredMaterializationPlan {
    return {
        id: text(row, "id"),
        blueprintDigest: text(row, "blueprint_digest"),
        packageLockDigest: text(row, "package_lock_digest"),
        configDigest: text(row, "config_digest"),
        generation: integer(row, "generation"),
        bytes: bytes(row, "record")
    };
}

function storedGeneration(row: SqliteRow): StoredMaterializationGeneration {
    return {
        id: new MaterializationGenerationId(text(row, "id")),
        actorKind: text(row, "actor_kind"),
        actorId: new ActorId(text(row, "actor_id")),
        blueprintDigest: text(row, "blueprint_digest"),
        packageLockDigest: text(row, "package_lock_digest"),
        configDigest: text(row, "config_digest"),
        generation: integer(row, "generation"),
        bytes: bytes(row, "record")
    };
}

function storedManagedState(row: SqliteRow): StoredManagedStateRecord {
    return {
        id: text(row, "id"),
        generationId: new MaterializationGenerationId(text(row, "generation_id")),
        actorKind: text(row, "actor_kind"),
        actorId: new ActorId(text(row, "actor_id")),
        logicalKey: text(row, "logical_key"),
        recordKind: text(row, "record_kind"),
        desiredDigest: text(row, "desired_digest"),
        bytes: bytes(row, "record")
    };
}

function storedPointer(row: SqliteRow): StoredMaterializationGenerationPointer {
    return {
        actorKind: text(row, "actor_kind"),
        actorId: new ActorId(text(row, "actor_id")),
        deploymentId: text(row, "deployment_id"),
        generationId: new MaterializationGenerationId(text(row, "generation_id")),
        revision: integer(row, "revision"),
        bytes: bytes(row, "record")
    };
}

function text(row: SqliteRow, column: string): string {
    const value = row[column];
    if (typeof value !== "string" || value.length === 0) {
        throw corruptMaterialization(`Stored materialization ${column} projection is malformed`);
    }
    return value;
}

function nullableText(row: SqliteRow, column: string): string | null {
    const value = row[column];
    if (value === null || typeof value === "string") return value;
    throw corruptMaterialization(`Stored materialization ${column} projection is malformed`);
}

function integer(row: SqliteRow, column: string): number {
    const value = row[column];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw corruptMaterialization(`Stored materialization ${column} projection is malformed`);
    }
    return value;
}

function bytes(row: SqliteRow, column: string): Uint8Array {
    const value = row[column];
    if (!(value instanceof Uint8Array)) {
        throw corruptMaterialization(`Stored materialization ${column} bytes are malformed`);
    }
    return value.slice();
}

function requireStored<Value>(value: Value | undefined, subject: string): Value {
    if (value === undefined) {
        throw corruptMaterialization(`${subject} insert did not produce a durable row`);
    }
    return value;
}

function copyCodecBytes(value: Uint8Array, subject: string): Uint8Array {
    if (!(value instanceof Uint8Array)) {
        throw corruptMaterialization(`Stored ${subject} codec bytes are malformed`);
    }
    return value.slice();
}

function requireEqualImmutable(actual: Uint8Array, expected: Uint8Array, subject: string): void {
    if (!equalBytes(actual, expected)) throw invalidMaterializationState(`${subject} is immutable`);
}

function requireUnique(keys: readonly string[], message: string): void {
    if (new Set(keys).size !== keys.length) throw corruptMaterialization(message);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function requireMaterializationKindCheck(column: string): string {
    const kinds = ManagedStateRecord.supportedRecordKinds();
    if (kinds.length === 0) throw new TypeError("Materialization record-kind registry is empty");
    return `${column} IN (${kinds.map(sqlString).join(", ")})`;
}

function sqlString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function normalizeSchemaSql(sql: string): string {
    return sql
        .replace(/\bIF\s+NOT\s+EXISTS\s+/iu, "")
        .replaceAll(/\s+/gu, " ")
        .trim();
}

function corruptMaterialization(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}

function invalidMaterializationState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

function materializationRevisionConflict(message: string): AgentCoreError {
    return new AgentCoreError("protocol.revision-conflict", message);
}

function resetRequired(reason: string): AgentCoreError {
    return new AgentCoreError(
        "codec.invalid",
        `Materialization reset required (reset-required): ${reason}`
    );
}
