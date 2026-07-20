import {
    ContentRef,
    Digest,
    InvocationId,
    TenantId,
    WorkspaceId,
    encodeCanonicalJson
} from "@agent-core/core";
import {
    SlateDeploymentId,
    SlateEffectContext,
    SlateId,
    SlateProvider,
    SlatePublicationId,
    SlateResourceId,
    type SlateProviderDeployment,
    type SlateProviderDeploymentRequest,
    type SlateProviderResource,
    type SlateProviderResourceRequest
} from "@agent-core/core/slate-provider";
import type { R2ContentObjectRepository } from "./content-object.js";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { SqliteApplicationMigration, SynchronousSqlitePort } from "./migration.js";

const DEPLOYMENT_FORMAT = "agent-core-slate-deployment/1";
const RESOURCE_FORMAT = "agent-core-slate-resource/1";

const READ_DEPLOYMENT = `SELECT invocation_id, idempotency_key, workspace_id, slate_id, publication_id,
        publication_materialization, target, expected_active_deployment_id, materialization
    FROM agent_core_slate_deployments WHERE deployment_id = ?`;
const INSERT_DEPLOYMENT = `INSERT INTO agent_core_slate_deployments
    (deployment_id, invocation_id, idempotency_key, workspace_id, slate_id, publication_id,
        publication_materialization, target, expected_active_deployment_id, materialization)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const READ_RESOURCE = `SELECT invocation_id, idempotency_key, workspace_id, slate_id, deployment_id,
        deployment_materialization, resource_name, resource_source, materialization
    FROM agent_core_slate_resources WHERE resource_id = ?`;
const INSERT_RESOURCE = `INSERT INTO agent_core_slate_resources
    (resource_id, invocation_id, idempotency_key, workspace_id, slate_id, deployment_id,
        deployment_materialization, resource_name, resource_source, materialization)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function slateProviderMigration(version: number): SqliteApplicationMigration {
    return Object.freeze({
        version,
        name: "cloudflare-slate-provider",
        statements: Object.freeze([
            `CREATE TABLE agent_core_slate_deployments (
                deployment_id TEXT PRIMARY KEY,
                invocation_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                slate_id TEXT NOT NULL,
                publication_id TEXT NOT NULL,
                publication_materialization TEXT NOT NULL,
                target TEXT NOT NULL,
                expected_active_deployment_id TEXT,
                materialization TEXT NOT NULL
            ) STRICT`,
            `CREATE TABLE agent_core_slate_resources (
                resource_id TEXT PRIMARY KEY,
                invocation_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                slate_id TEXT NOT NULL,
                deployment_id TEXT NOT NULL,
                deployment_materialization TEXT NOT NULL,
                resource_name TEXT NOT NULL,
                resource_source TEXT NOT NULL,
                materialization TEXT NOT NULL
            ) STRICT`
        ])
    });
}

interface DeploymentRecord {
    readonly invocation: string;
    readonly idempotencyKey: string;
    readonly workspace: string;
    readonly slate: string;
    readonly publication: string;
    readonly publicationMaterialization: string;
    readonly target: string;
    readonly expectedActiveDeployment: string | null;
    readonly materialization: string;
}

interface ResourceRecord {
    readonly invocation: string;
    readonly idempotencyKey: string;
    readonly workspace: string;
    readonly slate: string;
    readonly deployment: string;
    readonly deploymentMaterialization: string;
    readonly resourceName: string;
    readonly resourceSource: string;
    readonly materialization: string;
}

/**
 * Slate substrate over a Durable Object's private SQLite and an R2 content repository.
 * A deployment or resource effect happens at most once per identity: the persisted row
 * is the evidence, the content-addressed R2 manifest is the materialization, and any
 * replay — first attempt, retried attempt, or reconciliation after an indeterminate
 * outcome — settles to the exact recorded ContentRef. A recorded row that disagrees
 * with its request on any bound field is an identity reuse and fails definitively.
 */
export class DurableObjectSlateProvider extends SlateProvider {
    public constructor(
        private readonly database: SynchronousSqlitePort,
        private readonly content: R2ContentObjectRepository,
        private readonly tenantId: TenantId,
        private readonly errors: CloudflareErrorPort
    ) {
        super();
        if (!(tenantId instanceof TenantId)) {
            operationalFailure(
                errors,
                "operation.invalid-input",
                "Slate provider tenant ID must be a TenantId"
            );
        }
    }

    public async deploy(request: SlateProviderDeploymentRequest): Promise<SlateProviderDeployment> {
        return this.settleDeployment(request);
    }

    public async reconcileDeployment(
        request: SlateProviderDeploymentRequest
    ): Promise<SlateProviderDeployment> {
        return this.settleDeployment(request);
    }

    public async materializeResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource> {
        return this.settleResource(request);
    }

    public async reconcileResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource> {
        return this.settleResource(request);
    }

