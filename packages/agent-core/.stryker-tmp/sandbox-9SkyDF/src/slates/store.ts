// @ts-nocheck
import { ContentRef, RecordCodec, Revision, type JsonValue } from "../core";
import { requireSynchronousResult } from "../actors";
import { AgentCoreError } from "../errors";
import { WorkspaceId } from "../identity";
import { InvocationId } from "../interaction-references";
import {
    contentRef,
    deploymentId,
    requireExactObject,
    invocationId,
    nullableString,
    publicationId,
    requireText,
    resourceId,
    slateId,
    requireStringValue,
    workspaceId
} from "./codec";
import { SlateDeployment } from "./deployment";
import { SlateDeploymentId, SlateId, SlatePublicationId, SlateResourceId } from "./id";
import { SlatePreview } from "./preview";
import { SlatePublication } from "./publication";
import { SlateResource } from "./resource";
import { Slate } from "./slate";
import { SlateVersion } from "./version";

export interface SlateDeploymentReservationInit {
    readonly id: SlateDeploymentId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly publicationId: SlatePublicationId;
    readonly publicationMaterialization: ContentRef;
    readonly target: string;
    readonly invocationId: InvocationId;
    /**
     * The canonical effect identity of the facet-level invocation that requested this
     * deployment. Deploy consults it before reserving, so a crash-after-send retry
     * reconciles the existing reservation instead of minting a second deployment.
     */
    readonly externalKey: string;
    readonly expectedActiveDeploymentId?: SlateDeploymentId;
}

class SlateDeploymentReservationCodec extends RecordCodec<SlateDeploymentReservation> {
    public constructor() {
        super("slate.deployment-reservation", { major: 1, minor: 1 });
    }

    protected encodePayload(reservation: SlateDeploymentReservation): JsonValue {
        return reservation.toData();
    }

    protected decodePayload(payload: JsonValue): SlateDeploymentReservation {
        return SlateDeploymentReservation.fromData(payload);
    }
}

export class SlateDeploymentReservation {
    public static readonly codec: RecordCodec<SlateDeploymentReservation> =
        new SlateDeploymentReservationCodec();
    public readonly target: string;

    public static encode(reservation: SlateDeploymentReservation): Uint8Array {
        return SlateDeploymentReservation.codec.encode(reservation);
    }

    public static decode(bytes: Uint8Array): SlateDeploymentReservation {
        return SlateDeploymentReservation.codec.decode(bytes);
    }

    public constructor(init: SlateDeploymentReservationInit) {
        if (
            !(init.id instanceof SlateDeploymentId) ||
            !(init.workspaceId instanceof WorkspaceId) ||
            !(init.slateId instanceof SlateId) ||
            !(init.publicationId instanceof SlatePublicationId) ||
            !(init.publicationMaterialization instanceof ContentRef) ||
            !(init.invocationId instanceof InvocationId) ||
            (init.expectedActiveDeploymentId !== undefined &&
                !(init.expectedActiveDeploymentId instanceof SlateDeploymentId))
        ) {
            throw new TypeError("Slate deployment reservation is malformed");
        }
        this.id = init.id;
        this.workspaceId = init.workspaceId;
        this.slateId = init.slateId;
        this.publicationId = init.publicationId;
        this.publicationMaterialization = init.publicationMaterialization;
        this.target = requireText(init.target, "Slate deployment target");
        this.externalKey = requireText(init.externalKey, "Slate deployment external key");
        this.invocationId = init.invocationId;
        this.expectedActiveDeploymentId = init.expectedActiveDeploymentId;
        Object.freeze(this);
    }

    public readonly id: SlateDeploymentId;
    public readonly workspaceId: WorkspaceId;
    public readonly slateId: SlateId;
    public readonly publicationId: SlatePublicationId;
    public readonly publicationMaterialization: ContentRef;
    public readonly invocationId: InvocationId;
    public readonly externalKey: string;
    public readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;

    public toData(): JsonValue {
        return {
            expectedActiveDeploymentId: this.expectedActiveDeploymentId?.value ?? null,
            externalKey: this.externalKey,
            id: this.id.value,
            invocationId: this.invocationId.value,
            publicationId: this.publicationId.value,
            publicationMaterialization: this.publicationMaterialization.value,
            slateId: this.slateId.value,
            target: this.target,
            workspaceId: this.workspaceId.value
        };
    }

    public static fromData(payload: JsonValue): SlateDeploymentReservation {
        const object = requireExactObject(
            payload,
            [
                "expectedActiveDeploymentId",
                "externalKey",
                "id",
                "invocationId",
                "publicationId",
                "publicationMaterialization",
                "slateId",
                "target",
                "workspaceId"
            ],
            "Slate deployment reservation payload"
        );
        const expected = nullableString(
            object["expectedActiveDeploymentId"],
            "Expected active deployment ID"
        );
        return new SlateDeploymentReservation({
            id: deploymentId(object["id"]),
            workspaceId: workspaceId(object["workspaceId"]),
            slateId: slateId(object["slateId"]),
            publicationId: publicationId(object["publicationId"]),
            publicationMaterialization: contentRef(
                object["publicationMaterialization"],
                "Slate publication materialization"
            ),
            target: requireStringValue(object["target"], "Slate deployment target"),
            externalKey: requireStringValue(object["externalKey"], "Slate deployment external key"),
            invocationId: invocationId(object["invocationId"]),
            ...(expected === undefined
                ? {}
                : { expectedActiveDeploymentId: deploymentId(expected) })
        });
    }
}

