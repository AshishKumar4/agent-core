import type { ActorRef } from "../actors";
import {
    Digest,
    Revision,
    decodeCanonicalJson,
    encodeCanonicalJson,
    hasExactJsonKeys,
    type JsonValue
} from "../core";
import { MaterializationPlan } from "../definition";
import type { TenantId } from "../identity";
import { AgentCoreError } from "../errors";
import type { CurrentLease, ProtocolCommand } from "./dispatcher";
import type { CommandCaller, CommandEnvelope } from "./envelope";
import { CommandPayloadMalformedError, type CommandPayloadCodec } from "./payload";
import { CommandCallerPolicy } from "./policy";

export const MATERIALIZATION_COMMANDS = Object.freeze({
    applyLocal: "materialization.applyLocal"
});

export interface MaterializationApplyLocalPayload {
    readonly planId: Digest;
}

export interface MaterializationCommandBackend<Transaction, Read> {
    loadPlan(read: Read, planId: Digest): MaterializationPlan | undefined;
    loadPlanForApply(transaction: Transaction, planId: Digest): MaterializationPlan | undefined;
    currentRevision(read: Read, target: ActorRef, plan: MaterializationPlan): Revision | undefined;
    permitsApply(read: Read, target: ActorRef, plan: MaterializationPlan): boolean;
    applyLocal(
        transaction: Transaction,
        target: ActorRef,
        plan: MaterializationPlan,
        at: Date
    ): Uint8Array;
}

export class MaterializationApplyLocalCommand<Transaction, Read> implements ProtocolCommand<
    Transaction,
    Read
> {
    public readonly command = MATERIALIZATION_COMMANDS.applyLocal;
    public readonly caller: CommandCallerPolicy;
    public readonly expectedRevision = "required" as const;
    public readonly lease = "forbidden" as const;
    public readonly payload: CommandPayloadCodec;

    public constructor(
        private readonly backend: MaterializationCommandBackend<Transaction, Read>,
        private readonly target: ActorRef,
        private readonly controller: ActorRef,
        private readonly tenant: TenantId
    ) {
        if (controller.kind !== "tenant") {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Materialization controller must be a Tenant Actor"
            );
        }
        this.caller = new ExactActorCallerPolicy(controller);
        this.payload = new MaterializationApplyLocalPayloadCodec();
    }

    public authorize(_read: Read, envelope: CommandEnvelope, payload: unknown): boolean {
        const planId = requireApplyLocalPayload(payload).planId;
        const plan = this.backend.loadPlan(_read, planId);
        return (
            callerIsTarget(envelope.caller, this.controller) &&
            plan !== undefined &&
            storedPlanTargets(plan, planId, this.target, this.tenant)
        );
    }

    public permitsLifecycle(read: Read, _envelope: CommandEnvelope, payload: unknown): boolean {
        const decoded = requireApplyLocalPayload(payload);
        const plan = this.backend.loadPlan(read, decoded.planId);
        const canonical =
            plan === undefined
                ? undefined
                : canonicalTargetPlan(plan, decoded.planId, this.target, this.tenant);
        return canonical !== undefined && this.backend.permitsApply(read, this.target, canonical);
    }

    public currentRevision(
        read: Read,
        _envelope: CommandEnvelope,
        payload: unknown
    ): Revision | undefined {
        const decoded = requireApplyLocalPayload(payload);
        const plan = this.backend.loadPlan(read, decoded.planId);
        const canonical =
            plan === undefined
                ? undefined
                : canonicalTargetPlan(plan, decoded.planId, this.target, this.tenant);
        return canonical === undefined
            ? undefined
            : this.backend.currentRevision(read, this.target, canonical);
    }

    public currentLease(
        _read: Read,
        _envelope: CommandEnvelope,
        _payload: unknown,
        _at: Date
    ): CurrentLease | undefined {
        return undefined;
    }

    public execute(
        transaction: Transaction,
        _envelope: CommandEnvelope,
        payload: unknown,
        at: Date
    ): Uint8Array {
        const planId = requireApplyLocalPayload(payload).planId;
        const plan = this.backend.loadPlanForApply(transaction, planId);
        if (plan === undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Persisted local materialization plan is missing or has a foreign target"
            );
        }
        const canonical = requireCanonicalTargetPlan(plan, planId, this.target, this.tenant);
        return this.backend.applyLocal(transaction, this.target, canonical, at);
    }
}

