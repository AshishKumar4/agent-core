import { canonicalTupleKey, type JsonValue } from "../core";

export type AuthorityKeyKind = "scope" | "subject" | "principal" | "binding" | "domain";

export function authorityKey(kind: AuthorityKeyKind, components: readonly JsonValue[]): string {
    return canonicalTupleKey("agent-core.authority-key.v1", [kind, ...components]);
}