export interface SlateResourceReservationInit {
    readonly id: SlateResourceId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly deploymentId: SlateDeploymentId;
    readonly deploymentMaterialization: ContentRef;
    readonly name: string;
    readonly source: ContentRef;
    readonly invocationId: InvocationId;
}

class SlateResourceReservationCodec extends RecordCodec<SlateResourceReservation> {
    public constructor() {
        super("slate.resource-reservation", { major: 1, minor: 0 });
    }

    protected encodePayload(reservation: SlateResourceReservation): JsonValue {
        return reservation.toData();
    }

    protected decodePayload(payload: JsonValue): SlateResourceReservation {
        return SlateResourceReservation.fromData(payload);
    }
}

export class SlateResourceReservation {
    public static readonly codec: RecordCodec<SlateResourceReservation> =
        new SlateResourceReservationCodec();
    public readonly name: string;

    public static encode(reservation: SlateResourceReservation): Uint8Array {
        return SlateResourceReservation.codec.encode(reservation);
    }

    public static decode(bytes: Uint8Array): SlateResourceReservation {
        return SlateResourceReservation.codec.decode(bytes);
    }

    public constructor(init: SlateResourceReservationInit) {
        if (
            !(init.id instanceof SlateResourceId) ||
            !(init.workspaceId instanceof WorkspaceId) ||
            !(init.slateId instanceof SlateId) ||
            !(init.deploymentId instanceof SlateDeploymentId) ||
            !(init.deploymentMaterialization instanceof ContentRef) ||
            !(init.source instanceof ContentRef) ||
            !(init.invocationId instanceof InvocationId)
        ) {
            throw new TypeError("Slate resource reservation is malformed");
        }
        this.id = init.id;
        this.workspaceId = init.workspaceId;
        this.slateId = init.slateId;
        this.deploymentId = init.deploymentId;
        this.deploymentMaterialization = init.deploymentMaterialization;
        this.name = requireText(init.name, "Slate resource name", 256);
        this.source = init.source;
        this.invocationId = init.invocationId;
        Object.freeze(this);
    }

    public readonly id: SlateResourceId;
    public readonly workspaceId: WorkspaceId;
    public readonly slateId: SlateId;
    public readonly deploymentId: SlateDeploymentId;
    public readonly deploymentMaterialization: ContentRef;
    public readonly source: ContentRef;
    public readonly invocationId: InvocationId;

    public toData(): JsonValue {
        return {
            deploymentId: this.deploymentId.value,
            deploymentMaterialization: this.deploymentMaterialization.value,
            id: this.id.value,
            invocationId: this.invocationId.value,
            name: this.name,
            slateId: this.slateId.value,
            source: this.source.value,
            workspaceId: this.workspaceId.value
        };
    }

    public static fromData(payload: JsonValue): SlateResourceReservation {
        const object = requireExactObject(
            payload,
            [
                "deploymentId",
                "deploymentMaterialization",
                "id",
                "invocationId",
                "name",
                "slateId",
                "source",
                "workspaceId"
            ],
            "Slate resource reservation payload"
        );
        return new SlateResourceReservation({
            id: resourceId(object["id"]),
            workspaceId: workspaceId(object["workspaceId"]),
            slateId: slateId(object["slateId"]),
            deploymentId: deploymentId(object["deploymentId"]),
            deploymentMaterialization: contentRef(
                object["deploymentMaterialization"],
                "Slate deployment materialization"
            ),
            name: requireStringValue(object["name"], "Slate resource name"),
            source: contentRef(object["source"], "Slate resource source"),
            invocationId: invocationId(object["invocationId"])
        });
    }
}

export interface StoredSlate {
    readonly id: string;
    readonly workspaceId: WorkspaceId;
    readonly revision: number;
    readonly bytes: Uint8Array;
}

export interface StoredSlateRecord {
    readonly id: string;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly bytes: Uint8Array;
}

export interface StoredSlateReservation extends StoredSlateRecord {
    readonly invocationId: InvocationId;
}

export interface MemorySlateSnapshot {
    readonly slates: readonly StoredSlate[];
    readonly versions: readonly StoredSlateRecord[];
    readonly publications: readonly StoredSlateRecord[];
    readonly deployments: readonly StoredSlateRecord[];
    readonly resources: readonly StoredSlateRecord[];
    readonly previews: readonly StoredSlateRecord[];
    readonly deploymentReservations: readonly StoredSlateReservation[];
    readonly resourceReservations: readonly StoredSlateReservation[];
}

