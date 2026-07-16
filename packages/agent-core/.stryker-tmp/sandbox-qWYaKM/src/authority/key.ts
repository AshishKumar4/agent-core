// @ts-nocheck
import { encodeCanonicalJson, type JsonValue } from "../core";

const decoder = new TextDecoder("utf-8", { fatal: true });

export type AuthorityKeyKind = "scope" | "subject" | "principal" | "binding" | "domain";

export function authorityKey(kind: AuthorityKeyKind, components: readonly JsonValue[]): string {
    return decoder.decode(
        encodeCanonicalJson(["agent-core.authority-key.v1", kind, ...components])
    );
}
