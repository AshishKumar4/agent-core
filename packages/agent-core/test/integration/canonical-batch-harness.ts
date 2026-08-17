import { ActorId, ActorRef } from "../../src/actors";
import { MemoryContentStore } from "../../src/content";
import { ContentRef, Digest, JsonSchema, SemVer, encodeCanonicalJson } from "../../src/core";
import { PackageId } from "../../src/definition";
import { AgentCoreError } from "../../src/errors";
import {
    FacetRef,
    OperationDescriptor,
    OperationName,
    OperationRef,
    isFacetData
} from "../../src/facets";
import { TenantId } from "../../src/identity";
import {
    AttemptCompletion,
    AttemptReceipt,
    AuditRecord,
    AuditRecordId,
    AuthorityAdmissionReference,
    type CanonicalBatchAttemptResources,
    type CanonicalBatchAuthorityAuthenticationPort,
    type CanonicalBatchAuthorityPermitPort,
    type CanonicalBatchFinalAdmissionPort,
    CanonicalBatchInvocationPort,
    type CanonicalBatchInvocationRequest,
    type CanonicalBatchRecordPort,
    ClaimWorkerId,
    cloneInvocationMediationMemoryState,
    cloneInvocationMemoryState,
    CorrelationId,
    createInvocationMediationMemoryState,
    createInvocationMemoryState,
    EffectAttempt,
    EffectAttemptId,
    InvocationId,
    InvocationLedger,
    type InvocationMediationMemoryState,
    type InvocationMemoryState,
    InvocationPlacementPin,
    type InvocationTransactionPort,
    ItemClaim,
    ItemClaimId,
    MemoryInvocationMediationPersistence,
    MemoryInvocationPersistence,
    OperationPin,
    PreEffectReceipt,
    PreparedInvocation,
    type Receipt,
    ReceiptId
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
    #loseCommittedResponse = false;
    public active = false;

    public transact<Result>(
        operation: (transaction: CanonicalBatchHarnessState) => Result
    ): Result {
        const draft = cloneState(this.#state);
        this.active = true;
        try {
            const result = operation(draft);
            this.#state = cloneState(draft);
            if (this.#loseCommittedResponse) {
                this.#loseCommittedResponse = false;
                throw new TypeError("transaction response was lost after commit");
            }
            return result;
        } finally {
            this.active = false;
        }
    }

    public restart(): void {
        this.#state = cloneState(this.#state);
    }

    public loseNextCommittedResponse(): void {
        this.#loseCommittedResponse = true;
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
            request.request.cardinality.kind
        );
        return this.override?.(request, prepared) ?? prepared;
    }

    public create(
        invocation: InvocationId,
        inputs: readonly unknown[],
        cardinality: "single" | "batch" = "batch"
    ) {
        const placement = new InvocationPlacementPin({
            manifest: ["provider"],
            policy: ["provider"],
            substrate: ["provider"],
            trust: ["provider"],
            selected: "provider"
        });
        const parsedInputs = inputs.map((input, itemIndex) => {
            if (!isFacetData(input)) {
                throw new TypeError(`Canonical test payload item ${itemIndex} is invalid`);
            }
            return input;
        });
        const [first, ...remaining] = parsedInputs;
        if (first === undefined) throw new TypeError("Canonical test payload must not be empty");
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
                lease: this.lease
            },
            cardinality === "single"
                ? { kind: "single", item: first }
                : { kind: "batch", items: [first, ...remaining] },
            preparedReferenceCodecs
        );
    }
}

class Permits implements CanonicalBatchAuthorityPermitPort<
    CanonicalBatchHarnessState,
    string,
    string,
    string,
    string,
    string,
    string