const EMPTY_SNAPSHOT: MemorySlateSnapshot = {
    slates: [],
    versions: [],
    publications: [],
    deployments: [],
    resources: [],
    previews: [],
    deploymentReservations: [],
    resourceReservations: []
};

export abstract class SlateStore {
    public abstract transaction<Result>(operation: (store: SlateStore) => Result): Result;
    public abstract getSlate(id: SlateId): Slate | undefined;
    public abstract listSlates(workspaceId?: WorkspaceId): readonly Slate[];
    public abstract getSlateRevision(id: SlateId, revision: Revision): Slate | undefined;
    public abstract listSlateHistory(id: SlateId): readonly Slate[];
    public abstract compareAndSetSlate(expected: Revision | undefined, next: Slate): boolean;
    public abstract addVersion(version: SlateVersion): void;
    public abstract getVersion(id: import("./id").SlateVersionId): SlateVersion | undefined;
    public abstract listVersions(slateId: SlateId): readonly SlateVersion[];
    public abstract addPublication(publication: SlatePublication): void;
    public abstract getPublication(id: SlatePublicationId): SlatePublication | undefined;
    public abstract listPublications(slateId: SlateId): readonly SlatePublication[];
    public abstract addDeployment(deployment: SlateDeployment): void;
    public abstract getDeployment(id: SlateDeploymentId): SlateDeployment | undefined;
    public abstract listDeployments(slateId: SlateId): readonly SlateDeployment[];
    public abstract addResource(resource: SlateResource): void;
    public abstract getResource(id: SlateResourceId): SlateResource | undefined;
    public abstract listResources(deploymentId: SlateDeploymentId): readonly SlateResource[];
    public abstract addPreview(preview: SlatePreview): void;
    public abstract getPreview(id: import("./id").SlatePreviewId): SlatePreview | undefined;
    public abstract listPreviews(slateId: SlateId): readonly SlatePreview[];
    public abstract reserveDeployment(reservation: SlateDeploymentReservation): void;
    public abstract getDeploymentReservation(
        id: SlateDeploymentId
    ): SlateDeploymentReservation | undefined;
    public abstract findDeploymentReservationByExternalKey(
        externalKey: string
    ): SlateDeploymentReservation | undefined;
    public abstract reserveResource(reservation: SlateResourceReservation): void;
    public abstract getResourceReservation(
        id: SlateResourceId
    ): SlateResourceReservation | undefined;
}

export class MemorySlateStore extends SlateStore {
    readonly #slates = new Map<string, StoredSlate>();
    readonly #latest = new Map<string, number>();
    readonly #versions = new Map<string, StoredSlateRecord>();
    readonly #publications = new Map<string, StoredSlateRecord>();
    readonly #deployments = new Map<string, StoredSlateRecord>();
    readonly #resources = new Map<string, StoredSlateRecord>();
    readonly #previews = new Map<string, StoredSlateRecord>();
    readonly #deploymentReservations = new Map<string, StoredSlateReservation>();
    readonly #resourceReservations = new Map<string, StoredSlateReservation>();

