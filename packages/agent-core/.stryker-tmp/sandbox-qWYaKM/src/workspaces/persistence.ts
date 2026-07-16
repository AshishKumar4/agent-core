// @ts-nocheck
import { AgentCoreError } from "../errors";
import type { ActorRef } from "../actors";
import { ContentRef, type Revision } from "../core";
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
import {
    AuthenticatedRouteProjection,
    RouteDelivery,
    RouteProjection,
    RouteReservation,
    requireAuthenticatedRouteProjection
} from "./route";
import { Subscription } from "./subscription";
import { View, ViewDelta, type JsonPatchEngine, viewDocument, viewFromDocument } from "./view";

export type WorkspaceRecordKind =
    | "event"
    | "subscription"
    | "routeReservation"
    | "routeProjection"
    | "routeDelivery"
    | "view"
    | "viewDelta"
    | "contentRetention";

export type CompactableWorkspaceRecordKind = "view" | "viewDelta" | "contentRetention";

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
    deleteCompactedRecords(kind: CompactableWorkspaceRecordKind, ids: readonly string[]): void;
    findUnique(namespace: string, key: string): StoredWorkspaceUnique | undefined;
    insertUnique(unique: StoredWorkspaceUnique): void;
    findPointer(namespace: string, key: string): StoredWorkspacePointer | undefined;
    compareAndSetPointer(
        pointer: StoredWorkspacePointer,
        expectedRecordKey: string | undefined
    ): void;
}

export class WorkspacePersistence<Transaction> {
    public constructor(
        private readonly storage: (transaction: Transaction) => WorkspaceRecordStorage,
        private readonly retention: ContentRetentionPort<Transaction>,
        private readonly actor: ActorRef,
        private readonly tenant: TenantId
    ) {}

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
            if (current !== undefined) {
                subscriptions.push(current);
                seen.add(current.id.value);
            }
        }
        return Object.freeze(
            subscriptions.sort((left, right) => left.id.value.localeCompare(right.id.value))
        );
    }

    public saveSubscription(
        transaction: Transaction,
        subscription: Subscription,
        expectedRevision: Revision | undefined
    ): void {
        const storage = this.storage(transaction);
        const current = this.currentSubscription(transaction, subscription.id);
        if (expectedRevision === undefined) {
            if (current !== undefined || subscription.revision.value !== 0) {
                throw revisionConflict(
                    "New Subscription requires revision zero and no current record"
                );
            }
        } else if (
            current === undefined ||
            !current.revision.equals(expectedRevision) ||
            !expectedRevision.next().equals(subscription.revision)
        ) {
            throw revisionConflict("Subscription revision compare-and-set failed");
        }
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
                .sort((left, right) => left.id.value.localeCompare(right.id.value))
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
        storage.deleteCompactedRecords("view", oldViews);
        storage.deleteCompactedRecords("viewDelta", oldDeltas);
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
        storage.deleteCompactedRecords(
            "contentRetention",
            retained.map((reference) => reference.id.value)
        );
    }

    private load<Record>(
        transaction: Transaction,
        kind: WorkspaceRecordKind,
        id: string,
        codec: { decode(bytes: Uint8Array): Record }
    ): Record | undefined {
        const stored = this.storage(transaction).findRecord(kind, id);
        return stored === undefined ? undefined : this.decodeStored(stored, kind, id, codec);
    }

    private requireLoad<Record>(
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

    private decodeStored<Record>(
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
    if (pointer.namespace !== "subscription.current" && pointer.namespace !== "view.current") {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Workspace pointer namespace is invalid"
        );
    }
    const nextRevision = pointerRevision(pointer.recordKey);
    const expectedRevision =
        expectedRecordKey === undefined ? undefined : pointerRevision(expectedRecordKey);
    if (
        (expectedRevision === undefined && nextRevision !== 0) ||
        (expectedRevision !== undefined && nextRevision !== expectedRevision + 1)
    ) {
        throw revisionConflict("Workspace pointer must advance by exactly one revision");
    }
}

export function validateStoredWorkspaceRecord(record: StoredWorkspaceRecord): void {
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

function pointerRevision(recordKey: string): number {
    const separator = recordKey.lastIndexOf("@");
    const revision = separator < 0 ? Number.NaN : Number(recordKey.slice(separator + 1));
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new AgentCoreError("codec.invalid", "Workspace pointer record key is malformed");
    }
    return revision;
}

function requireCompleteRetention(
    value: unknown,
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

function collectContentRefs(value: unknown, refs = new Set<string>()): Set<string> {
    if (typeof value === "string") {
        try {
            refs.add(new ContentRef(value).value);
        } catch {}
        return refs;
    }
    if (Array.isArray(value)) {
        for (const entry of value) collectContentRefs(entry, refs);
    } else if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) collectContentRefs(entry, refs);
    }
    return refs;
}

function durableRecordId(kind: WorkspaceRecordKind, record: unknown): string {
    switch (kind) {
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

function subscriptionRecordId(subscription: Subscription): string {
    return `${subscription.id.value}@${subscription.revision.value}`;
}

function viewRecordId(view: View): string {
    return `${view.surface.value}@${view.revision.value}`;
}

function deltaRecordId(delta: ViewDelta): string {
    return `${delta.surface.value}@${delta.revision.value}`;
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