> {
    public readonly invalidItems = new Set<number>();
    public readonly locallyDeniedItems = new Set<number>();
    public readonly deniedItems = new Set<number>();
    public readonly claimedBeforeIssue: number[] = [];
    public issuedInsideTargetTransaction = false;
    public deniedInsideTargetTransaction = false;
    public readonly deniedClaims: ItemClaim<string>[] = [];
    public crashOnce = false;
    public onIssue:
        | ((
              claim: ItemClaim<string>
          ) => Promise<
              | { readonly kind: "denied"; readonly denial: string; readonly reason: string }
              | { readonly kind: "invalid"; readonly reason: string }
              | { readonly kind: "expired" }
              | undefined
          >)
        | undefined;
    public readonly issuedAdmissions: AuthorityAdmissionReference<string>[] = [];

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
        const decision = await this.onIssue?.(claim);
        if (decision !== undefined) return decision;
        if (this.crashOnce) {
            this.crashOnce = false;
            throw new TypeError("permit transport crash");
        }
        if (this.locallyDeniedItems.has(claim.itemIndex)) {
            return { kind: "invalid" as const, reason: "permit reply was locally invalid" };
        }
        if (this.deniedItems.has(claim.itemIndex)) {
            return { kind: "denied" as const, denial: "permit-denied", reason: "permit denied" };
        }
        const admission = this.invalidItems.has(claim.itemIndex)
            ? new AuthorityAdmissionReference("invalid-permit", digest("invalid-permit"))
            : admissionFor(invocation.header.id.value, claim.itemIndex, claim.attemptOrdinal);
        this.issuedAdmissions.push(admission);
        return { kind: "issued" as const, admission };
    }

    public deny(
        transaction: CanonicalBatchHarnessState,
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        claim: ItemClaim<string>,
        denial: string
    ): void {
        this.deniedInsideTargetTransaction ||= this.transactions.active;
        const persisted = this.persistence.claim(transaction, claim.id);
        if (
            persisted === undefined ||
            !persisted.id.equals(claim.id) ||
            persisted.itemIndex !== claim.itemIndex ||
            persisted.attemptOrdinal !== claim.attemptOrdinal ||
            !persisted.invocation.equals(invocation.header.id) ||
            denial.length === 0
        ) {
            throw new TypeError("denial does not bind the current target claim");
        }
        this.deniedClaims.push(claim);
    }
}

class PermitAuthentication implements CanonicalBatchAuthorityAuthenticationPort<
    string,
    string,
    string,
    string,
    string,
    undefined
> {
    public readonly deniedItems = new Set<number>();
    public readonly authenticatedItems: number[] = [];
    public authenticatedInsideTargetTransaction = false;
    public crashOnce = false;
    public onAuthenticate: (() => Promise<void>) | undefined;

    public constructor(private readonly transactions: CanonicalBatchMemoryTransactions) {}

    public async authenticate(
        _invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        claim: ItemClaim<string>,
        _admission: AuthorityAdmissionReference<string>
    ): Promise<undefined> {
        this.authenticatedInsideTargetTransaction ||= this.transactions.active;
        this.authenticatedItems.push(claim.itemIndex);
        await this.onAuthenticate?.();
        if (this.crashOnce) {
            this.crashOnce = false;
            throw new TypeError("permit authentication transport crash");
        }
        if (this.deniedItems.has(claim.itemIndex)) {
            throw new AgentCoreError("authority.denied", "permit authentication denied");
        }
        return undefined;
    }
}

class Records implements CanonicalBatchRecordPort<string, string, string, string, string> {
    public createdClaims = 0;
    public substituteAttemptCause = false;
    public substituteReceiptCause = false;

    public invocationAudit(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>
    ): AuditRecord {
        return audit(invocation, invocation.header.auditCause.value, undefined, {
            kind: "invocation",
            id: invocation.header.id
        });
    }