    public constructor(snapshot: MemorySlateSnapshot = EMPTY_SNAPSHOT) {
        super();
        this.installSlateRows(snapshot.slates);
        installRows(this.#versions, snapshot.versions, "Slate versions");
        installRows(this.#publications, snapshot.publications, "Slate publications");
        installRows(this.#deployments, snapshot.deployments, "Slate deployments");
        installRows(this.#resources, snapshot.resources, "Slate resources");
        installRows(this.#previews, snapshot.previews, "Slate previews");
        installRows(
            this.#deploymentReservations,
            snapshot.deploymentReservations,
            "Slate deployment reservations"
        );
        installRows(
            this.#resourceReservations,
            snapshot.resourceReservations,
            "Slate resource reservations"
        );
        this.verifyAll();
    }

    public transaction<Result>(operation: (store: SlateStore) => Result): Result {
        const draft = new MemorySlateStore(this.snapshot());
        const result = requireSynchronousResult(operation(draft));
        this.restore(draft.snapshot());
        return result;
    }

    public getSlate(id: SlateId): Slate | undefined {
        const latest = this.#latest.get(id.value);
        return latest === undefined ? undefined : this.getSlateRevision(id, new Revision(latest));
    }

    public listSlates(workspaceId_?: WorkspaceId): readonly Slate[] {
        return Object.freeze(
            [...this.#latest.keys()]
                .sort((left, right) => left.localeCompare(right))
                .map((id) => this.getSlate(new SlateId(id))!)
                .filter(
                    (slate) => workspaceId_ === undefined || slate.workspaceId.equals(workspaceId_)
                )
        );
    }

    public getSlateRevision(id: SlateId, revision_: Revision): Slate | undefined {
        const row = this.#slates.get(slateRevisionKey(id.value, revision_.value));
        if (row === undefined) return undefined;
        const slate = Slate.decode(copyBytes(row.bytes));
        verifySlateProjection(row, slate);
        return slate;
    }

    public listSlateHistory(id: SlateId): readonly Slate[] {
        return Object.freeze(
            [...this.#slates.values()]
                .filter((row) => row.id === id.value)
                .sort((left, right) => left.revision - right.revision)
                .map((row) => {
                    const slate = Slate.decode(copyBytes(row.bytes));
                    verifySlateProjection(row, slate);
                    return slate;
                })
        );
    }

    public compareAndSetSlate(expected: Revision | undefined, next: Slate): boolean {
        const current = this.getSlate(next.id);
        if (expected === undefined) {
            if (current !== undefined) return false;
            if (next.revision.value !== 0) {
                throw invalidState("A new Slate must start at revision zero");
            }
        } else {
            if (current === undefined || !current.revision.equals(expected)) return false;
            if (
                expected.value === Number.MAX_SAFE_INTEGER ||
                next.revision.value !== expected.value + 1
            ) {
                throw invalidState("A Slate CAS must append the next revision");
            }
            if (!next.workspaceId.equals(current.workspaceId)) {
                throw invalidState("Slate workspace ownership is immutable");
            }
            if (!sameFork(current.forkedFrom, next.forkedFrom)) {
                throw invalidState("Slate fork origin is immutable");
            }
        }
        this.verifySlateClosure(next);
        const bytes = Slate.encode(next);
        const canonical = Slate.decode(bytes);
        const row = projectSlate(canonical, bytes);
        const key = slateRevisionKey(row.id, row.revision);
        const existing = this.#slates.get(key);
        if (existing !== undefined) requireSameBytes(existing.bytes, row.bytes, `Slate ${key}`);
        else this.#slates.set(key, copySlateRow(row));
        this.#latest.set(row.id, row.revision);
        return true;
    }

    public addVersion(version: SlateVersion): void {
        this.requireOwned(version.workspaceId, version.slateId);
        if (version.parentVersionId !== undefined) {
            const parent = this.getVersion(version.parentVersionId);
            if (
                parent === undefined ||
                !parent.slateId.equals(version.slateId) ||
                !parent.workspaceId.equals(version.workspaceId)
            ) {
                throw invalidVersion("Slate version parent must exist in the same Slate");
            }
        }
        putRecord(this.#versions, version.id.value, version, SlateVersion.codec);
    }

    public getVersion(id: import("./id").SlateVersionId): SlateVersion | undefined {
        return getRecord(this.#versions, id.value, SlateVersion.codec);
    }

    public listVersions(slateId_: SlateId): readonly SlateVersion[] {
        return listRecords(this.#versions, SlateVersion.codec).filter((version) =>
            version.slateId.equals(slateId_)
        );
    }

    public addPublication(publication: SlatePublication): void {
        this.requireOwned(publication.workspaceId, publication.slateId);
        const version = this.getVersion(publication.versionId);
        if (version === undefined || !version.slateId.equals(publication.slateId)) {
            throw invalidVersion("Slate publication version must exist in the same Slate");
        }
        putRecord(this.#publications, publication.id.value, publication, SlatePublication.codec);
    }

    public getPublication(id: SlatePublicationId): SlatePublication | undefined {
        return getRecord(this.#publications, id.value, SlatePublication.codec);
    }

    public listPublications(slateId_: SlateId): readonly SlatePublication[] {
        return listRecords(this.#publications, SlatePublication.codec).filter((publication) =>
            publication.slateId.equals(slateId_)
        );
    }

    public addDeployment(deployment: SlateDeployment): void {
        this.requireOwned(deployment.workspaceId, deployment.slateId);
        const reservation = this.getDeploymentReservation(deployment.id);
        if (reservation === undefined || !sameDeploymentReservation(reservation, deployment)) {
            throw invalidState("Slate deployment must match its frozen reservation");
        }
        putRecord(this.#deployments, deployment.id.value, deployment, SlateDeployment.codec);
    }

    public getDeployment(id: SlateDeploymentId): SlateDeployment | undefined {
        return getRecord(this.#deployments, id.value, SlateDeployment.codec);
    }

    public listDeployments(slateId_: SlateId): readonly SlateDeployment[] {
        return listRecords(this.#deployments, SlateDeployment.codec).filter((deployment) =>
            deployment.slateId.equals(slateId_)
        );
    }

    public addResource(resource: SlateResource): void {
        this.requireOwned(resource.workspaceId, resource.slateId);
        const reservation = this.getResourceReservation(resource.id);
        if (reservation === undefined || !sameResourceReservation(reservation, resource)) {
            throw invalidState("Slate resource must match its frozen reservation");
        }
        if (this.getDeployment(resource.deploymentId) === undefined) {
            throw invalidState("Slate resource deployment must exist");
        }
        putRecord(this.#resources, resource.id.value, resource, SlateResource.codec);
    }

    public getResource(id: SlateResourceId): SlateResource | undefined {
        return getRecord(this.#resources, id.value, SlateResource.codec);
    }

    public listResources(deploymentId_: SlateDeploymentId): readonly SlateResource[] {
        return listRecords(this.#resources, SlateResource.codec).filter((resource) =>
            resource.deploymentId.equals(deploymentId_)
        );
    }

    public addPreview(preview: SlatePreview): void {
        const slate = this.requireOwned(preview.workspaceId, preview.slateId);
        if (preview.versionId === undefined) {
            if (!preview.source.equals(slate.source)) {
                throw new AgentCoreError(
                    "protocol.revision-conflict",
                    "Working Slate preview source must match the current source"
                );
            }
        } else {
            const version = this.getVersion(preview.versionId);
            if (
                version === undefined ||
                !version.slateId.equals(preview.slateId) ||
                !version.source.equals(preview.source)
            ) {
                throw invalidVersion("Versioned Slate preview must reference its exact source");
            }
        }
        putRecord(this.#previews, preview.id.value, preview, SlatePreview.codec);
    }

    public getPreview(id: import("./id").SlatePreviewId): SlatePreview | undefined {
        return getRecord(this.#previews, id.value, SlatePreview.codec);
    }

    public listPreviews(slateId_: SlateId): readonly SlatePreview[] {
        return listRecords(this.#previews, SlatePreview.codec).filter((preview) =>
            preview.slateId.equals(slateId_)
        );
    }

    public reserveDeployment(reservation: SlateDeploymentReservation): void {
        this.requireOwned(reservation.workspaceId, reservation.slateId);
        const publication = this.getPublication(reservation.publicationId);
        if (
            publication === undefined ||
            !publication.slateId.equals(reservation.slateId) ||
            !publication.materialization.equals(reservation.publicationMaterialization)
        ) {
            throw new AgentCoreError(
                "slate.unpublished",
                "Slate deployment publication must exist in the same Slate"
            );
        }
        putReservation(
            this.#deploymentReservations,
            reservation.id.value,
            reservation,
            SlateDeploymentReservation.codec
        );
    }

    public getDeploymentReservation(id: SlateDeploymentId): SlateDeploymentReservation | undefined {
        return getRecord(this.#deploymentReservations, id.value, SlateDeploymentReservation.codec);
    }

    public findDeploymentReservationByExternalKey(
        externalKey: string
    ): SlateDeploymentReservation | undefined {
        for (const key of this.#deploymentReservations.keys()) {
            const reservation = getRecord(
                this.#deploymentReservations,
                key,
                SlateDeploymentReservation.codec
            );
            if (reservation?.externalKey === externalKey) return reservation;
        }
        return undefined;
    }

    public reserveResource(reservation: SlateResourceReservation): void {
        this.requireOwned(reservation.workspaceId, reservation.slateId);
        const deployment = this.getDeployment(reservation.deploymentId);
        if (
            deployment === undefined ||
            !deployment.slateId.equals(reservation.slateId) ||
            !deployment.materialization.equals(reservation.deploymentMaterialization)
        ) {
            throw invalidState("Slate resource deployment must exist in the same Slate");
        }
        putReservation(
            this.#resourceReservations,
            reservation.id.value,
            reservation,
            SlateResourceReservation.codec
        );
    }

    public getResourceReservation(id: SlateResourceId): SlateResourceReservation | undefined {
        return getRecord(this.#resourceReservations, id.value, SlateResourceReservation.codec);
    }

    public snapshot(): MemorySlateSnapshot {
        return Object.freeze({
            slates: frozenRows(this.#slates.values(), copySlateRow),
            versions: frozenRows(this.#versions.values(), copyRecordRow),
            publications: frozenRows(this.#publications.values(), copyRecordRow),
            deployments: frozenRows(this.#deployments.values(), copyRecordRow),
            resources: frozenRows(this.#resources.values(), copyRecordRow),
            previews: frozenRows(this.#previews.values(), copyRecordRow),
            deploymentReservations: frozenRows(
                this.#deploymentReservations.values(),
                copyReservationRow
            ),
            resourceReservations: frozenRows(
                this.#resourceReservations.values(),
                copyReservationRow
            )
        });
    }

    public clone(): MemorySlateStore {
        return new MemorySlateStore(this.snapshot());
    }

    private restore(snapshot: MemorySlateSnapshot): void {
        this.#slates.clear();
        this.#latest.clear();
        this.#versions.clear();
        this.#publications.clear();
        this.#deployments.clear();
        this.#resources.clear();
        this.#previews.clear();
        this.#deploymentReservations.clear();
        this.#resourceReservations.clear();
        this.installSlateRows(snapshot.slates);
        installRows(this.#versions, snapshot.versions, "Slate versions");
        installRows(this.#publications, snapshot.publications, "Slate publications");
        installRows(this.#deployments, snapshot.deployments, "Slate deployments");
        installRows(this.#resources, snapshot.resources, "Slate resources");
        installRows(this.#previews, snapshot.previews, "Slate previews");
        installRows(
            this.#deploymentReservations,
            snapshot.deploymentReservations,
            "Slate deployment reservations"
        );
        installRows(
            this.#resourceReservations,
            snapshot.resourceReservations,
            "Slate resource reservations"
        );
        this.verifyAll();
    }

    private requireOwned(workspaceId_: WorkspaceId, slateId_: SlateId): Slate {
        const slate = this.getSlate(slateId_);
        if (slate === undefined || !slate.workspaceId.equals(workspaceId_)) {
            throw invalidState("Slate record must be owned by its Slate workspace");
        }
        return slate;
    }

    private verifySlateClosure(slate: Slate): void {
        if (slate.forkedFrom !== undefined) {
            const source = this.getVersion(slate.forkedFrom.versionId);
            if (
                source === undefined ||
                !source.slateId.equals(slate.forkedFrom.slateId) ||
                !source.workspaceId.equals(slate.workspaceId) ||
                !source.source.equals(slate.source)
            ) {
                throw invalidVersion("Slate fork must reference an existing exact source version");
            }
        }
        if (slate.headVersionId !== undefined) {
            const head = this.getVersion(slate.headVersionId);
            if (
                head === undefined ||
                !head.slateId.equals(slate.id) ||
                !head.workspaceId.equals(slate.workspaceId)
            ) {
                throw invalidVersion("Slate head must reference an owned version");
            }
        }
        if (slate.activeDeploymentId !== undefined) {
            const deployment = this.getDeployment(slate.activeDeploymentId);
            if (
                deployment === undefined ||
                !deployment.slateId.equals(slate.id) ||
                !deployment.workspaceId.equals(slate.workspaceId)
            ) {
                throw invalidState("Slate active deployment must be a successful owned deployment");
            }
        }
        if (slate.latestPublicationId !== undefined) {
            const publication = this.getPublication(slate.latestPublicationId);
            if (
                publication === undefined ||
                !publication.slateId.equals(slate.id) ||
                !publication.workspaceId.equals(slate.workspaceId)
            ) {
                throw new AgentCoreError(
                    "slate.unpublished",
                    "Slate latest publication must be an owned publication"
                );
            }
        }
    }

    private installSlateRows(rows: readonly StoredSlate[]): void {
        for (const source of rows) {
            const row = copySlateRow(source);
            const key = slateRevisionKey(row.id, row.revision);
            if (this.#slates.has(key)) throw duplicate("Slate snapshot contains duplicate history");
            this.#slates.set(key, row);
            const latest = this.#latest.get(row.id);
            if (latest === undefined || row.revision > latest)
                this.#latest.set(row.id, row.revision);
        }
    }

    private verifyAll(): void {
        for (const row of this.#slates.values())
            verifySlateProjection(row, Slate.decode(row.bytes));
        verifyRecordRows(this.#versions, SlateVersion.codec);
        verifyRecordRows(this.#publications, SlatePublication.codec);
        verifyRecordRows(this.#deployments, SlateDeployment.codec);
        verifyRecordRows(this.#resources, SlateResource.codec);
        verifyRecordRows(this.#previews, SlatePreview.codec);
        verifyReservationRows(this.#deploymentReservations, SlateDeploymentReservation.codec);
        verifyReservationRows(this.#resourceReservations, SlateResourceReservation.codec);
        for (const [id, latest] of this.#latest) {
            const history = this.listSlateHistory(new SlateId(id));
            if (
                history.length === 0 ||
                history[0]!.revision.value !== 0 ||
                history.at(-1)!.revision.value !== latest ||
                history.some((slate, index) => slate.revision.value !== index)
            ) {
                throw corrupt("Slate history is not a contiguous immutable replay");
            }
        }
        for (const id of this.#latest.keys()) {
            const history = this.listSlateHistory(new SlateId(id));
            for (const [index, slate] of history.entries()) {
                this.verifySlateClosure(slate);
                if (index > 0) verifySlateTransition(history[index - 1]!, slate);
            }
        }
        for (const version of listRecords(this.#versions, SlateVersion.codec)) {
            this.requireOwned(version.workspaceId, version.slateId);
            if (
                version.parentVersionId !== undefined &&
                this.getVersion(version.parentVersionId) === undefined
            ) {
                throw corrupt("Slate version has a dangling parent");
            }
        }
        for (const publication of listRecords(this.#publications, SlatePublication.codec)) {
            this.requireOwned(publication.workspaceId, publication.slateId);
            const version = this.getVersion(publication.versionId);
            if (
                version === undefined ||
                !version.slateId.equals(publication.slateId) ||
                !version.workspaceId.equals(publication.workspaceId)
            ) {
                throw corrupt("Slate publication has a dangling version");
            }
        }
        for (const reservation of [...this.#deploymentReservations.keys()].map((id) =>
            this.getDeploymentReservation(new SlateDeploymentId(id))!
        )) {
            this.requireOwned(reservation.workspaceId, reservation.slateId);
            const publication = this.getPublication(reservation.publicationId);
            if (
                publication === undefined ||
                !publication.slateId.equals(reservation.slateId) ||
                !publication.materialization.equals(reservation.publicationMaterialization)
            ) {
                throw corrupt("Slate deployment reservation has a dangling publication");
            }
        }
        for (const deployment of listRecords(this.#deployments, SlateDeployment.codec)) {
            this.requireOwned(deployment.workspaceId, deployment.slateId);
            const reservation = this.getDeploymentReservation(deployment.id);
            if (reservation === undefined || !sameDeploymentReservation(reservation, deployment)) {
                throw corrupt("Slate deployment does not match its reservation");
            }
        }
        for (const resource of listRecords(this.#resources, SlateResource.codec)) {
            this.requireOwned(resource.workspaceId, resource.slateId);
            const reservation = this.getResourceReservation(resource.id);
            if (reservation === undefined || !sameResourceReservation(reservation, resource)) {
                throw corrupt("Slate resource does not match its reservation");
            }
            if (this.getDeployment(resource.deploymentId) === undefined) {
                throw corrupt("Slate resource has a dangling deployment");
            }
        }
        for (const reservation of [...this.#resourceReservations.keys()].map((id) =>
            this.getResourceReservation(new SlateResourceId(id))!
        )) {
            this.requireOwned(reservation.workspaceId, reservation.slateId);
            const deployment = this.getDeployment(reservation.deploymentId);
            if (
                deployment === undefined ||
                !deployment.materialization.equals(reservation.deploymentMaterialization)
            ) {
                throw corrupt("Slate resource reservation has a dangling deployment");
            }
        }
        for (const preview of listRecords(this.#previews, SlatePreview.codec)) {
            this.requireOwned(preview.workspaceId, preview.slateId);
            const version =
                preview.versionId === undefined ? undefined : this.getVersion(preview.versionId);
            if (
                preview.versionId !== undefined &&
                (version === undefined ||
                    !version.slateId.equals(preview.slateId) ||
                    !version.source.equals(preview.source))
            ) {
                throw corrupt("Slate preview has a dangling or inexact source reference");
            }
        }
    }
}

function verifySlateTransition(previous: Slate, next: Slate): void {
    if (
        !previous.id.equals(next.id) ||
        !previous.workspaceId.equals(next.workspaceId) ||
        !sameFork(previous.forkedFrom, next.forkedFrom)
    ) {
        throw corrupt("Slate identity, workspace ownership, and fork origin are immutable");
    }
}

function sameFork(left: Slate["forkedFrom"], right: Slate["forkedFrom"]): boolean {
    return left === undefined
        ? right === undefined
        : right !== undefined &&
              left.slateId.equals(right.slateId) &&
              left.versionId.equals(right.versionId);
}

function projectSlate(slate: Slate, bytes: Uint8Array): StoredSlate {
    return {
        id: slate.id.value,
        workspaceId: slate.workspaceId,
        revision: slate.revision.value,
        bytes: copyBytes(bytes)
    };
}

function verifySlateProjection(row: StoredSlate, slate: Slate): void {
    if (
        row.id !== slate.id.value ||
        !(row.workspaceId instanceof WorkspaceId) ||
        !row.workspaceId.equals(slate.workspaceId) ||
        row.revision !== slate.revision.value
    ) {
        throw corrupt("Stored Slate projection does not match its codec bytes");
    }
}

function putRecord<
    Record extends {
        readonly id: { readonly value: string };
        readonly workspaceId: WorkspaceId;
        readonly slateId: SlateId;
    }
>(
    rows: Map<string, StoredSlateRecord>,
    key: string,
    record: Record,
    codec: RecordCodec<Record>
): void {
    const bytes = codec.encode(record);
    const canonical = codec.decode(bytes);
    const row: StoredSlateRecord = {
        id: canonical.id.value,
        workspaceId: canonical.workspaceId,
        slateId: canonical.slateId,
        bytes: copyBytes(bytes)
    };
    const existing = rows.get(key);
    if (existing !== undefined) {
        requireSameBytes(existing.bytes, row.bytes, `Slate record ${key}`);
        return;
    }
    rows.set(key, copyRecordRow(row));
}

function putReservation<
    Record extends {
        readonly id: { readonly value: string };
        readonly workspaceId: WorkspaceId;
        readonly slateId: SlateId;
        readonly invocationId: InvocationId;
    }
>(
    rows: Map<string, StoredSlateReservation>,
    key: string,
    record: Record,
    codec: RecordCodec<Record>
): void {
    const bytes = codec.encode(record);
    const canonical = codec.decode(bytes);
    const row: StoredSlateReservation = {
        id: canonical.id.value,
        workspaceId: canonical.workspaceId,
        slateId: canonical.slateId,
        invocationId: canonical.invocationId,
        bytes: copyBytes(bytes)
    };
    const existing = rows.get(key);
    if (existing !== undefined) {
        requireSameBytes(existing.bytes, row.bytes, `Slate reservation ${key}`);
        return;
    }
    rows.set(key, copyReservationRow(row));
}

function getRecord<Record>(
    rows: Map<string, StoredSlateRecord> | Map<string, StoredSlateReservation>,
    key: string,
    codec: RecordCodec<Record>
): Record | undefined {
    const row = rows.get(key);
    if (row === undefined) return undefined;
    const record = codec.decode(copyBytes(row.bytes));
    verifyCommonProjection(row, record);
    return record;
}

function listRecords<Record>(
    rows: Map<string, StoredSlateRecord>,
    codec: RecordCodec<Record>
): readonly Record[] {
    return Object.freeze(
        [...rows.values()]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((row) => {
                const record = codec.decode(copyBytes(row.bytes));
                verifyCommonProjection(row, record);
                return record;
            })
    );
}

function verifyRecordRows<Record>(
    rows: Map<string, StoredSlateRecord>,
    codec: RecordCodec<Record>
): void {
    for (const [key, row] of rows) {
        if (key !== row.id) throw corrupt("Stored Slate record key does not match its projection");
        verifyCommonProjection(row, codec.decode(row.bytes));
    }
}

function verifyReservationRows<Record>(
    rows: Map<string, StoredSlateReservation>,
    codec: RecordCodec<Record>
): void {
    for (const [key, row] of rows) {
        if (key !== row.id)
            throw corrupt("Stored Slate reservation key does not match its projection");
        const record = codec.decode(row.bytes);
        verifyCommonProjection(row, record);
        const projected = record as { readonly invocationId?: { readonly value: string } };
        if (
            !(row.invocationId instanceof InvocationId) ||
            projected.invocationId?.value !== row.invocationId.value
        ) {
            throw corrupt("Stored Slate reservation invocation does not match its codec bytes");
        }
    }
}

function verifyCommonProjection(row: StoredSlateRecord, record: unknown): void {
    const projected = record as {
        readonly id?: { readonly value: string };
        readonly workspaceId?: { readonly value: string };
        readonly slateId?: { readonly value: string };
    };
    if (
        !(row.workspaceId instanceof WorkspaceId) ||
        !(row.slateId instanceof SlateId) ||
        projected.id?.value !== row.id ||
        projected.workspaceId?.value !== row.workspaceId.value ||
        projected.slateId?.value !== row.slateId.value
    ) {
        throw corrupt("Stored Slate projection does not match its codec bytes");
    }
}

function sameDeploymentReservation(
    reservation: SlateDeploymentReservation,
    deployment: SlateDeployment
): boolean {
    return (
        reservation.id.equals(deployment.id) &&
        reservation.workspaceId.equals(deployment.workspaceId) &&
        reservation.slateId.equals(deployment.slateId) &&
        reservation.publicationId.equals(deployment.publicationId) &&
        reservation.target === deployment.target &&
        reservation.invocationId.equals(deployment.invocationId)
    );
}

function sameResourceReservation(
    reservation: SlateResourceReservation,
    resource: SlateResource
): boolean {
    return (
        reservation.id.equals(resource.id) &&
        reservation.workspaceId.equals(resource.workspaceId) &&
        reservation.slateId.equals(resource.slateId) &&
        reservation.deploymentId.equals(resource.deploymentId) &&
        reservation.name === resource.name &&
        reservation.source.equals(resource.source) &&
        reservation.invocationId.equals(resource.invocationId)
    );
}

function installRows<Row extends StoredSlateRecord>(
    target: Map<string, Row>,
    rows: readonly Row[],
    subject: string
): void {
    for (const source of rows) {
        if (target.has(source.id)) throw duplicate(`${subject} snapshot contains duplicate IDs`);
        target.set(source.id, copyAnyRow(source));
    }
}

function copyAnyRow<Row extends StoredSlateRecord>(row: Row): Row {
    return { ...row, bytes: copyBytes(row.bytes) };
}

function frozenRows<Row extends StoredSlateRecord | StoredSlate>(
    rows: Iterable<Row>,
    copy: (row: Row) => Row
): readonly Row[] {
    return Object.freeze(
        [...rows]
            .sort(
                (left, right) =>
                    left.id.localeCompare(right.id) ||
                    ("revision" in left && "revision" in right ? left.revision - right.revision : 0)
            )
            .map((row) => Object.freeze(copy(row)))
    );
}

function copySlateRow(row: StoredSlate): StoredSlate {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        revision: row.revision,
        bytes: copyBytes(row.bytes)
    };
}

function copyRecordRow(row: StoredSlateRecord): StoredSlateRecord {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        slateId: row.slateId,
        bytes: copyBytes(row.bytes)
    };
}

function copyReservationRow(row: StoredSlateReservation): StoredSlateReservation {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        slateId: row.slateId,
        invocationId: row.invocationId,
        bytes: copyBytes(row.bytes)
    };
}

function copyBytes(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(bytes);
}

function requireSameBytes(left: Uint8Array, right: Uint8Array, subject: string): void {
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
        throw duplicate(`${subject} is immutable`);
    }
}

function slateRevisionKey(id: string, revision_: number): string {
    return `${id}\u0000${revision_}`;
}

function corrupt(message: string): AgentCoreError {
    return invalidState(message);
}

function invalidState(message: string): AgentCoreError {
    return new AgentCoreError("protocol.invalid-state", message);
}

function invalidVersion(message: string): AgentCoreError {
    return new AgentCoreError("slate.invalid-version", message);
}

function duplicate(message: string): AgentCoreError {
    return new AgentCoreError("protocol.duplicate", message);
}
