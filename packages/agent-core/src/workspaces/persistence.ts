import { AgentCoreError } from "../errors";
import type { ActorRef } from "../actors";
import type { AuditRecordId } from "../interaction-references";
import {
    CatalogEntry,
    IngressDeclaration,
    PromptSection,
    SettingsLayer,
    SurfaceRegistration,
    type CatalogEntryId,
    type ContributionAttribution,
    type PromptSectionId,
    type SettingsLayerId,
    type SurfaceId
} from "../facets";
import { consumeAuthenticatedContribution, type AuthenticatedContribution } from "../definition";
import {
    ContentRef,
    Digest,
    JsonSchema,
    decodeCanonicalJson,
    canonicalTupleKey,
    Revision,
    type JsonValue,
    compareCanonicalText,
    isJsonObject,
    isMember,
    jsonDataParser
} from "../core";
import type { TenantId } from "../identity";
import type {
    EventId,
    RouteProjectionId,
    RouteReservationId,
    SubscriptionId
} from "../interaction-references";
import { Event } from "./event";
import {
    ContentRetentionReference,
    RetainedRecordKind,
    type ContentRetentionPort
} from "./retention";
import { IngressEndpoint, type IngressEndpointMaterializationInit } from "./ingress-endpoint";
import type { IngressEndpointId } from "./id";
import {
    AuthenticatedRouteProjection,
    RouteDelivery,
    RouteDeliveryState,
    RouteProjection,
    RouteReservation,
    requireAuthenticatedRouteProjection
} from "./route";
import { Subscription, type SubscriptionInit } from "./subscription";
import { View, ViewDelta, type JsonPatchEngine, viewDocument, viewFromDocument } from "./view";

export const WORKSPACE_RECORD_KINDS = Object.freeze([
    "catalogEntry",
    "contentRetention",
    "event",
    "ingressEndpoint",
    "promptSection",
    "routeDelivery",
    "routeProjection",
    "routeReservation",
    "settingsLayer",
    "subscription",
    "surfaceRegistration",
    "view",
    "viewDelta"
] as const);
export type WorkspaceRecordKind = (typeof WORKSPACE_RECORD_KINDS)[number];

export const DELETABLE_WORKSPACE_RECORD_KINDS = Object.freeze([
    "contentRetention",
    "view",
    "viewDelta"
] as const);
export type DeletableWorkspaceRecordKind = (typeof DELETABLE_WORKSPACE_RECORD_KINDS)[number];

type WorkspaceDurableRecord =
    | CatalogEntry
    | ContentRetentionReference
    | Event
    | IngressEndpoint
    | PromptSection
    | RouteDelivery
    | RouteProjection
    | RouteReservation
    | SettingsLayer
    | Subscription
    | SurfaceRegistration
    | View
    | ViewDelta;

/**
 * A trusted materializer supplies route behavior. The store derives the initial revision,
 * authenticated contribution attribution, and live state itself.
 */
export type SubscriptionMaterializationInit = Omit<
    SubscriptionInit,
    "contribution" | "retired" | "revision"
>;

export interface StoredWorkspaceRecord {
    readonly kind: WorkspaceRecordKind;
    readonly id: string;
    readonly bytes: Uint8Array;
}

export interface StoredWorkspaceUnique {
    readonly namespace: string;
    readonly key: string;
    readonly recordKey: string;
}

export interface StoredWorkspacePointer {
    readonly namespace: string;
    readonly key: string;
    readonly recordKey: string;
}

export interface WorkspaceRecordStorage {
    findRecord(kind: WorkspaceRecordKind, id: string): StoredWorkspaceRecord | undefined;
    listRecords(kind: WorkspaceRecordKind): readonly StoredWorkspaceRecord[];
    insertRecord(record: StoredWorkspaceRecord): void;
    deleteRecords(kind: DeletableWorkspaceRecordKind, ids: readonly string[]): void;
    findUnique(namespace: string, key: string): StoredWorkspaceUnique | undefined;
    insertUnique(unique: StoredWorkspaceUnique): void;
    findPointer(namespace: string, key: string): StoredWorkspacePointer | undefined;
    compareAndSetPointer(
        pointer: StoredWorkspacePointer,
        expectedRecordKey: string | undefined
    ): void;
    deletePointer(namespace: string, key: string, expectedRecordKey: string): void;
}

export class WorkspacePersistence<Transaction> {
    public constructor(
        private readonly storage: (transaction: Transaction) => WorkspaceRecordStorage,
        private readonly retention: ContentRetentionPort<Transaction>,
        private readonly actor: ActorRef,
        private readonly tenant: TenantId
    ) {}

    public findCatalogEntry(
        transaction: Transaction,
        id: CatalogEntryId
    ): CatalogEntry | undefined {
        return this.load(transaction, "catalogEntry", id.value, CatalogEntry.codec);
    }

    public catalogEntryAt(
        transaction: Transaction,
        origin: CatalogEntry["origin"]
    ): CatalogEntry | undefined {
        return this.currentRecord(
            transaction,
            "catalogEntry",
            "catalog.current",
            origin.key,
            CatalogEntry.codec
        );
    }

    public listCatalogEntries(transaction: Transaction): readonly CatalogEntry[] {
        return this.listCurrentRecords(
            transaction,
            "catalogEntry",
            "catalog.current",
            (entry) => entry.origin.key,
            CatalogEntry.codec,
            (left, right) => compareCanonicalText(left.id.value, right.id.value)
        );
    }

    public listContributedCatalogEntries(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): readonly CatalogEntry[] {
        return Object.freeze(
            this.listCatalogEntries(transaction).filter(
                (entry) => entry.attribution?.equals(attribution) === true
            )
        );
    }

    public putCatalogEntry(transaction: Transaction, entry: CatalogEntry): boolean {
        const current = this.catalogEntryAt(transaction, entry.origin);
        if (current !== undefined) {
            requireSameOptionalContributor(current.attribution, entry.attribution, "Catalog entry");
            if (sameBytes(CatalogEntry.encode(current), CatalogEntry.encode(entry))) return false;
        }
        this.appendOrVerify(
            this.storage(transaction),
            "catalogEntry",
            entry.id.value,
            entry,
            CatalogEntry.codec
        );
        this.storage(transaction).compareAndSetPointer(
            {
                namespace: "catalog.current",
                key: entry.origin.key,
                recordKey: entry.id.value
            },
            current?.id.value
        );
        return true;
    }

    public retireCatalogEntry(transaction: Transaction, id: CatalogEntryId): void {
        const entry = this.requireLoad(transaction, "catalogEntry", id.value, CatalogEntry.codec);
        this.storage(transaction).deletePointer("catalog.current", entry.origin.key, id.value);
    }

    public findPromptSection(
        transaction: Transaction,
        id: PromptSectionId
    ): PromptSection | undefined {
        return this.load(transaction, "promptSection", id.value, PromptSection.codec);
    }