    public claim(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        itemIndex: number,
        previous: ItemClaim<string> | undefined,
        now: Date
    ): ItemClaim<string> {
        const owner = this.nextOwner(invocation);
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

    public retryClaim(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        previous: EffectAttempt<string, string>,
        now: Date
    ): ItemClaim<string> {
        const attemptOrdinal = previous.ordinal + 1;
        return new ItemClaim(
            new ItemClaimId(
                `claim:${invocation.header.id.value}:${previous.itemIndex}:retry:${attemptOrdinal}`
            ),
            invocation.header.id,
            previous.itemIndex,
            attemptOrdinal,
            this.nextOwner(invocation),
            new Date(now.getTime() + 1_000)
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
        return audit(
            invocation,
            `audit:${attempt.id.value}`,
            this.substituteAttemptCause
                ? new AuditRecordId("substituted-invocation-audit")
                : attempt.auditCause,
            {
                kind: "attempt",
                id: attempt.id
            }
        );
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
        completion: AttemptCompletion,
        recordedAt: Date,
        result: ContentRef | undefined
    ): AttemptReceipt {
        return new AttemptReceipt(
            new ReceiptId(`receipt:${attempt.id.value}:${completion.outcome}`),
            attempt.id,
            completion,
            undefined,
            recordedAt,
            result
        );
    }

    public reconciledReceipt(
        attempt: EffectAttempt<string, string>,
        previous: AttemptReceipt,
        completion: AttemptCompletion,
        result: ContentRef | undefined,
        recordedAt: Date
    ): AttemptReceipt {
        return new AttemptReceipt(
            new ReceiptId(`receipt:${attempt.id.value}:${completion.outcome}`),
            attempt.id,
            completion,
            previous.id,
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

    public receiptSupersessionAudit(
        invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>,
        previousAudit: AuditRecord,
        previous: AttemptReceipt,
        next: AttemptReceipt
    ): AuditRecord {
        return audit(
            invocation,
            `audit:supersession:${previous.id.value}:${next.id.value}`,
            previousAudit.id,
            {
                kind: "receiptSuperseded",
                previous: previous.id,
                next: next.id
            }
        );
    }

    private nextOwner(invocation: ReturnType<CanonicalBatchPreparation<unknown>["create"]>) {
        this.createdClaims += 1;
        const worker = new ClaimWorkerId(`worker:${this.createdClaims}`);
        return invocation.header.lease === undefined
            ? { kind: "system" as const, actor: invocation.header.actor, worker }
            : { kind: "executor" as const, token: invocation.header.lease, worker };
    }
}

class FinalAdmissions {
    public calls = 0;
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
        this.calls += 1;
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
        string,
        undefined
    > = createLedger(this.persistence);
    public readonly preparation: CanonicalBatchPreparation<Authorization>;
    public readonly permits = new Permits(this.transactions, this.persistence);
    public authentication: PermitAuthentication;
    public readonly records = new Records();
    public readonly finalAdmissions = new FinalAdmissions();
    public readonly content = new MemoryContentStore();
    public readonly executions: number[] = [];
    public failResourcesOnce = false;
    /**
     * The three §7.4 boundaries a host owns, each independently settable so a suite can make
     * exactly one true. They are separate fields rather than one switch because the rule under
     * test is that a kind names the boundary that actually closed, and a single knob could not
     * express two closing at once.
     */
    public attemptDeadline: Date | undefined = undefined;
    public domainAnswering = true;
    public readonly cancellation = new AbortController();
    public readonly now = (): Date => new Date(this.#time++);
    public port: CanonicalBatchInvocationPort<
        Authorization,
        CanonicalBatchHarnessState,
        string,
        string,
        string,
        string,
        string,
        undefined,
        string
    >;
    readonly #finalAdmission: CanonicalBatchFinalAdmissionPort<
        CanonicalBatchHarnessState,
        Authorization,
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
        this.#finalAdmission = finalAdmission ?? this.finalAdmissions;
        this.authentication = new PermitAuthentication(this.transactions);
        this.port = this.createRuntime();
    }

    public restartRuntime(): void {
        this.transactions.restart();
        this.authentication = new PermitAuthentication(this.transactions);
        this.port = this.createRuntime();
    }

    private createRuntime(): CanonicalBatchInvocationPort<
        Authorization,
        CanonicalBatchHarnessState,
        string,
        string,
        string,
        string,
        string,
        undefined,
        string
    > {
        return new CanonicalBatchInvocationPort<
            Authorization,
            CanonicalBatchHarnessState,
            string,
            string,
            string,
            string,
            string,
            undefined,
            string
        >(
            this.transactions,
            this.persistence,
            this.ledger,
            this.preparation,
            this.permits,
            this.authentication,
            this.records,
            this.#finalAdmission,
            this.evidence,
            {
                resources: (): CanonicalBatchAttemptResources => {
                    if (this.failResourcesOnce) {
                        this.failResourcesOnce = false;
                        throw new TypeError("resource crash");
                    }
                    return {
                        signal: this.cancellation.signal,
                        content: this.content,
                        deadline: this.attemptDeadline,
                        target: { answering: (): boolean => this.domainAnswering }
                    };
                }
            },
            this.now
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
    cause: AuditRecordId | undefined,
    kind: ConstructorParameters<typeof AuditRecord>[0]["kind"]
): AuditRecord {
    const init = {
        id: new AuditRecordId(id),
        actor: invocation.header.actor,
        tenant: new TenantId("canonical-tenant"),
        correlation: new CorrelationId(`correlation:${invocation.header.id.value}`),
        kind
    };
    return new AuditRecord(cause === undefined ? init : { ...init, cause });
}

function digest(value: string): Digest {
    return Digest.sha256(new TextEncoder().encode(value));
}
