import type { ClassDeclaration } from "typescript/unstable/ast";
import type { Project } from "typescript/unstable/sync";
import type { JsonValue } from "./project.mjs";

export function validateRecordOwnership(records: readonly JsonValue[]): void;
export function validateRecordContentRetention(
    records: readonly JsonValue[],
    project: Project
): void;
export function declaredContentRefFields(
    project: Project,
    declaration: ClassDeclaration
): readonly string[];

/** One authority record class name reaching a persistence surface's member signature. */
export interface NamedAuthorityRecord {
    readonly record: string;
    readonly member: string;
}

/** A durable persistence surface and the authority records it names. */
export interface PersistenceSurface {
    readonly selector: string;
    readonly context: string;
    readonly records: readonly NamedAuthorityRecord[];
}

/** One owned, rebuildable cache discovered in `src`. */
export interface DiscoveredCache {
    readonly source: string;
}

/** How one cache satisfies §8.4 rule 3, and the test that shows it. */
export interface DerivedCacheEntry extends DiscoveredCache {
    readonly derivedFrom: string;
    readonly versionedBy: string;
    readonly rebuiltBy: string;
    readonly missIsOrdinary: string;
    readonly test: string;
}

/** How one §4.7 capability namespace stores its entries. */
export interface NamespaceStructure {
    readonly source: string;
    readonly member: string;
    readonly keying: string;
}

/** The declared name of each §4.7 namespace and the member holding its entries. */
export interface DeclaredNamespace {
    readonly source: string;
    readonly member: string;
}

/** One member that writes the Subscription namespace or reaches its private funnel. */
export interface SubscriptionWriter {
    readonly selector: string;
    readonly member: string;
}

/** The discovered write surface of the Subscription namespace. */
export interface SubscriptionWriters {
    readonly writers: readonly SubscriptionWriter[];
    readonly entries: readonly SubscriptionWriter[];
}

/** One declared entry point, and what authorizes the attribution it may write. */
export interface SubscriptionEntryPoint {
    readonly member: string;
    readonly attribution: string;
}

export const AUTHORITY_RECORD_CLASSES: readonly string[];
export const DERIVED_CACHE_INVENTORY: readonly DerivedCacheEntry[];
export const NAMESPACE_STRUCTURES: readonly DeclaredNamespace[];
export const SUBSCRIPTION_NAMESPACE: {
    readonly kind: string;
    readonly pointer: string;
    readonly writer: string;
    readonly funnel: readonly string[];
};
export const SUBSCRIPTION_ENTRY_POINTS: readonly SubscriptionEntryPoint[];

export function discoverPersistenceSurfaces(project: Project): PersistenceSurface[];
export function validateAuthorityPlaneExclusivity(surfaces: readonly PersistenceSurface[]): void;
export function discoverDerivedCaches(project: Project): DiscoveredCache[];
export function validateDerivedCacheInventory(
    caches: readonly DiscoveredCache[],
    inventory?: readonly DerivedCacheEntry[]
): void;
export function discoverNamespaceStructures(project: Project): NamespaceStructure[];
export function validateClosedNamespaceStructure(structures: readonly NamespaceStructure[]): void;
export function discoverSubscriptionWriters(project: Project): SubscriptionWriters;
export function validateSubscriptionWriteMediation(
    discovered: SubscriptionWriters,
    declared?: readonly SubscriptionEntryPoint[]
): void;