    public promptSectionAt(
        transaction: Transaction,
        origin: PromptSection["origin"]
    ): PromptSection | undefined {
        return this.currentRecord(
            transaction,
            "promptSection",
            "prompt.current",
            origin.key,
            PromptSection.codec
        );
    }

    public listPromptSections(transaction: Transaction): readonly PromptSection[] {
        return this.listCurrentRecords(
            transaction,
            "promptSection",
            "prompt.current",
            (section) => section.origin.key,
            PromptSection.codec,
            PromptSection.compare
        );
    }

    public listContributedPromptSections(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): readonly PromptSection[] {
        return Object.freeze(
            this.listPromptSections(transaction).filter((section) =>
                section.attribution.equals(attribution)
            )
        );
    }

    public putPromptSection(transaction: Transaction, section: PromptSection): boolean {
        const current = this.promptSectionAt(transaction, section.origin);
        if (
            current !== undefined &&
            sameBytes(PromptSection.encode(current), PromptSection.encode(section))
        ) {
            return false;
        }
        this.appendOrVerify(
            this.storage(transaction),
            "promptSection",
            section.id.value,
            section,
            PromptSection.codec
        );
        this.storage(transaction).compareAndSetPointer(
            {
                namespace: "prompt.current",
                key: section.origin.key,
                recordKey: section.id.value
            },
            current?.id.value
        );
        return true;
    }

    public retirePromptSection(transaction: Transaction, id: PromptSectionId): void {
        const section = this.requireLoad(
            transaction,
            "promptSection",
            id.value,
            PromptSection.codec
        );
        this.storage(transaction).deletePointer("prompt.current", section.origin.key, id.value);
    }

    public assembledPromptSections(transaction: Transaction): readonly PromptSection[] {
        return this.listPromptSections(transaction);
    }

    public findSettingsLayer(
        transaction: Transaction,
        id: SettingsLayerId
    ): SettingsLayer | undefined {
        return this.load(transaction, "settingsLayer", id.value, SettingsLayer.codec);
    }

    public settingsLayerAt(
        transaction: Transaction,
        origin: SettingsLayer["origin"]
    ): SettingsLayer | undefined {
        return this.currentRecord(
            transaction,
            "settingsLayer",
            "settings.current",
            origin.key,
            SettingsLayer.codec
        );
    }

    public listSettingsLayers(transaction: Transaction): readonly SettingsLayer[] {
        return this.listCurrentRecords(
            transaction,
            "settingsLayer",
            "settings.current",
            (layer) => layer.origin.key,
            SettingsLayer.codec,
            compareSettingsLayers
        );
    }

    public listContributedSettingsLayers(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): readonly SettingsLayer[] {
        return Object.freeze(
            this.listSettingsLayers(transaction).filter((layer) =>
                layer.attribution.equals(attribution)
            )
        );
    }

    public putSettingsLayer(transaction: Transaction, layer: SettingsLayer): boolean {
        const current = this.settingsLayerAt(transaction, layer.origin);
        if (
            current !== undefined &&
            sameBytes(SettingsLayer.encode(current), SettingsLayer.encode(layer))
        ) {
            return false;
        }
        this.appendOrVerify(
            this.storage(transaction),
            "settingsLayer",
            layer.id.value,
            layer,
            SettingsLayer.codec
        );
        this.storage(transaction).compareAndSetPointer(
            {
                namespace: "settings.current",
                key: layer.origin.key,
                recordKey: layer.id.value
            },
            current?.id.value
        );
        return true;
    }

    public retireSettingsLayer(transaction: Transaction, id: SettingsLayerId): void {
        const layer = this.requireLoad(transaction, "settingsLayer", id.value, SettingsLayer.codec);
        this.storage(transaction).deletePointer("settings.current", layer.origin.key, id.value);
    }

    public composedSettingsSchema(transaction: Transaction, base: JsonSchema): JsonSchema {
        const groups = new Map<string, JsonValue[]>();
        for (const layer of this.listSettingsLayers(transaction)) {
            const group = layer.attribution.package.id.value;
            const fragments = groups.get(group);
            if (fragments === undefined) groups.set(group, [layer.schema.document]);
            else fragments.push(layer.schema.document);
        }
        const properties = Object.fromEntries(
            [...groups.entries()].map(([group, fragments]) => {
                const first = fragments[0];
                if (first === undefined) {
                    throw new AgentCoreError(
                        "protocol.invalid-state",
                        "Settings composition group is empty"
                    );
                }
                return [group, fragments.length === 1 ? first : { allOf: fragments }];
            })
        );
        return new JsonSchema({
            allOf: [
                base.document,
                {
                    additionalProperties: false,
                    properties,
                    required: [...groups.keys()],
                    type: "object"
                }
            ]
        });
    }

    public findSurfaceRegistration(
        transaction: Transaction,
        surface: SurfaceId
    ): SurfaceRegistration | undefined {
        return this.currentRecord(
            transaction,
            "surfaceRegistration",
            "surface.registration",
            surface.value,
            SurfaceRegistration.codec
        );
    }

    public listSurfaceRegistrations(transaction: Transaction): readonly SurfaceRegistration[] {
        return this.listCurrentRecords(
            transaction,
            "surfaceRegistration",
            "surface.registration",
            (registration) => registration.descriptor.id.value,
            SurfaceRegistration.codec,
            (left, right) =>
                compareCanonicalText(left.descriptor.id.value, right.descriptor.id.value)
        );
    }

    public listContributedSurfaceRegistrations(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): readonly SurfaceRegistration[] {
        return Object.freeze(
            this.listSurfaceRegistrations(transaction).filter((registration) =>
                registration.attribution.equals(attribution)
            )
        );
    }

