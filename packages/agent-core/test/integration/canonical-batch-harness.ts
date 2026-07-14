import { ActorId, ActorRef } from "../../src/actors";
import { MemoryContentStore } from "../../src/content";
import { ContentRef, Digest, JsonSchema, SemVer, encodeCanonicalJson } from "../../src/core";
import { PackageId } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import { FacetRef, OperationDescriptor, OperationName, OperationRef } from "../../src/facets";
import { TenantId } from "../../src/identity";
import {
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    AuthorityAdmissionReference,
    CanonicalBatchInvocationPort,
    ClaimWorkerId,
    CorrelationId,
    EffectAttempt,
    EffectAttemptId,
    InvocationId,
    InvocationLedger,
    InvocationPlacementPin,
    ItemClaim,
    ItemClaimId,
    MemoryInvocationMediationPersistence,
    MemoryInvocationPersistence,
    OperationPin,
    PreEffectReceipt,
    PreparedInvocation,
    ReceiptId,
    cloneInvocationMediationMemoryState,
    cloneInvocationMemoryState,
    createInvocationMediationMemoryState,
    createInvocationMemoryState,
    type CanonicalBatchAuthorityPermitPort,
    type CanonicalBatchFinalAdmissionPort,
    type CanonicalBatchInvocationRequest,
    type CanonicalBatchRecordPort,
    type InvocationMediationMemoryState,
    type InvocationMemoryState,
    type InvocationTransactionPort,
    type Receipt
} from "../../src/invocations";
import {
    admissionFor,
    createLedger,
    invocationCodecs,
    preparedReferenceCodecs
} from "../invocations/fixture";

export type CanonicalBatchHarnessState = InvocationMemoryState & InvocationMediationMemoryState;

export const canonicalBatchFacet = new FacetRef("workspace:target");
export const canonicalBatchDescriptor = new OperationDescriptor(
    new OperationName("send"),
    "externalSend",
    new JsonSchema({}),
    new JsonSchema({})
);

export class CanonicalBatchMemoryTransactions implements InvocationTransactionPort<CanonicalBatchHarnessState> {
    #state: CanonicalBatchHarnessState = createState();
    public active = false;

    public transact<Result>(
        operation: (transaction: CanonicalBatchHarnessState) => Result
    ): Result {
        const draft = cloneState(this.#state);
        this.active = true;
        try {
            const result = operation(draft);
            this.#state = cloneState(draft);
            return result;
        } finally {
            this.active = false;
        }
    }

    public restart(): void {
        this.#state = cloneState(this.#state);
    }
}

export class CanonicalBatchPreparation<Authorization> {
    public lease: string | undefined;
    public override:
        | ((
              request: CanonicalBatchInvocationRequest<Authorization>,
              prepared: PreparedInvocation<string, string, string, string>
          ) => PreparedInvocation<string, string, string, string>)
        | undefined;

    public constructor(
        private readonly approvalRequired: boolean,
        private readonly facet: FacetRef = canonicalBatchFacet,
        private readonly descriptor: OperationDescriptor = canonicalBatchDescriptor
    ) {}

    public prepare(request: CanonicalBatchInvocationRequest<Authorization>) {
        const prepared = this.create(
            request.invocation,
            request.request.inputs,
            request.request.shape.kind
        );
        return this.override?.(request, prepared) ?? prepared;
    }

    public create(
        invocation: InvocationId,
        inputs: readonly unknown[],
        shape: "single" | "batch" = "batch"
    ) {
        const placement = new InvocationPlacementPin({
            manifest: ["provider"],
            policy: ["provider"],
            substrate: ["provider"],
            trust: ["provider"],
            selected: "provider"
        });
        if (inputs.length === 0) throw new TypeError("Canonical test payload must not be empty");
        return PreparedInvocation.create(
            {
                id: invocation,
                operation: OperationPin.create({
                    operation: new OperationRef(`canonical-package:${this.descriptor.name.value}`),
                    target: this.facet.value,
                    package: new PackageId("canonical-package"),
                    version: new SemVer("1.0.0"),
                    manifestDigest: digest("manifest"),
                    descriptorDigest: Digest.sha256(encodeCanonicalJson(this.descriptor.toData())),
                    configurationDigest: digest("configuration"),
                    runtimeDigest: digest("runtime"),
                    activationGeneration: "generation",
                    registration: "registration",
                    impact: this.descriptor.impact,
                    approvalRequired: this.approvalRequired,
                    placement
                }),
                domain: `domain:${invocation.value}`,
                actor: new ActorRef("run", new ActorId(`actor:${invocation.value}`)),
                authority: `authority:${invocation.value}`,
                pathEpochs: `epochs:${invocation.value}`,
                auditCause: new AuditRecordId(`audit:${invocation.value}`),
                idempotencySeed: `seed:${invocation.value}`,
                ...(this.lease === undefined ? {} : { lease: this.lease })
            },
            shape === "single"
                ? { kind: "single", item: inputs[0] as never }
                : { kind: "batch", items: inputs as [never, ...never[]] },
            preparedReferenceCodecs
        );
    }
}

class Permits implements CanonicalBatchAuthorityPermitPort<string, string, string, string, string> {
    public readonly invalidItems = new Set<number>();
    public readonly deniedItems = new Set<number>();
    public readonly claimedBeforeIssue: number[] = [];
    public issuedInsideTargetTransaction = false;
    public crashOnce = false;
    public onIssue: (() => Promise<void>) | undefined;