export const MaterializationCommandPayload = Object.freeze({
    applyLocal(planId: Digest): Uint8Array {
        return encodeCanonicalJson({ planId: planId.value });
    }
});

class ExactActorCallerPolicy extends CommandCallerPolicy {
    public constructor(private readonly target: ActorRef) {
        super();
    }

    public admits(caller: CommandCaller): boolean {
        return callerIsTarget(caller, this.target);
    }
}

class MaterializationApplyLocalPayloadCodec implements CommandPayloadCodec {
    public decode(bytes: Uint8Array): MaterializationApplyLocalPayload {
        let decoded: JsonValue;
        try {
            decoded = decodeCanonicalJson(bytes);
        } catch {
            throw new CommandPayloadMalformedError(
                "Local materialization payload must be canonical JSON"
            );
        }
        const object = requirePayloadObject(decoded);
        if (!hasExactJsonKeys(object, ["planId"])) {
            throw new CommandPayloadMalformedError(
                "Local materialization payload contains missing or unknown fields"
            );
        }
        const planId = object["planId"];
        if (typeof planId !== "string") {
            throw new CommandPayloadMalformedError(
                "Local materialization plan ID must be a digest"
            );
        }
        try {
            return Object.freeze({ planId: new Digest(planId) });
        } catch {
            throw new CommandPayloadMalformedError(
                "Local materialization plan ID must be a digest"
            );
        }
    }
}

function requireApplyLocalPayload(payload: unknown): MaterializationApplyLocalPayload {
    if (
        payload === null ||
        typeof payload !== "object" ||
        !((payload as { readonly planId?: unknown }).planId instanceof Digest)
    ) {
        throw new TypeError("Local materialization payload was not decoded");
    }
    return payload as MaterializationApplyLocalPayload;
}

function canonicalTargetPlan(
    plan: MaterializationPlan,
    id: Digest,
    target: ActorRef,
    tenant: TenantId
): MaterializationPlan | undefined {
    try {
        return requireCanonicalTargetPlan(plan, id, target, tenant);
    } catch {
        return undefined;
    }
}

function storedPlanTargets(
    plan: MaterializationPlan,
    id: Digest,
    target: ActorRef,
    tenant: TenantId
): boolean {
    return (
        plan.id.equals(id) &&
        plan.actors.length === 1 &&
        plan.actors[0]!.actor.equals(target) &&
        plan.origin.tenantId.equals(tenant)
    );
}

function requireCanonicalTargetPlan(
    plan: MaterializationPlan,
    id: Digest,
    target: ActorRef,
    tenant: TenantId
): MaterializationPlan {
    const canonical = MaterializationPlan.decode(MaterializationPlan.encode(plan));
    if (
        !canonical.id.equals(id) ||
        canonical.actors.length !== 1 ||
        !canonical.actors[0]!.actor.equals(target) ||
        !canonical.origin.tenantId.equals(tenant)
    ) {
        throw new AgentCoreError(
            "protocol.invalid-state",
            "Persisted local materialization plan is missing or has a foreign target"
        );
    }
    return canonical;
}

function requirePayloadObject(value: JsonValue): { readonly [key: string]: JsonValue } {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw new CommandPayloadMalformedError("Local materialization payload must be an object");
    }
    return value as { readonly [key: string]: JsonValue };
}

function callerIsTarget(caller: CommandCaller, target: ActorRef): boolean {
    return caller.kind === "actor" && caller.actor.equals(target);
}