    public putSurfaceRegistration(
        transaction: Transaction,
        registration: SurfaceRegistration
    ): boolean {
        const surface = registration.descriptor.id;
        const current = this.findSurfaceRegistration(transaction, surface);
        if (current !== undefined) {
            if (!current.attribution.contributor.equals(registration.attribution.contributor)) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    `Surface ${surface.value} is registered by ${current.attribution.contributor.value}`
                );
            }
            if (
                sameBytes(
                    SurfaceRegistration.encode(current),
                    SurfaceRegistration.encode(registration)
                )
            ) {
                return false;
            }
        }
        const recordKey = Digest.sha256(SurfaceRegistration.encode(registration)).value;
        this.appendOrVerify(
            this.storage(transaction),
            "surfaceRegistration",
            recordKey,
            registration,
            SurfaceRegistration.codec
        );
        this.storage(transaction).compareAndSetPointer(
            {
                namespace: "surface.registration",
                key: surface.value,
                recordKey
            },
            current === undefined
                ? undefined
                : Digest.sha256(SurfaceRegistration.encode(current)).value
        );
        return true;
    }

    public retireSurfaceRegistration(transaction: Transaction, surface: SurfaceId): void {
        const current = this.findSurfaceRegistration(transaction, surface);
        if (current === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Surface withdrawal requires a current registration"
            );
        }
        this.storage(transaction).deletePointer(
            "surface.registration",
            surface.value,
            Digest.sha256(SurfaceRegistration.encode(current)).value
        );
    }

    public currentIngressEndpoint(
        transaction: Transaction,
        id: IngressEndpointId
    ): IngressEndpoint | undefined {
        return this.currentRecord(
            transaction,
            "ingressEndpoint",
            "ingress.current",
            id.value,
            IngressEndpoint.codec
        );
    }

    public listIngressEndpoints(transaction: Transaction): readonly IngressEndpoint[] {
        return Object.freeze(
            this.listCurrentRecords(
                transaction,
                "ingressEndpoint",
                "ingress.current",
                (endpoint) => endpoint.id.value,
                IngressEndpoint.codec,
                (left, right) => compareCanonicalText(left.id.value, right.id.value)
            ).filter((endpoint) => endpoint.retired !== true)
        );
    }

    public listContributedIngressEndpoints(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): readonly IngressEndpoint[] {
        return Object.freeze(
            this.listIngressEndpoints(transaction).filter(
                (endpoint) => endpoint.contribution?.equals(attribution) === true
            )
        );
    }

    public createIngressEndpoint(transaction: Transaction, endpoint: IngressEndpoint): void {
        if (endpoint.contribution !== undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Ingress endpoint attribution requires authenticated contribution materialization"
            );
        }
        this.putNewIngressEndpoint(transaction, endpoint);
    }

    public materializeIngressEndpoint(
        transaction: Transaction,
        contribution: AuthenticatedContribution,
        init: IngressEndpointMaterializationInit
    ): IngressEndpoint {
        if ("contribution" in init || "retired" in init || "revision" in init) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Ingress endpoint materialization input must not supply record state"
            );
        }
        const attribution = consumeAuthenticatedContribution(contribution);
        if (attribution === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Ingress endpoint materialization requires authenticated contribution provenance"
            );
        }
        const endpoint = new IngressEndpoint({
            id: init.id,
            revision: Revision.initial(),
            scope: init.scope,
            declared: init.declared,
            contribution: attribution
        });
        this.putNewIngressEndpoint(transaction, endpoint);
        return endpoint;
    }

    public putManagedIngressEndpoint(transaction: Transaction, endpoint: IngressEndpoint): boolean {
        if (
            endpoint.contribution === undefined ||
            endpoint.revision.value !== 0 ||
            endpoint.retired !== undefined
        ) {
            throw new AgentCoreError(
                "authority.denied",
                "Managed Ingress endpoint requires attributed revision-zero state"
            );
        }
        const current = this.currentIngressEndpoint(transaction, endpoint.id);
        if (current === undefined) {
            this.putNewIngressEndpoint(transaction, endpoint);
            return true;
        }
        if (sameIngressDesired(current, endpoint)) return false;
        this.replaceIngressEndpoint(
            transaction,
            new IngressEndpoint({
                id: endpoint.id,
                revision: current.revision.next(),
                scope: endpoint.scope,
                declared: endpoint.declared,
                contribution: endpoint.contribution
            }),
            current
        );
        return true;
    }

    public replaceIngressEndpoint(
        transaction: Transaction,
        endpoint: IngressEndpoint,
        expected: IngressEndpoint
    ): void {
        const current = this.currentIngressEndpoint(transaction, endpoint.id);
        if (
            current === undefined ||
            !current.revision.equals(expected.revision) ||
            !expected.revision.next().equals(endpoint.revision)
        ) {
            throw revisionConflict("Ingress endpoint revision compare-and-set failed");
        }
        if (!sameContribution(current.contribution, endpoint.contribution)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Ingress endpoint contribution attribution is immutable"
            );
        }
        if (current.retired === true) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Retired Ingress endpoint accepts no further revision"
            );
        }
        this.requireOwnTenant(endpoint);
        if (endpoint.retired !== true) this.requireLiveIngressPathFree(transaction, endpoint);
        this.writeIngressEndpoint(transaction, endpoint, current);
    }

    public retireIngressEndpoint(transaction: Transaction, id: IngressEndpointId): void {
        const current = this.currentIngressEndpoint(transaction, id);
        if (current === undefined || current.retired === true) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Ingress endpoint withdrawal requires a live contributed record"
            );
        }
        this.replaceIngressEndpoint(transaction, current.retire(), current);
    }

    private putNewIngressEndpoint(transaction: Transaction, endpoint: IngressEndpoint): void {
        this.requireOwnTenant(endpoint);
        if (
            this.currentIngressEndpoint(transaction, endpoint.id) !== undefined ||
            endpoint.revision.value !== 0 ||
            endpoint.retired === true
        ) {
            throw revisionConflict(
                "New Ingress endpoint requires revision zero, live state, and no current record"
            );
        }
        this.requireLiveIngressPathFree(transaction, endpoint);
        this.writeIngressEndpoint(transaction, endpoint, undefined);
    }

    private writeIngressEndpoint(
        transaction: Transaction,
        endpoint: IngressEndpoint,
        current: IngressEndpoint | undefined
    ): void {
        const storage = this.storage(transaction);
        const recordKey = ingressEndpointRecordId(endpoint);
        this.appendOrVerify(storage, "ingressEndpoint", recordKey, endpoint, IngressEndpoint.codec);
        storage.compareAndSetPointer(
            {
                namespace: "ingress.current",
                key: endpoint.id.value,
                recordKey
            },
            current === undefined ? undefined : ingressEndpointRecordId(current)
        );
    }

    private requireOwnTenant(endpoint: IngressEndpoint): void {
        if (!endpoint.scope.tenantId.equals(this.tenant)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Ingress endpoint belongs to another Tenant"
            );
        }
    }

    private requireLiveIngressPathFree(transaction: Transaction, candidate: IngressEndpoint): void {
        const occupant = this.listIngressEndpoints(transaction).find(
            (endpoint) =>
                endpoint.declared.path === candidate.declared.path &&
                !endpoint.id.equals(candidate.id)
        );
        if (occupant !== undefined) {
            throw duplicate("A live Ingress endpoint already binds this path");
        }
    }

    public findEvent(transaction: Transaction, id: EventId): Event | undefined {
        const event = this.load(transaction, "event", id.value, Event.codec);
        if (event !== undefined) this.requireEventIndex(transaction, event);
        return event;
    }

    public findEventByIdentity(
        transaction: Transaction,
        idempotencyKey: string
    ): Event | undefined {
        const unique = this.storage(transaction).findUnique("event.idempotency", idempotencyKey);
        if (unique === undefined) return undefined;
        const event = this.requireLoad(transaction, "event", unique.recordKey, Event.codec);
        if (event.idempotencyKey !== idempotencyKey) {
            throw corrupt("Event idempotency index does not match its Event");
        }
        return event;
    }

    public appendEvent(
        transaction: Transaction,
        event: Event,
        retention: ContentRetentionReference
    ): void {
        requireRetention(
            retention,
            RetainedRecordKind.event(),
            event.id.value,
            event.payload.value
        );
        this.requireDurableRetention(transaction, retention);
        const storage = this.storage(transaction);
        if (storage.findUnique("event.idempotency", event.idempotencyKey) !== undefined) {
            throw duplicate("Event idempotency identity is already reserved");
        }
        this.append(
            storage,
            "contentRetention",
            retention.id.value,
            retention,
            ContentRetentionReference.codec
        );
        this.append(storage, "event", event.id.value, event, Event.codec);
        storage.insertUnique({
            namespace: "event.idempotency",
            key: event.idempotencyKey,
            recordKey: event.id.value
        });
    }

    public currentSubscription(
        transaction: Transaction,
        id: SubscriptionId
    ): Subscription | undefined {
        const pointer = this.storage(transaction).findPointer("subscription.current", id.value);
        if (pointer === undefined) return undefined;
        const subscription = this.requireLoad(
            transaction,
            "subscription",
            pointer.recordKey,
            Subscription.codec
        );
        if (!subscription.id.equals(id)) {
            throw corrupt("Subscription pointer does not match its Subscription");
        }
        return subscription;
    }

    public listSubscriptions(transaction: Transaction): readonly Subscription[] {
        const storage = this.storage(transaction);
        const subscriptions: Subscription[] = [];
        const seen = new Set<string>();
        for (const record of storage.listRecords("subscription")) {
            const subscription = this.decodeStored(
                record,
                "subscription",
                record.id,
                Subscription.codec
            );
            if (seen.has(subscription.id.value)) continue;
            const current = this.currentSubscription(transaction, subscription.id);
            // A retired Subscription (§4.1) resolves no further reservation, which is what
            // closes the §6.2 liveness gap at its source rather than at delivery.
            if (current !== undefined && current.retired !== true) {
                subscriptions.push(current);
                seen.add(current.id.value);
            }
        }
        return Object.freeze(
            subscriptions.sort((left, right) => compareCanonicalText(left.id.value, right.id.value))
        );
    }

    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the live Subscriptions the exact
     * `ContributionAttribution` — the FacetRef and PackagePin pair of §4.2 — materialized,
     * found by querying the whole attribution. A different release of the same Facet is a
     * different contribution, so its Subscriptions are outside this query's result.
     */
    public listContributedSubscriptions(
        transaction: Transaction,
        attribution: ContributionAttribution
    ): readonly Subscription[] {
        return Object.freeze(
            this.listSubscriptions(transaction).filter(
                (subscription) => subscription.contribution?.equals(attribution) === true
            )
        );
    }

    public retireSubscription(transaction: Transaction, subscription: Subscription): void {
        this.saveSubscription(transaction, subscription.retire(), subscription.revision);
    }

    /**
     * SPEC §4.1: the terminal rejected RouteDelivery the owning Actor writes for a
     * reservation appended against a Subscription the withdrawal retired and never admitted
     * by its target. Without it that reservation could never reach a terminal delivery,
     * because §6.2 gives it no other route to one.
     */
    public appendWithdrawalRejection(
        transaction: Transaction,
        reservation: RouteReservation,
        audit: AuditRecordId,
        reason: string
    ): RouteDelivery {
        const subscription = this.currentSubscription(transaction, reservation.subscription);
        if (subscription === undefined || subscription.retired !== true) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Withdrawal rejection requires a retired Subscription"
            );
        }
        if (this.findProjectionByReservation(transaction, reservation.id) !== undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Reservation reached preparation and drains as an Invocation item"
            );
        }
        const storage = this.storage(transaction);
        if (storage.findUnique("route.delivery", reservation.id.value) !== undefined) {
            throw duplicate("Route delivery is already terminal");
        }
        const delivery = new RouteDelivery({
            reservation: reservation.id,
            state: RouteDeliveryState.rejected(reason),
            targetAudit: audit
        });
        this.append(
            storage,
            "routeDelivery",
            delivery.reservation.value,
            delivery,
            RouteDelivery.codec
        );
        storage.insertUnique({
            namespace: "route.delivery",
            key: delivery.reservation.value,
            recordKey: delivery.reservation.value
        });
        return delivery;
    }

    /**
     * Writes a caller-created Subscription or a revision of an existing one. Attribution
     * never enters through initial generic creation: only materializeSubscription receives
     * the one-use capability that authenticated package installation provenance minted.
     */
    public saveSubscription(
        transaction: Transaction,
        subscription: Subscription,
        expectedRevision: Revision | undefined
    ): void {
        if (expectedRevision === undefined) {
            if (subscription.contribution !== undefined) {
                throw new AgentCoreError(
                    "authority.denied",
                    "Subscription attribution requires authenticated contribution materialization"
                );
            }
            this.createSubscription(transaction, subscription);
            return;
        }

        const current = this.currentSubscription(transaction, subscription.id);
        if (
            current === undefined ||
            !current.revision.equals(expectedRevision) ||
            !expectedRevision.next().equals(subscription.revision)
        ) {
            throw revisionConflict("Subscription revision compare-and-set failed");
        }
        // SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): attribution is written in the
        // same transaction as the record it attributes and is immutable for that record's
        // lifetime, so no later revision may add, drop, or rewrite it.
        if (!sameContribution(current.contribution, subscription.contribution)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Subscription contribution attribution is immutable"
            );
        }
        // A retired Subscription is terminal: §4.1 leaves it resolvable by no later route.
        if (current.retired === true) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Retired Subscription accepts no further revision"
            );
        }
        this.writeSubscription(transaction, subscription, current);
    }

    /**
     * The sole attributed creation seam. It consumes the capability during the synchronous
     * authenticated provenance callback and constructs the revision-zero record itself.
     */
    public materializeSubscription(
        transaction: Transaction,
        contribution: AuthenticatedContribution,
        init: SubscriptionMaterializationInit
    ): Subscription {
        if ("contribution" in init || "retired" in init || "revision" in init) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Subscription materialization input must not supply record state"
            );
        }
        const attribution = consumeAuthenticatedContribution(contribution);
        if (attribution === undefined) {
            throw new AgentCoreError(
                "authority.denied",
                "Subscription materialization requires authenticated contribution provenance"
            );
        }
        const subscription = new Subscription({
            id: init.id,
            revision: Revision.initial(),
            source: init.source,
            target: init.target,
            mapping: init.mapping,
            dedupe: init.dedupe,
            authority: init.authority,
            contribution: attribution
        });
        this.createSubscription(transaction, subscription);
        return subscription;
    }

    public putManagedSubscription(
        transaction: Transaction,
        attribution: ContributionAttribution,
        init: SubscriptionMaterializationInit
    ): Subscription {
        if ("contribution" in init || "retired" in init || "revision" in init) {
            throw new AgentCoreError(
                "operation.invalid-input",
                "Managed Subscription input must not supply record state"
            );
        }
        const current = this.currentSubscription(transaction, init.id);
        const next = new Subscription({
            id: init.id,
            revision: current?.revision.next() ?? Revision.initial(),
            source: init.source,
            target: init.target,
            mapping: init.mapping,
            dedupe: init.dedupe,
            authority: init.authority,
            contribution: attribution
        });
        if (
            current !== undefined &&
            current.retired !== true &&
            sameSubscriptionDesired(current, next)
        ) {
            return current;
        }
        if (current === undefined) this.createSubscription(transaction, next);
        else this.saveSubscription(transaction, next, current.revision);
        return next;
    }

    private createSubscription(transaction: Transaction, subscription: Subscription): void {
        const current = this.currentSubscription(transaction, subscription.id);
        if (current !== undefined || subscription.revision.value !== 0) {
            throw revisionConflict("New Subscription requires revision zero and no current record");
        }
        this.writeSubscription(transaction, subscription, undefined);
    }

    private writeSubscription(
        transaction: Transaction,
        subscription: Subscription,
        current: Subscription | undefined
    ): void {
        const storage = this.storage(transaction);
        const recordKey = subscriptionRecordId(subscription);
        this.append(storage, "subscription", recordKey, subscription, Subscription.codec);
        storage.compareAndSetPointer(
            { namespace: "subscription.current", key: subscription.id.value, recordKey },
            current === undefined ? undefined : subscriptionRecordId(current)
        );
    }

    public findReservation(
        transaction: Transaction,
        id: RouteReservationId
    ): RouteReservation | undefined {
        const reservation = this.load(
            transaction,
            "routeReservation",
            id.value,
            RouteReservation.codec
        );
        if (reservation !== undefined) this.requireReservationIndex(transaction, reservation);
        return reservation;
    }

    public findReservationByDedupe(
        transaction: Transaction,
        subscription: SubscriptionId,
        dedupeKey: string
    ): RouteReservation | undefined {
        const unique = this.storage(transaction).findUnique(
            `route.dedupe:${subscription.value}`,
            dedupeKey
        );
        if (unique === undefined) return undefined;
        const reservation = this.requireLoad(
            transaction,
            "routeReservation",
            unique.recordKey,
            RouteReservation.codec
        );
        if (!reservation.subscription.equals(subscription) || reservation.dedupeKey !== dedupeKey) {
            throw corrupt("Route dedupe index does not match its reservation");
        }
        return reservation;
    }

    public appendReservation(
        transaction: Transaction,
        reservation: RouteReservation,
        retention: ContentRetentionReference
    ): void {
        requireRetention(
            retention,
            RetainedRecordKind.routeReservation(),
            reservation.id.value,
            reservation.projectionRef.value
        );
        this.requireDurableRetention(transaction, retention);
        const storage = this.storage(transaction);
        if (
            storage.findUnique(
                `route.dedupe:${reservation.subscription.value}`,
                reservation.dedupeKey
            ) !== undefined
        ) {
            throw duplicate("Route dedupe identity is already reserved");
        }
        this.append(
            storage,
            "contentRetention",
            retention.id.value,
            retention,
            ContentRetentionReference.codec
        );
        this.append(
            storage,
            "routeReservation",
            reservation.id.value,
            reservation,
            RouteReservation.codec
        );
        storage.insertUnique({
            namespace: `route.dedupe:${reservation.subscription.value}`,
            key: reservation.dedupeKey,
            recordKey: reservation.id.value
        });
    }

    public listReservations(transaction: Transaction): readonly RouteReservation[] {
        return Object.freeze(
            this.storage(transaction)
                .listRecords("routeReservation")
                .map((record) =>
                    this.decodeStored(record, "routeReservation", record.id, RouteReservation.codec)
                )
                .map((route) => {
                    this.requireReservationIndex(transaction, route);
                    return route;
                })
                .sort((left, right) => compareCanonicalText(left.id.value, right.id.value))
        );
    }

    public listReservationsForEvent(
        transaction: Transaction,
        event: EventId
    ): readonly RouteReservation[] {
        return Object.freeze(
            this.listReservations(transaction).filter((route) => route.event.equals(event))
        );
    }

    public findProjection(
        transaction: Transaction,
        id: RouteProjectionId
    ): RouteProjection | undefined {
        return this.load(transaction, "routeProjection", id.value, RouteProjection.codec);
    }

    public findProjectionByReservation(
        transaction: Transaction,
        reservation: RouteReservationId
    ): RouteProjection | undefined {
        const unique = this.storage(transaction).findUnique("route.projection", reservation.value);
        if (unique === undefined) return undefined;
        const projection = this.requireLoad(
            transaction,
            "routeProjection",
            unique.recordKey,
            RouteProjection.codec
        );
        if (!projection.reservation.equals(reservation)) {
            throw corrupt("Projection index does not match its reservation");
        }
        return projection;
    }

    public appendProjection(
        transaction: Transaction,
        authentication: AuthenticatedRouteProjection,
        retention: ContentRetentionReference
    ): RouteProjection {
        requireAuthenticatedRouteProjection(authentication);
        const envelope = authentication.envelope;
        if (!envelope.reservation.targetActor.equals(this.actor)) {
            throw new AgentCoreError(
                "authority.denied",
                "Authenticated projection belongs to another target Actor"
            );
        }
        const projection = envelope.projection.authenticate(authentication.digest);
        requireRetention(
            retention,
            RetainedRecordKind.routeProjection(),
            projection.id.value,
            projection.content.value
        );
        this.requireDurableRetention(transaction, retention);
        const storage = this.storage(transaction);
        if (storage.findUnique("route.projection", projection.reservation.value) !== undefined) {
            throw duplicate("Route projection identity is already reserved");
        }
        this.append(
            storage,
            "contentRetention",
            retention.id.value,
            retention,
            ContentRetentionReference.codec
        );
        this.append(
            storage,
            "routeProjection",
            projection.id.value,
            projection,
            RouteProjection.codec
        );
        storage.insertUnique({
            namespace: "route.projection",
            key: projection.reservation.value,
            recordKey: projection.id.value
        });
        return projection;
    }

    public findDelivery(
        transaction: Transaction,
        reservation: RouteReservationId
    ): RouteDelivery | undefined {
        const unique = this.storage(transaction).findUnique("route.delivery", reservation.value);
        if (unique === undefined) return undefined;
        const delivery = this.requireLoad(
            transaction,
            "routeDelivery",
            unique.recordKey,
            RouteDelivery.codec
        );
        if (!delivery.reservation.equals(reservation)) {
            throw corrupt("Delivery index does not match its reservation");
        }
        return delivery;
    }

    public appendDelivery(transaction: Transaction, delivery: RouteDelivery): void {
        if (this.findProjectionByReservation(transaction, delivery.reservation) === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Terminal delivery requires the target-local authenticated projection"
            );
        }
        const storage = this.storage(transaction);
        if (storage.findUnique("route.delivery", delivery.reservation.value) !== undefined) {
            throw duplicate("Route delivery is already terminal");
        }
        this.append(
            storage,
            "routeDelivery",
            delivery.reservation.value,
            delivery,
            RouteDelivery.codec
        );
        storage.insertUnique({
            namespace: "route.delivery",
            key: delivery.reservation.value,
            recordKey: delivery.reservation.value
        });
    }

    public currentView(transaction: Transaction, surface: string): View | undefined {
        const pointer = this.storage(transaction).findPointer("view.current", surface);
        if (pointer === undefined) return undefined;
        const view = this.requireLoad(transaction, "view", pointer.recordKey, View.codec);
        if (view.surface.value !== surface) {
            throw corrupt("View pointer does not match its Surface");
        }
        return view;
    }

    public findView(
        transaction: Transaction,
        surface: string,
        revision: Revision
    ): View | undefined {
        return this.load(transaction, "view", `${surface}@${revision.value}`, View.codec);
    }

    public saveView(
        transaction: Transaction,
        view: View,
        expectedRevision: Revision | undefined,
        retentions: readonly ContentRetentionReference[]
    ): void {
        const storage = this.storage(transaction);
        const current = this.currentView(transaction, view.surface.value);
        if (expectedRevision === undefined) {
            if (current !== undefined || view.revision.value !== 0) {
                throw revisionConflict("Initial View requires revision zero and no current View");
            }
        } else if (
            current === undefined ||
            !current.revision.equals(expectedRevision) ||
            !expectedRevision.next().equals(view.revision)
        ) {
            throw revisionConflict("View revision compare-and-set failed");
        }
        for (const retention of retentions) {
            requireRetention(
                retention,
                RetainedRecordKind.view(),
                viewRecordId(view),
                retention.content.value
            );
            this.requireDurableRetention(transaction, retention);
            this.append(
                storage,
                "contentRetention",
                retention.id.value,
                retention,
                ContentRetentionReference.codec
            );
        }
        requireCompleteRetention(viewDocument(view), retentions, "View");
        const recordKey = viewRecordId(view);
        this.append(storage, "view", recordKey, view, View.codec);
        storage.compareAndSetPointer(
            { namespace: "view.current", key: view.surface.value, recordKey },
            current === undefined ? undefined : viewRecordId(current)
        );
    }

    public appendViewDelta(
        transaction: Transaction,
        delta: ViewDelta,
        patches: JsonPatchEngine,
        viewRetentions: readonly ContentRetentionReference[],
        deltaRetentions: readonly ContentRetentionReference[]
    ): View {
        const current = this.currentView(transaction, delta.surface.value);
        if (current === undefined || !current.revision.equals(delta.baseRevision)) {
            throw revisionConflict("View delta base revision is stale");
        }
        const next = viewFromDocument(
            current,
            delta,
            patches.apply(viewDocument(current), delta.patch)
        );
        const storage = this.storage(transaction);
        for (const retention of viewRetentions) {
            requireRetention(
                retention,
                RetainedRecordKind.view(),
                viewRecordId(next),
                retention.content.value
            );
            this.requireDurableRetention(transaction, retention);
            this.append(
                storage,
                "contentRetention",
                retention.id.value,
                retention,
                ContentRetentionReference.codec
            );
        }
        for (const retention of deltaRetentions) {
            requireRetention(
                retention,
                RetainedRecordKind.viewDelta(),
                deltaRecordId(delta),
                retention.content.value
            );
            this.requireDurableRetention(transaction, retention);
            this.append(
                storage,
                "contentRetention",
                retention.id.value,
                retention,
                ContentRetentionReference.codec
            );
        }
        requireCompleteRetention(viewDocument(next), viewRetentions, "View");
        requireCompleteRetention(delta.patch, deltaRetentions, "ViewDelta");
        this.append(storage, "viewDelta", deltaRecordId(delta), delta, ViewDelta.codec);
        this.append(storage, "view", viewRecordId(next), next, View.codec);
        storage.compareAndSetPointer(
            {
                namespace: "view.current",
                key: delta.surface.value,
                recordKey: viewRecordId(next)
            },
            viewRecordId(current)
        );
        return next;
    }

    public listViewDeltas(
        transaction: Transaction,
        surface: string,
        after: Revision
    ): readonly ViewDelta[] {
        return Object.freeze(
            this.storage(transaction)
                .listRecords("viewDelta")
                .map((record) => this.decodeStored(record, "viewDelta", record.id, ViewDelta.codec))
                .filter(
                    (delta) => delta.surface.value === surface && delta.revision.value > after.value
                )
                .sort((left, right) => left.revision.value - right.revision.value)
        );
    }

    public compactView(transaction: Transaction, surface: string, retainFrom: Revision): void {
        const floor = this.findView(transaction, surface, retainFrom);
        const current = this.currentView(transaction, surface);
        if (
            floor === undefined ||
            current === undefined ||
            retainFrom.value > current.revision.value
        ) {
            throw revisionConflict("View compaction floor is unavailable");
        }
        const storage = this.storage(transaction);
        const oldViews = storage
            .listRecords("view")
            .map((record) => ({
                record,
                value: this.decodeStored(record, "view", record.id, View.codec)
            }))
            .filter(
                ({ value }) =>
                    value.surface.value === surface && value.revision.value < retainFrom.value
            )
            .map(({ record }) => record.id);
        const oldDeltas = storage
            .listRecords("viewDelta")
            .map((record) => ({
                record,
                value: this.decodeStored(record, "viewDelta", record.id, ViewDelta.codec)
            }))
            .filter(
                ({ value }) =>
                    value.surface.value === surface && value.revision.value <= retainFrom.value
            )
            .map(({ record }) => record.id);
        this.releaseRetentions(transaction, RetainedRecordKind.view(), oldViews);
        this.releaseRetentions(transaction, RetainedRecordKind.viewDelta(), oldDeltas);
        storage.deleteRecords("view", oldViews);
        storage.deleteRecords("viewDelta", oldDeltas);
    }

    public listRetentionsFor(
        transaction: Transaction,
        recordKind: RetainedRecordKind,
        recordKey: string
    ): readonly ContentRetentionReference[] {
        return Object.freeze(
            this.storage(transaction)
                .listRecords("contentRetention")
                .map((record) =>
                    this.decodeStored(
                        record,
                        "contentRetention",
                        record.id,
                        ContentRetentionReference.codec
                    )
                )
                .filter(
                    (reference) =>
                        reference.recordKind.equals(recordKind) &&
                        reference.record.value === recordKey
                )
        );
    }

    private currentRecord<Record extends WorkspaceDurableRecord>(
        transaction: Transaction,
        kind: WorkspaceRecordKind,
        namespace: string,
        key: string,
        codec: { decode(bytes: Uint8Array): Record }
    ): Record | undefined {
        const pointer = this.storage(transaction).findPointer(namespace, key);
        return pointer === undefined
            ? undefined
            : this.requireLoad(transaction, kind, pointer.recordKey, codec);
    }

    private listCurrentRecords<Record extends WorkspaceDurableRecord>(
        transaction: Transaction,
        kind: WorkspaceRecordKind,
        namespace: string,
        keyOf: (record: Record) => string,
        codec: { decode(bytes: Uint8Array): Record },
        compare: (left: Record, right: Record) => number
    ): readonly Record[] {
        const storage = this.storage(transaction);
        const current: Record[] = [];
        const seen = new Set<string>();
        for (const stored of storage.listRecords(kind)) {
            const record = this.decodeStored(stored, kind, stored.id, codec);
            const key = keyOf(record);
            if (seen.has(key)) continue;
            if (storage.findPointer(namespace, key)?.recordKey === stored.id) {
                current.push(record);
                seen.add(key);
            }
        }
        return Object.freeze(current.sort(compare));
    }

    private appendOrVerify<Record extends WorkspaceDurableRecord>(
        storage: WorkspaceRecordStorage,
        kind: WorkspaceRecordKind,
        id: string,
        record: Record,
        codec: { encode(value: Record): Uint8Array; decode(bytes: Uint8Array): Record }
    ): void {
        const expected = codec.encode(record);
        codec.decode(expected);
        const existing = storage.findRecord(kind, id);
        if (existing === undefined) {
            storage.insertRecord({ kind, id, bytes: expected });
            return;
        }
        const decoded = this.decodeStored(existing, kind, id, codec);
        if (!sameBytes(codec.encode(decoded), expected)) {
            throw corrupt(`${kind} record identity resolves to different bytes`);
        }
    }

    private append<Record>(
        storage: WorkspaceRecordStorage,
        kind: WorkspaceRecordKind,
        id: string,
        record: Record,
        codec: { encode(value: Record): Uint8Array; decode(bytes: Uint8Array): Record }
    ): void {
        if (storage.findRecord(kind, id) !== undefined) {
            throw new AgentCoreError("protocol.duplicate", `${kind} records are immutable`);
        }
        const bytes = codec.encode(record);
        codec.decode(bytes);
        storage.insertRecord({ kind, id, bytes });
    }

    private requireDurableRetention(
        transaction: Transaction,
        reference: ContentRetentionReference
    ): void {
        if (!this.retention.verify(transaction, reference)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Content retention proof is not durable"
            );
        }
        if (!reference.actor.equals(this.actor) || !reference.tenant.equals(this.tenant)) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Content retention proof belongs to another Actor or tenant"
            );
        }
    }

    private requireEventIndex(transaction: Transaction, event: Event): void {
        const unique = this.storage(transaction).findUnique(
            "event.idempotency",
            event.idempotencyKey
        );
        if (unique?.recordKey !== event.id.value) {
            throw corrupt("Event is missing its reciprocal idempotency index");
        }
    }

    private requireReservationIndex(transaction: Transaction, reservation: RouteReservation): void {
        const unique = this.storage(transaction).findUnique(
            `route.dedupe:${reservation.subscription.value}`,
            reservation.dedupeKey
        );
        if (unique?.recordKey !== reservation.id.value) {
            throw corrupt("RouteReservation is missing its reciprocal dedupe index");
        }
    }

    private releaseRetentions(
        transaction: Transaction,
        recordKind: ContentRetentionReference["recordKind"],
        recordKeys: readonly string[]
    ): void {
        if (recordKeys.length === 0) return;
        const keys = new Set(recordKeys);
        const storage = this.storage(transaction);
        const retained = storage
            .listRecords("contentRetention")
            .map((record) =>
                this.decodeStored(
                    record,
                    "contentRetention",
                    record.id,
                    ContentRetentionReference.codec
                )
            )
            .filter(
                (reference) =>
                    reference.recordKind.equals(recordKind) && keys.has(reference.record.value)
            );
        for (const reference of retained) this.retention.release(transaction, reference);
        storage.deleteRecords(
            "contentRetention",
            retained.map((reference) => reference.id.value)
        );
    }

    private load<Record extends WorkspaceDurableRecord>(
        transaction: Transaction,
        kind: WorkspaceRecordKind,
        id: string,
        codec: { decode(bytes: Uint8Array): Record }
    ): Record | undefined {
        const stored = this.storage(transaction).findRecord(kind, id);
        return stored === undefined ? undefined : this.decodeStored(stored, kind, id, codec);
    }

    private requireLoad<Record extends WorkspaceDurableRecord>(
        transaction: Transaction,
        kind: WorkspaceRecordKind,
        id: string,
        codec: { decode(bytes: Uint8Array): Record }
    ): Record {
        const record = this.load(transaction, kind, id, codec);
        if (record === undefined) {
            throw corrupt("Workspace index points to a missing authoritative record");
        }
        return record;
    }

    private decodeStored<Record extends WorkspaceDurableRecord>(
        stored: StoredWorkspaceRecord,
        kind: WorkspaceRecordKind,
        id: string,
        codec: { decode(bytes: Uint8Array): Record }
    ): Record {
        if (stored.kind !== kind || stored.id !== id || !(stored.bytes instanceof Uint8Array)) {
            throw corrupt("Stored workspace record key or kind is malformed");
        }
        try {
            const record = codec.decode(stored.bytes.slice());
            if (durableRecordId(kind, record) !== id) {
                throw corrupt("Stored workspace key does not match its codec identity");
            }
            return record;
        } catch (error) {
            if (error instanceof AgentCoreError) throw error;
            throw corrupt("Stored workspace record bytes are malformed");
        }
    }
}