    public constructor(
        private readonly transactions: CanonicalBatchMemoryTransactions,
        private readonly persistence: MemoryInvocationPersistence<
            string,
            string,
            string,
            string,
            string
        >
    ) {}

    public async issue(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        claim: ItemClaim<string>
    ) {
        this.issuedInsideTargetTransaction ||= this.transactions.active;
        const persisted = this.transactions.transact((transaction) =>
            this.persistence.claim(transaction, claim.id)
        );
        if (persisted === undefined)
            throw new TypeError("claim was not durable before permit issue");
        this.claimedBeforeIssue.push(claim.itemIndex);
        await this.onIssue?.();
        if (this.crashOnce) {
            this.crashOnce = false;
            throw new TypeError("permit transport crash");
        }
        if (this.deniedItems.has(claim.itemIndex)) {
            throw new AgentCoreError("authority.denied", "permit denied");
        }
        return this.invalidItems.has(claim.itemIndex)
            ? new AuthorityAdmissionReference("invalid-permit", digest("invalid-permit"))
            : admissionFor(invocation.header.id.value, claim.itemIndex, claim.attemptOrdinal);
    }
}

class Records implements CanonicalBatchRecordPort<string, string, string, string, string> {
    public createdClaims = 0;
    public substituteReceiptCause = false;

    public claim(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        itemIndex: number,
        previous: ItemClaim<string> | undefined,
        now: Date
    ): ItemClaim<string> {
        this.createdClaims += 1;
        const worker = new ClaimWorkerId(`worker:${this.createdClaims}`);
        const owner =
            invocation.header.lease === undefined
                ? { kind: "system" as const, actor: invocation.header.actor, worker }
                : { kind: "executor" as const, token: invocation.header.lease, worker };
        return previous === undefined
            ? new ItemClaim(
                  new ItemClaimId(`claim:${invocation.header.id.value}:${itemIndex}:0`),
                  invocation.header.id,
                  itemIndex,
                  0,
                  owner,
                  new Date(now.getTime() + 1_000)
              )
            : previous.recover(
                  new ItemClaimId(`claim:${invocation.header.id.value}:${itemIndex}:recovered`),
                  owner,
                  new Date(now.getTime() + 1_000),
                  now
              );
    }

    public attempt(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        claim: ItemClaim<string>,
        admission: AuthorityAdmissionReference<string>,
        now: Date
    ): EffectAttempt<string, string> {
        return new EffectAttempt<string, string>(
            new EffectAttemptId(
                `attempt:${invocation.header.id.value}:${claim.itemIndex}:${claim.attemptOrdinal}`
            ),
            invocation.header.id,
            claim.itemIndex,
            claim.attemptOrdinal,
            claim.id,
            undefined,
            admission,
            now,
            invocation.item(claim.itemIndex).idempotencyKey,
            invocation.header.auditCause
        );
    }

    public attemptAudit(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        attempt: EffectAttempt<string, string>
    ) {
        return audit(invocation, `audit:${attempt.id.value}`, attempt.auditCause, {
            kind: "attempt",
            id: attempt.id
        });
    }

    public preEffectReceipt(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        claim: ItemClaim<string>,
        recordedAt: Date,
        reason: string
    ): PreEffectReceipt {
        return new PreEffectReceipt(
            new ReceiptId(`receipt:${invocation.header.id.value}:${claim.itemIndex}:denied`),
            invocation.header.id,
            claim.itemIndex,
            "deniedPreEffect",
            recordedAt,
            reason
        );
    }

