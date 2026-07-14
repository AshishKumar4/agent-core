import { Database } from "bun:sqlite";
import {
    ActorId,
    ActorRef,
    requireSynchronousResult,
    type SynchronousResultGuard
} from "../../../src/actors";
import { Digest } from "../../../src/core";
import {
    ActorPlan,
    DeploymentId,
    DeploymentKey,
    ManagedOrigin,
    MaterializationPlan,
    PolicySet,
    policyProjection
} from "../../../src/definition";
import { TenantId } from "../../../src/identity";
import { SqliteMaterializationStore } from "../../../src/substrates/sqlite/materialization";
import {
    TransactionalSqlite,
    type SqliteRow,
    type SqliteValue
} from "../../../src/substrates/sqlite/sqlite";

class BunSqlite extends TransactionalSqlite {
    readonly #database = new Database(":memory:");

    public all(statement: string, bindings: readonly SqliteValue[]): readonly SqliteRow[] {
        return this.#database.query<SqliteRow, SqliteValue[]>(statement).all(...bindings);
    }

    public run(statement: string, bindings: readonly SqliteValue[]): void {
        this.#database.query<SqliteRow, SqliteValue[]>(statement).run(...bindings);
    }

    public transaction<Result>(
        operation: () => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        return this.#database.transaction(() => requireSynchronousResult(operation()))();
    }
}

const database = new BunSqlite();
const owner = new ActorRef("tenant", new ActorId("bun-native"));
const store = new SqliteMaterializationStore(database, owner);
const tenantId = new TenantId("tenant");
const origin = new ManagedOrigin({
    tenantId,
    deploymentId: DeploymentId.derive(tenantId, new DeploymentKey("platform")),
    attestationDigest: digest("attestation"),
    blueprintDigest: digest("blueprint"),
    packageLockDigest: digest("lock"),
    configDigest: digest("config"),
    generation: 1
});
const plan = new MaterializationPlan({
    origin,
    actors: [
        new ActorPlan({
            actor: owner,
            origin,
            projections: [policyProjection("policy:bun", PolicySet.empty())]
        })
    ]
});
store.addPlan(plan);
const restarted = new SqliteMaterializationStore(database, owner);
if (!restarted.getPlan(plan.id)?.id.equals(plan.id)) {
    throw new TypeError("Bun SQLite failed to restore a canonical materialization plan");
}

const legacy = new BunSqlite();
legacy.run("CREATE TABLE Composition_Slot_Entries (sentinel TEXT)", []);
legacy.run("INSERT INTO Composition_Slot_Entries VALUES ('keep')", []);
let resetRequired = false;
try {
    new SqliteMaterializationStore(legacy, owner);
} catch (error) {
    resetRequired = error instanceof Error && /reset.required/iu.test(error.message);
}
if (
    !resetRequired ||
    legacy.all("SELECT sentinel FROM Composition_Slot_Entries", [])[0]?.["sentinel"] !== "keep"
) {
    throw new TypeError("Bun SQLite did not preserve legacy Slot state behind reset-required");
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}