export function validateWorkspacePointerAdvance(
    pointer: StoredWorkspacePointer,
    expectedRecordKey: string | undefined
): void {
    validateWorkspacePointer(pointer);
    switch (pointer.namespace) {
        case "subscription.current":
        case "view.current":
        case "ingress.current": {
            const nextRevision = pointerRevision(pointer.recordKey, pointer.namespace);
            const expectedRevision =
                expectedRecordKey === undefined
                    ? undefined
                    : pointerRevision(expectedRecordKey, pointer.namespace);
            if (
                (expectedRevision === undefined && nextRevision !== 0) ||
                (expectedRevision !== undefined && nextRevision !== expectedRevision + 1)
            ) {
                throw revisionConflict("Workspace pointer must advance by exactly one revision");
            }
            return;
        }
        case "catalog.current":
        case "prompt.current":
        case "settings.current":
        case "surface.registration":
            return;
        default:
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Workspace pointer namespace is invalid"
            );
    }
}

export function validateStoredWorkspaceRecord(record: StoredWorkspaceRecord): void {
    if (!isMember(WORKSPACE_RECORD_KINDS, record.kind)) {
        throw new AgentCoreError("codec.invalid", "Workspace record kind is invalid");
    }
    validateStorageText(record.id, 2048, "Workspace record key");
    if (!(record.bytes instanceof Uint8Array)) {
        throw new AgentCoreError("codec.invalid", "Workspace record bytes are malformed");
    }
}