    private async settleDeployment(
        request: SlateProviderDeploymentRequest
    ): Promise<SlateProviderDeployment> {
        this.validateDeploymentRequest(request);
        const existing = this.readDeployment(request.deploymentId.value);
        if (existing !== undefined) return this.replayDeployment(existing, request);

        const manifest = await this.content.put(
            this.tenantId,
            encodeCanonicalJson({
                deploymentId: request.deploymentId.value,
                format: DEPLOYMENT_FORMAT,
                publicationId: request.publicationId.value,
                publicationMaterialization: request.publicationMaterialization.value,
                slateId: request.slateId.value,
                target: request.target,
                workspaceId: request.workspaceId.value
            })
        );
        const materialization = ContentRef.fromDigest(new Digest(manifest.digest));
        return this.database.transaction(() => {
            const raced = this.readDeployment(request.deploymentId.value);
            if (raced !== undefined) return this.replayDeployment(raced, request);
            this.database.run(INSERT_DEPLOYMENT, [
                request.deploymentId.value,
                request.invocationId.value,
                request.idempotencyKey,
                request.workspaceId.value,
                request.slateId.value,
                request.publicationId.value,
                request.publicationMaterialization.value,
                request.target,
                request.expectedActiveDeploymentId?.value ?? null,
                materialization.value
            ]);
            return { materialization };
        });
    }

    private async settleResource(
        request: SlateProviderResourceRequest
    ): Promise<SlateProviderResource> {
        this.validateResourceRequest(request);
        const existing = this.readResource(request.resourceId.value);
        if (existing !== undefined) return this.replayResource(existing, request);

        const manifest = await this.content.put(
            this.tenantId,
            encodeCanonicalJson({
                deploymentId: request.deploymentId.value,
                deploymentMaterialization: request.deploymentMaterialization.value,
                format: RESOURCE_FORMAT,
                resourceId: request.resourceId.value,
                resourceName: request.resourceName,
                resourceSource: request.resourceSource.value,
                slateId: request.slateId.value,
                workspaceId: request.workspaceId.value
            })
        );
        const materialization = ContentRef.fromDigest(new Digest(manifest.digest));
        return this.database.transaction(() => {
            const raced = this.readResource(request.resourceId.value);
            if (raced !== undefined) return this.replayResource(raced, request);
            this.database.run(INSERT_RESOURCE, [
                request.resourceId.value,
                request.invocationId.value,
                request.idempotencyKey,
                request.workspaceId.value,
                request.slateId.value,
                request.deploymentId.value,
                request.deploymentMaterialization.value,
                request.resourceName,
                request.resourceSource.value,
                materialization.value
            ]);
            return { materialization };
        });
    }