    public attemptReceipt(
        attempt: EffectAttempt<string, string>,
        outcome: "succeeded" | "failed" | "indeterminate",
        recordedAt: Date,
        result: ContentRef | undefined
    ): AttemptReceipt {
        return new AttemptReceipt(
            new ReceiptId(`receipt:${attempt.id.value}:${outcome}`),
            attempt.id,
            outcome,
            undefined,
            recordedAt,
            result
        );
    }

    public receiptAudit(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        cause: AuditRecord | undefined,
        receipt: Receipt
    ) {
        return audit(
            invocation,
            `audit:${receipt.id.value}`,
            this.substituteReceiptCause && cause !== undefined
                ? new AuditRecordId("substituted-attempt-audit")
                : (cause?.id ?? invocation.header.auditCause),
            { kind: "receipt", id: receipt.id, outcome: receipt.outcome }
        );
    }
}

class FinalAdmissions {
    public result:
        | { readonly kind: "admitted"; readonly evidence?: unknown }
        | { readonly kind: "denied"; readonly reason: string } = { kind: "admitted" };
    public decide:
        | ((
              request: CanonicalBatchInvocationRequest<unknown>,
              context: {
                  readonly invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>;
              }
          ) => typeof this.result)
        | undefined;

    public admit(
        _transaction: CanonicalBatchHarnessState,
        request: CanonicalBatchInvocationRequest<unknown>,
        context: { readonly invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]> }
    ) {
        return this.decide?.(request, context) ?? this.result;
    }
}

export class CanonicalBatchHarness<Authorization = string> {
    public readonly transactions = new CanonicalBatchMemoryTransactions();
    public readonly persistence = new MemoryInvocationPersistence(invocationCodecs);
    public readonly evidence = new MemoryInvocationMediationPersistence();
    public readonly ledger: InvocationLedger<
        CanonicalBatchHarnessState,
        string,
        string,
        string,
        string,
        string
    > = createLedger(this.persistence);
    public readonly preparation: CanonicalBatchPreparation<Authorization>;
    public readonly permits = new Permits(this.transactions, this.persistence);
    public readonly records = new Records();
    public readonly finalAdmissions = new FinalAdmissions();
    public readonly content = new MemoryContentStore();
    public readonly executions: number[] = [];
    public failResourcesOnce = false;
    public readonly port: CanonicalBatchInvocationPort<
        Authorization,
        CanonicalBatchHarnessState,
        string,
        string,
        string,
        string,
        string
    >;
    #time = 2_000;

    public constructor(
        approvalRequired: boolean,
        facet: FacetRef = canonicalBatchFacet,
        descriptor: OperationDescriptor = canonicalBatchDescriptor,
        finalAdmission?: CanonicalBatchFinalAdmissionPort<
            CanonicalBatchHarnessState,
            Authorization,
            string,
            string,
            string,
            string,
            string
        >
    ) {
        this.preparation = new CanonicalBatchPreparation(approvalRequired, facet, descriptor);
        this.port = new CanonicalBatchInvocationPort<
            Authorization,
            CanonicalBatchHarnessState,
            string,
            string,
            string,
            string,
            string
        >(
            this.transactions,
            this.persistence,
            this.ledger,
            this.preparation,
            this.permits,
            this.records,
            finalAdmission ?? this.finalAdmissions,
            this.evidence,
            {
                resources: () => {
                    if (this.failResourcesOnce) {
                        this.failResourcesOnce = false;
                        throw new TypeError("resource crash");
                    }
                    return { signal: new AbortController().signal, content: this.content };
                }
            },
            () => new Date(this.#time++)
        );
    }

    public setTime(value: number): void {
        this.#time = value;
    }
}

function createState(): CanonicalBatchHarnessState {
    return { ...createInvocationMemoryState(), ...createInvocationMediationMemoryState() };
}

function cloneState(state: CanonicalBatchHarnessState): CanonicalBatchHarnessState {
    return {
        ...cloneInvocationMemoryState(state),
        ...cloneInvocationMediationMemoryState(state)
    };
}

function audit(
    invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
    id: string,
    cause: AuditRecordId,
    kind: ConstructorParameters<typeof AuditRecord>[0]["kind"]
): AuditRecord {
    return new AuditRecord({
        id: new AuditRecordId(id),
        actor: invocation.header.actor,
        tenant: new TenantId("canonical-tenant"),
        correlation: new CorrelationId(`correlation:${invocation.header.id.value}`),
        cause,
        kind
    });
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}