export function validateWorkspaceUnique(unique: StoredWorkspaceUnique): void {
    validateStorageText(unique.namespace, 512, "Workspace unique namespace");
    validateStorageText(unique.key, 2048, "Workspace unique key");
    validateStorageText(unique.recordKey, 2048, "Workspace unique record key");
}

export function validateWorkspacePointer(pointer: StoredWorkspacePointer): void {
    validateStorageText(pointer.namespace, 512, "Workspace pointer namespace");
    validateStorageText(pointer.key, 2048, "Workspace pointer key");
    validateStorageText(pointer.recordKey, 2048, "Workspace pointer record key");
}

function validateStorageText(value: string, maximum: number, subject: string): void {
    if (value.length === 0 || value.length > maximum) {
        throw new AgentCoreError("codec.invalid", `${subject} length is invalid`);
    }
}

function pointerRevision(recordKey: string, namespace: string): number {
    if (namespace === "ingress.current") {
        const tuple = decodeCanonicalJson(new TextEncoder().encode(recordKey));
        if (!Array.isArray(tuple) || tuple.length !== 3 || tuple[0] !== "ingress-endpoint.record") {
            throw new AgentCoreError("codec.invalid", "Ingress endpoint pointer key is malformed");
        }
        const parser = jsonDataParser((message) => new AgentCoreError("codec.invalid", message));
        parser.nonemptyString(tuple[1], "Ingress endpoint ID");
        return parser.safeInteger(tuple[2], "Ingress endpoint revision");
    }
    const separator = recordKey.lastIndexOf("@");
    const revision = separator < 0 ? Number.NaN : Number(recordKey.slice(separator + 1));
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new AgentCoreError("codec.invalid", "Workspace pointer record key is malformed");
    }
    return revision;
}

