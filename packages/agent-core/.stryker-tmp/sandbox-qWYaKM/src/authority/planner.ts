// @ts-nocheck
import type { ScopeRef } from "../identity";
import { AgentCoreError } from "../errors";
import { ScopeEpoch } from "./epoch";
import { scopeKey } from "./reference";

type NonEmptyScopes = readonly [ScopeRef, ...ScopeRef[]];

export type ResolverInputMutation =
    | { readonly kind: "grant"; readonly scope: ScopeRef }
    | { readonly kind: "membership"; readonly affectedScopes: NonEmptyScopes }
    | { readonly kind: "role"; readonly affectedScopes: NonEmptyScopes }
    | { readonly kind: "teamClosure"; readonly affectedScopes: NonEmptyScopes }
    | { readonly kind: "principalClosure"; readonly affectedScopes: NonEmptyScopes }
    | { readonly kind: "guestVerification"; readonly affectedScopes: NonEmptyScopes }
    | { readonly kind: "topology"; readonly affectedScopes: NonEmptyScopes }
    | { readonly kind: "lifecycle"; readonly affectedScopes: NonEmptyScopes }
    | { readonly kind: "policy"; readonly affectedScopes: NonEmptyScopes }
    | { readonly kind: "trust"; readonly affectedScopes: NonEmptyScopes }
    | { readonly kind: "bindingTransition"; readonly affectedScopes: NonEmptyScopes };

export class EpochPlan {
    public readonly next: readonly ScopeEpoch[];
    public readonly bumped: readonly ScopeEpoch[];
    public readonly affectedScopes: readonly ScopeRef[];

    public constructor(next: readonly ScopeEpoch[], bumped: readonly ScopeEpoch[]) {
        this.next = canonicalEpochs(next);
        this.bumped = canonicalEpochs(bumped);
        this.affectedScopes = Object.freeze(this.bumped.map((entry) => entry.scope));
        Object.freeze(this);
    }
}

export class EpochPlanner {
    public plan(
        current: readonly ScopeEpoch[],
        mutations: readonly ResolverInputMutation[]
    ): EpochPlan {
        const currentByScope = new Map<string, ScopeEpoch>();
        for (const entry of current) {
            const key = scopeKey(entry.scope);
            if (currentByScope.has(key)) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    "Current Scope epochs must be unique"
                );
            }
            currentByScope.set(key, entry);
        }
        const affected = new Map<string, ScopeRef>();
        for (const mutation of mutations) {
            for (const scope of mutationScopes(mutation)) affected.set(scopeKey(scope), scope);
        }

        for (const [key] of affected) {
            if (currentByScope.get(key)?.epoch === Number.MAX_SAFE_INTEGER) {
                throw new AgentCoreError(
                    "protocol.invalid-state",
                    `Authority epoch is exhausted for ${key}`
                );
            }
        }

        const bumped: ScopeEpoch[] = [];
        for (const [key, scope] of affected) {
            const next = (currentByScope.get(key) ?? ScopeEpoch.initial(scope)).next();
            currentByScope.set(key, next);
            bumped.push(next);
        }
        return new EpochPlan([...currentByScope.values()], bumped);
    }
}

function mutationScopes(mutation: ResolverInputMutation): readonly ScopeRef[] {
    switch (mutation.kind) {
        case "grant":
            return [mutation.scope];
        case "membership":
        case "role":
        case "teamClosure":
        case "principalClosure":
        case "guestVerification":
        case "topology":
        case "lifecycle":
        case "policy":
        case "trust":
        case "bindingTransition":
            return mutation.affectedScopes;
        default:
            return assertNever(mutation);
    }
}

function canonicalEpochs(entries: readonly ScopeEpoch[]): readonly ScopeEpoch[] {
    const ordered = [...entries].sort((left, right) =>
        scopeKey(left.scope).localeCompare(scopeKey(right.scope))
    );
    if (new Set(ordered.map((entry) => scopeKey(entry.scope))).size !== ordered.length) {
        throw new AgentCoreError("protocol.invalid-state", "Epoch plan Scopes must be unique");
    }
    return Object.freeze(ordered);
}

function assertNever(value: never): never {
    throw new AgentCoreError(
        "protocol.invalid-state",
        `Unknown authority mutation ${String(value)}`
    );
}