    private replayDeployment(
        record: DeploymentRecord,
        request: SlateProviderDeploymentRequest
    ): SlateProviderDeployment {
        if (
            record.invocation !== request.invocationId.value ||
            record.idempotencyKey !== request.idempotencyKey ||
            record.workspace !== request.workspaceId.value ||
            record.slate !== request.slateId.value ||
            record.publication !== request.publicationId.value ||
            record.publicationMaterialization !== request.publicationMaterialization.value ||
            record.target !== request.target ||
            record.expectedActiveDeployment !== (request.expectedActiveDeploymentId?.value ?? null)
        ) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                `Slate deployment ${request.deploymentId.value} was recorded for a different effect identity`
            );
        }
        return { materialization: new ContentRef(record.materialization) };
    }

    private replayResource(
        record: ResourceRecord,
        request: SlateProviderResourceRequest
    ): SlateProviderResource {
        if (
            record.invocation !== request.invocationId.value ||
            record.idempotencyKey !== request.idempotencyKey ||
            record.workspace !== request.workspaceId.value ||
            record.slate !== request.slateId.value ||
            record.deployment !== request.deploymentId.value ||
            record.deploymentMaterialization !== request.deploymentMaterialization.value ||
            record.resourceName !== request.resourceName ||
            record.resourceSource !== request.resourceSource.value
        ) {
            operationalFailure(
                this.errors,
                "protocol.invalid-state",
                `Slate resource ${request.resourceId.value} was recorded for a different effect identity`
            );
        }
        return { materialization: new ContentRef(record.materialization) };
    }

    private readDeployment(deployment: string): DeploymentRecord | undefined {
        const rows = this.database.all(READ_DEPLOYMENT, [deployment]);
        if (rows.length === 0) return undefined;
        const row = rows[0];
        const invocation = row?.invocation_id;
        const idempotencyKey = row?.idempotency_key;
        const workspace = row?.workspace_id;
        const slate = row?.slate_id;
        const publication = row?.publication_id;
        const publicationMaterialization = row?.publication_materialization;
        const target = row?.target;
        const expectedActiveDeployment = row?.expected_active_deployment_id;
        const materialization = row?.materialization;
        if (
            typeof invocation !== "string" ||
            typeof idempotencyKey !== "string" ||
            typeof workspace !== "string" ||
            typeof slate !== "string" ||
            typeof publication !== "string" ||
            typeof publicationMaterialization !== "string" ||
            typeof target !== "string" ||
            (expectedActiveDeployment !== null && typeof expectedActiveDeployment !== "string") ||
            typeof materialization !== "string"
        ) {
            this.corrupt("Slate deployment record is corrupt");
        }
        return {
            invocation,
            idempotencyKey,
            workspace,
            slate,
            publication,
            publicationMaterialization,
            target,
            expectedActiveDeployment: expectedActiveDeployment ?? null,
            materialization
        };
    }

    private readResource(resource: string): ResourceRecord | undefined {
        const rows = this.database.all(READ_RESOURCE, [resource]);
        if (rows.length === 0) return undefined;
        const row = rows[0];
        const invocation = row?.invocation_id;
        const idempotencyKey = row?.idempotency_key;
        const workspace = row?.workspace_id;
        const slate = row?.slate_id;
        const deployment = row?.deployment_id;
        const deploymentMaterialization = row?.deployment_materialization;
        const resourceName = row?.resource_name;
        const resourceSource = row?.resource_source;
        const materialization = row?.materialization;
        if (
            typeof invocation !== "string" ||
            typeof idempotencyKey !== "string" ||
            typeof workspace !== "string" ||
            typeof slate !== "string" ||
            typeof deployment !== "string" ||
            typeof deploymentMaterialization !== "string" ||
            typeof resourceName !== "string" ||
            typeof resourceSource !== "string" ||
            typeof materialization !== "string"
        ) {
            this.corrupt("Slate resource record is corrupt");
        }
        return {
            invocation,
            idempotencyKey,
            workspace,
            slate,
            deployment,
            deploymentMaterialization,
            resourceName,
            resourceSource,
            materialization
        };
    }

    private validateDeploymentRequest(request: SlateProviderDeploymentRequest): void {
        if (request.operation !== "deploy" || request.impact !== "externalSend") {
            this.invalid("Slate deployment request must carry the deploy externalSend intent");
        }
        this.requireIdentifier(request.deploymentId, SlateDeploymentId, "Slate deployment ID");
        this.requireIdentifier(request.publicationId, SlatePublicationId, "Slate publication ID");
        if (!(request.publicationMaterialization instanceof ContentRef)) {
            this.invalid("Slate publication materialization must be a ContentRef");
        }
        if (
            request.expectedActiveDeploymentId !== undefined &&
            !(request.expectedActiveDeploymentId instanceof SlateDeploymentId)
        ) {
            this.invalid("Slate expected active deployment must be a SlateDeploymentId");
        }
        this.requireCanonicalText(request.target, "Slate deployment target");
        this.validateEffectRequest(request);
    }

    private validateResourceRequest(request: SlateProviderResourceRequest): void {
        if (request.operation !== "resource.materialize" || request.impact !== "externalSend") {
            this.invalid(
                "Slate resource request must carry the resource.materialize externalSend intent"
            );
        }
        this.requireIdentifier(request.resourceId, SlateResourceId, "Slate resource ID");
        this.requireIdentifier(request.deploymentId, SlateDeploymentId, "Slate deployment ID");
        if (!(request.deploymentMaterialization instanceof ContentRef)) {
            this.invalid("Slate deployment materialization must be a ContentRef");
        }
        if (!(request.resourceSource instanceof ContentRef)) {
            this.invalid("Slate resource source must be a ContentRef");
        }
        this.requireCanonicalText(request.resourceName, "Slate resource name");
        this.validateEffectRequest(request);
    }

    private validateEffectRequest(
        request: SlateProviderDeploymentRequest | SlateProviderResourceRequest
    ): void {
        this.requireIdentifier(request.workspaceId, WorkspaceId, "Slate workspace ID");
        this.requireIdentifier(request.slateId, SlateId, "Slate ID");
        this.requireIdentifier(request.invocationId, InvocationId, "Slate invocation ID");
        if (
            !(request.effectContext instanceof SlateEffectContext) ||
            !request.effectContext.invocationId.equals(request.invocationId) ||
            request.effectContext.idempotencyKey !== request.idempotencyKey
        ) {
            this.invalid("Slate effect context must bind the request invocation exactly");
        }
        this.requireCanonicalText(request.idempotencyKey, "Slate idempotency key");
    }

    private requireIdentifier<Identifier>(
        value: unknown,
        constructor: new (value: string) => Identifier,
        name: string
    ): asserts value is Identifier {
        if (!(value instanceof constructor)) {
            this.invalid(`${name} must use its canonical branded class`);
        }
    }

    private requireCanonicalText(value: string, name: string): void {
        if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
            this.invalid(`${name} must be canonical non-empty text`);
        }
    }

    private invalid(message: string): never {
        return operationalFailure(this.errors, "operation.invalid-input", message);
    }

    private corrupt(message: string): never {
        return operationalFailure(this.errors, "codec.invalid", message);
    }
}