function requireCompleteRetention(
    value: JsonValue,
    retentions: readonly ContentRetentionReference[],
    subject: string
): void {
    const required = collectContentRefs(value);
    const supplied = new Set(retentions.map((reference) => reference.content.value));
    if (required.size !== supplied.size || [...required].some((ref) => !supplied.has(ref))) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            `${subject} content retention does not cover every ContentRef exactly`
        );
    }
}

function collectContentRefs(value: JsonValue, refs = new Set<string>()): Set<string> {
    if (isStringValue(value)) {
        try {
            refs.add(new ContentRef(value).value);
        } catch {}
        return refs;
    }
    if (Array.isArray(value)) {
        for (const entry of value) collectContentRefs(entry, refs);
    } else if (isJsonObject(value)) {
        for (const entry of Object.values(value)) collectContentRefs(entry, refs);
    }
    return refs;
}

function durableRecordId(kind: WorkspaceRecordKind, record: WorkspaceDurableRecord): string {
    switch (kind) {
        case "catalogEntry":
            if (record instanceof CatalogEntry) return record.id.value;
            break;
        case "ingressEndpoint":
            if (record instanceof IngressEndpoint) return ingressEndpointRecordId(record);
            break;
        case "promptSection":
            if (record instanceof PromptSection) return record.id.value;
            break;
        case "settingsLayer":
            if (record instanceof SettingsLayer) return record.id.value;
            break;
        case "surfaceRegistration":
            if (record instanceof SurfaceRegistration) {
                return Digest.sha256(SurfaceRegistration.encode(record)).value;
            }
            break;
        case "event":
            if (record instanceof Event) return record.id.value;
            break;
        case "subscription":
            if (record instanceof Subscription) return subscriptionRecordId(record);
            break;
        case "routeReservation":
            if (record instanceof RouteReservation) return record.id.value;
            break;
        case "routeProjection":
            if (record instanceof RouteProjection) return record.id.value;
            break;
        case "routeDelivery":
            if (record instanceof RouteDelivery) return record.reservation.value;
            break;
        case "view":
            if (record instanceof View) return viewRecordId(record);
            break;
        case "viewDelta":
            if (record instanceof ViewDelta) return deltaRecordId(record);
            break;
        case "contentRetention":
            if (record instanceof ContentRetentionReference) return record.id.value;
            break;
    }
    throw corrupt("Stored workspace record has the wrong codec kind");
}
function sameIngressDesired(current: IngressEndpoint, desired: IngressEndpoint): boolean {
    return (
        current.retired === undefined &&
        current.scope.equals(desired.scope) &&
        sameContribution(current.contribution, desired.contribution) &&
        sameBytes(
            IngressDeclaration.encode(current.declared),
            IngressDeclaration.encode(desired.declared)
        )
    );
}

