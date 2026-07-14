import { RecordCodec, Revision, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import { BindingName, FacetRef, ProtectionDomain } from "../facets";
import type { ScopeRef, SubjectRef } from "../identity";
import {
    requireExact,
    requireObject,
    requireSafeInteger,
    requireString,
    type JsonObject
} from "./data";
import { GrantId } from "./id";
import {
    decodeAuthorityScope,
    decodeAuthoritySubject,
    encodeAuthorityScope,
    encodeAuthoritySubject,
    scopeKey,
    subjectKey
} from "./reference";
import { authorityKey } from "./key";

export type BindingStateName = "active" | "inactive";

abstract class BindingLifecycle {
    public abstract readonly name: BindingStateName;
    public abstract activate(): BindingLifecycle;
    public abstract deactivate(): BindingLifecycle;

    public static from(state: BindingStateName): BindingLifecycle {
        return state === "active" ? activeBinding : inactiveBinding;
    }
}

class ActiveBindingLifecycle extends BindingLifecycle {
    public readonly name = "active" as const;
    public activate(): BindingLifecycle {
        return this;
    }
    public deactivate(): BindingLifecycle {
        return inactiveBinding;
    }
}

class InactiveBindingLifecycle extends BindingLifecycle {
    public readonly name = "inactive" as const;
    public activate(): BindingLifecycle {
        return activeBinding;
    }
    public deactivate(): BindingLifecycle {
        return this;
    }
}

const activeBinding = Object.freeze(new ActiveBindingLifecycle());
const inactiveBinding = Object.freeze(new InactiveBindingLifecycle());

class BindingCodecV1 extends RecordCodec<Binding> {
    public constructor() {
        super("authority.binding", { major: 1, minor: 0 });
    }
    protected encodePayload(record: Binding): JsonValue {
        return record.toData();
    }
    protected decodePayload(payload: JsonValue): Binding {
        return Binding.fromData(payload);
    }
}

export class Binding {
    public static readonly codec: RecordCodec<Binding> = new BindingCodecV1();
    public readonly domain: ProtectionDomain;
    public readonly subject: SubjectRef;
    readonly #lifecycle: BindingLifecycle;

    public constructor(
        public readonly scope: ScopeRef,
        subject: SubjectRef,
        domain: ProtectionDomain,
        public readonly name: BindingName,
        public readonly grantId: GrantId,
        public readonly facet: FacetRef,
        public readonly generation: number,
        state: BindingStateName,
        public readonly revision: Revision
    ) {
        if (scope.kind !== "workspace") {
            throw new TypeError("Bindings require a Workspace Scope");
        }
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError("Binding generation must be a non-negative safe integer");
        }
        this.#lifecycle = BindingLifecycle.from(requireBindingState(state));
        this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
        this.domain = immutableDomain(domain);
        Object.freeze(this);
    }

    public static active(
        scope: ScopeRef,
        subject: SubjectRef,
        domain: ProtectionDomain,
        name: BindingName,
        grantId: GrantId,
        facet: FacetRef
    ): Binding {
        return new Binding(
            scope,
            subject,
            domain,
            name,
            grantId,
            facet,
            0,
            "active",
            Revision.initial()
        );
    }

    public static encode(record: Binding): Uint8Array {
        return Binding.codec.encode(record);
    }
    public static decode(bytes: Uint8Array): Binding {
        return Binding.codec.decode(bytes);
    }

    public get key(): string {
        return authorityKey("binding", [
            encodeAuthorityScope(this.scope),
            encodeAuthoritySubject(this.subject),
            encodeDomain(this.domain),
            this.name.value
        ]);
    }

    public get resolves(): boolean {
        return this.state === "active";
    }
    public get state(): BindingStateName {
        return this.#lifecycle.name;
    }

    public replace(grantId: GrantId, facet: FacetRef): Binding {
        return this.transition(this.#lifecycle.activate(), grantId, facet);
    }

    public deactivate(): Binding {
        const next = this.#lifecycle.deactivate();
        return next === this.#lifecycle ? this : this.transition(next, this.grantId, this.facet);
    }

    public assertCanReplace(next: Binding): void {
        if (
            this.key !== next.key ||
            scopeKey(this.scope) !== scopeKey(next.scope) ||
            subjectKey(this.subject) !== subjectKey(next.subject) ||
            next.generation !== this.generation + 1 ||
            next.revision.value !== this.revision.value + 1
        ) {
            throw new AgentCoreError(
                "binding.invalid",
                "Binding updates require immutable identity and the next generation and revision"
            );
        }
    }

    public toData(): JsonObject {
        return {
            domain: encodeDomain(this.domain),
            facet: this.facet.value,
            generation: this.generation,
            grantId: this.grantId.value,
            name: this.name.value,
            revision: this.revision.value,
            scope: encodeAuthorityScope(this.scope),
            state: this.state,
            subject: encodeAuthoritySubject(this.subject)
        };
    }

    public static fromData(value: JsonValue | undefined): Binding {
        const object = requireObject(value, "Binding");
        requireExact(
            object,
            [
                "domain",
                "facet",
                "generation",
                "grantId",
                "name",
                "revision",
                "scope",
                "state",
                "subject"
            ],
            "Binding"
        );
        return new Binding(
            decodeAuthorityScope(object["scope"]!),
            decodeAuthoritySubject(object["subject"]!),
            decodeDomain(object["domain"]),
            new BindingName(requireString(object, "name", "Binding name")),
            new GrantId(requireString(object, "grantId", "Grant ID")),
            new FacetRef(requireString(object, "facet", "Facet reference")),
            requireSafeInteger(object, "generation", "Binding generation"),
            requireBindingState(object["state"]),
            new Revision(requireSafeInteger(object, "revision", "Binding revision"))
        );
    }

    private transition(state: BindingLifecycle, grantId: GrantId, facet: FacetRef): Binding {
        if (
            this.generation === Number.MAX_SAFE_INTEGER ||
            this.revision.value === Number.MAX_SAFE_INTEGER
        ) {
            throw new AgentCoreError("binding.invalid", "Binding generation is exhausted");
        }
        return new Binding(
            this.scope,
            this.subject,
            this.domain,
            this.name,
            grantId,
            facet,
            this.generation + 1,
            state.name,
            this.revision.next()
        );
    }
}

export function encodeDomain(domain: ProtectionDomain): JsonObject {
    return { kind: domain.kind, label: domain.label, secretPolicy: domain.secretPolicy };
}

export function domainKey(domain: ProtectionDomain): string {
    return authorityKey("domain", [encodeDomain(domain)]);
}

function immutableDomain(domain: ProtectionDomain): ProtectionDomain {
    return Object.freeze(new ProtectionDomain(domain.kind, domain.label, domain.secretPolicy));
}

export function decodeDomain(value: JsonValue | undefined): ProtectionDomain {
    const object = requireObject(value, "Protection domain");
    requireExact(object, ["kind", "label", "secretPolicy"], "Protection domain");
    const kind = object["kind"];
    const secretPolicy = object["secretPolicy"];
    if (kind !== "frontend" && kind !== "backend") {
        throw new TypeError("Protection domain kind is invalid");
    }
    if (secretPolicy !== "no-secrets" && secretPolicy !== "may-hold-secrets") {
        throw new TypeError("Protection domain secret policy is invalid");
    }
    return new ProtectionDomain(
        kind,
        requireString(object, "label", "Protection domain label"),
        secretPolicy
    );
}

function requireBindingState(value: JsonValue | undefined): BindingStateName {
    if (value === "active" || value === "inactive") return value;
    throw new TypeError("Binding state is invalid");
}