function isStringValue(value: JsonValue): value is string {
    return typeof value === "string";
}
function subscriptionRecordId(subscription: Subscription): string {
    return `${subscription.id.value}@${subscription.revision.value}`;
}

function ingressEndpointRecordId(endpoint: IngressEndpoint): string {
    return canonicalTupleKey("ingress-endpoint.record", [
        endpoint.id.value,
        endpoint.revision.value
    ]);
}

function viewRecordId(view: View): string {
    return `${view.surface.value}@${view.revision.value}`;
}

function deltaRecordId(delta: ViewDelta): string {
    return `${delta.surface.value}@${delta.revision.value}`;
}

function sameContribution(
    left: Subscription["contribution"],
    right: Subscription["contribution"]
): boolean {
    if (left === undefined || right === undefined) return left === right;
    return left.equals(right);
}

function sameSubscriptionDesired(current: Subscription, desired: Subscription): boolean {
    return sameBytes(
        Subscription.encode(current),
        Subscription.encode(
            new Subscription({
                id: desired.id,
                revision: current.revision,
                source: desired.source,
                target: desired.target,
                mapping: desired.mapping,
                dedupe: desired.dedupe,
                authority: desired.authority,
                contribution: desired.contribution
            })
        )
    );
}

function requireSameOptionalContributor(
    left: ContributionAttribution | undefined,
    right: ContributionAttribution | undefined,
    subject: string
): void {
    if (
        (left === undefined) !== (right === undefined) ||
        (left !== undefined && right !== undefined && !left.contributor.equals(right.contributor))
    ) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            `${subject} origin belongs to another contributor`
        );
    }
}

function compareSettingsLayers(left: SettingsLayer, right: SettingsLayer): number {
    return (
        compareCanonicalText(
            left.attribution.package.id.value,
            right.attribution.package.id.value
        ) ||
        compareCanonicalText(
            left.attribution.contributor.value,
            right.attribution.contributor.value
        ) ||
        left.ordinal - right.ordinal
    );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function requireRetention(
    reference: ContentRetentionReference,
    recordKind: ContentRetentionReference["recordKind"],
    recordKey: string,
    content: string
): void {
    if (
        !reference.recordKind.equals(recordKind) ||
        reference.record.value !== recordKey ||
        reference.content.value !== content
    ) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Content retention reference does not bind the durable record"
        );
    }
}

function revisionConflict(message: string): AgentCoreError {
    return new AgentCoreError("protocol.revision-conflict", message);
}

function duplicate(message: string): AgentCoreError {
    return new AgentCoreError("protocol.duplicate", message);
}

function corrupt(message: string): AgentCoreError {
    return new AgentCoreError("codec.invalid", message);
}
