import { requireSynchronousResult, type ActorRef, type SynchronousResultGuard } from "../actors";
import { Digest } from "../core";
import { AgentCoreError } from "../errors";
import type { AuthorityCheckEvidence } from "./evidence";
import { AuthorityPermit, AuthorityPermitExpectation } from "./permit";
import { TargetAuthorityPermitDenial } from "./permit-denial";
import { TargetAuthorityPermitRequest } from "./permit-request";
import {
    type AuthenticatedAuthorityPermit,
    requireAuthenticatedAuthorityPermit
} from "./permit-authentication";

export interface AuthorityPermitTransactionStore<Transaction> {
    readonly owner: ActorRef;
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
}

export interface AuthorityPermitTargetStore<
    Transaction
> extends AuthorityPermitTransactionStore<Transaction> {
    requested(transaction: Transaction, nonce: string): TargetAuthorityPermitRequest | undefined;
    denied(transaction: Transaction, nonce: string): TargetAuthorityPermitDenial | undefined;
    consumed(transaction: Transaction, nonce: string): Digest | undefined;
    request(
        transaction: Transaction,
        request: TargetAuthorityPermitRequest
    ): TargetAuthorityPermitRequest;
    deny(
        transaction: Transaction,
        denial: TargetAuthorityPermitDenial
    ): TargetAuthorityPermitDenial;
    consume(
        transaction: Transaction,
        authentication: AuthenticatedAuthorityPermit,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void;
}

export interface AuthorityPermitIssueStore<
    Transaction
> extends AuthorityPermitTransactionStore<Transaction> {
    issued(transaction: Transaction, nonce: string): AuthorityPermit | undefined;
    issue(transaction: Transaction, permit: AuthorityPermit): AuthorityPermit;
}

export class AuthorityPermitIssuer<Transaction> {
    public constructor(private readonly store: AuthorityPermitIssueStore<Transaction>) {}

    public issue(
        transaction: Transaction,
        request: TargetAuthorityPermitRequest,
        evidence: AuthorityCheckEvidence,
        issuedAt: Date
    ): AuthorityPermit {
        const issuedAtTime = issuedAt.getTime();
        if (!Number.isSafeInteger(issuedAtTime) || issuedAtTime < 0) {
            throw new TypeError("Authority permit issuance time is invalid");
        }
        if (request.expiresAt.getTime() <= issuedAtTime) {
            throw denied("Authority permit request expiry must be after issuance");
        }
        if (
            !evidence.allowed ||
            !evidence.binds(request.authority) ||
            !evidence.issuer.equals(request.expectation.issuer) ||
            !evidence.issuerTenant.equals(request.expectation.tenant) ||
            evidence.checkedAt.getTime() !== issuedAtTime ||
            !evidence.pathEpochs.equals(request.expectation.pathEpochs)
        ) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Authority permit issuance requires exact allowed Tenant evidence"
            );
        }
        const existing = this.store.issued(transaction, request.nonce);
        if (existing !== undefined) {
            if (
                !existing.expectation.equals(request.expectation) ||
                !existing.requestDigest.equals(request.digest()) ||
                existing.expiresAt.getTime() !== request.expiresAt.getTime()
            ) {
                throw denied("Authority permit nonce is bound to another issuance expectation");
            }
            return existing;
        }
        const candidate = new AuthorityPermit({
            ...request.expectation,
            nonce: request.nonce,
            requestDigest: request.digest(),
            issuedAt,
            expiresAt: request.expiresAt
        });
        return this.store.issue(transaction, candidate);
    }
}

export abstract class AuthorityPermitAdmissionPort<Transaction> {
    public abstract consume(
        transaction: Transaction,
        authentication: AuthenticatedAuthorityPermit,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void;
}

export class StoredAuthorityPermitAdmissionPort<
    Transaction
> extends AuthorityPermitAdmissionPort<Transaction> {
    public constructor(private readonly store: AuthorityPermitTargetStore<Transaction>) {
        super();
    }

    public consume(
        transaction: Transaction,
        authentication: AuthenticatedAuthorityPermit,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void {
        this.store.consume(transaction, authentication, permit, expected, now);
    }
}

export interface MemoryAuthorityPermitSnapshot {
    readonly version: 3;
    readonly requested: readonly { readonly nonce: string; readonly bytes: Uint8Array }[];
    readonly issued: readonly { readonly nonce: string; readonly bytes: Uint8Array }[];
    readonly denied: readonly { readonly nonce: string; readonly bytes: Uint8Array }[];
    readonly consumed: readonly { readonly nonce: string; readonly bytes: Uint8Array }[];
}

export class MemoryAuthorityPermitTransaction {
    public constructor() {
        Object.freeze(this);
    }
}

interface MemoryAuthorityPermitScope {
    readonly transaction: MemoryAuthorityPermitTransaction;
    readonly requested: Map<string, Uint8Array>;
    readonly issued: Map<string, Uint8Array>;
    readonly denied: Map<string, Uint8Array>;
    readonly consumed: Map<string, Uint8Array>;
}

export class MemoryAuthorityPermitStore
    implements
        AuthorityPermitTargetStore<MemoryAuthorityPermitTransaction>,
        AuthorityPermitIssueStore<MemoryAuthorityPermitTransaction>
{
    readonly #transactions = new WeakSet<MemoryAuthorityPermitTransaction>();
    #active: MemoryAuthorityPermitScope | undefined;
    #requested = new Map<string, Uint8Array>();
    #issued = new Map<string, Uint8Array>();
    #denied = new Map<string, Uint8Array>();
    #consumed = new Map<string, Uint8Array>();

    public constructor(
        public readonly owner: ActorRef,
        snapshot?: MemoryAuthorityPermitSnapshot
    ) {
        if (snapshot !== undefined) this.restore(snapshot);
    }

    public transaction<Result>(
        operation: (transaction: MemoryAuthorityPermitTransaction) => Result,
        ..._guard: SynchronousResultGuard<Result>
    ): Result {
        if (this.#active !== undefined) {
            throw new AgentCoreError(
                "protocol.invalid-state",
                "Nested authority permit transactions are not supported"
            );
        }
        const transaction = new MemoryAuthorityPermitTransaction();
        const scope: MemoryAuthorityPermitScope = {
            transaction,
            requested: cloneBytesMap(this.#requested),
            issued: cloneBytesMap(this.#issued),
            denied: cloneBytesMap(this.#denied),
            consumed: cloneBytesMap(this.#consumed)
        };
        this.#transactions.add(transaction);
        this.#active = scope;
        try {
            const result = requireSynchronousResult(operation(transaction));
            this.#requested = cloneBytesMap(scope.requested);
            this.#issued = cloneBytesMap(scope.issued);
            this.#denied = cloneBytesMap(scope.denied);
            this.#consumed = cloneBytesMap(scope.consumed);
            return result;
        } finally {
            this.#active = undefined;
        }
    }

    public issued(
        transaction: MemoryAuthorityPermitTransaction,
        nonce: string
    ): AuthorityPermit | undefined {
        const bytes = this.requireTransaction(transaction).issued.get(nonce);
        if (bytes === undefined) return undefined;
        const permit = AuthorityPermit.decode(bytes.slice());
        this.assertIssuedOwner(permit);
        if (permit.nonce !== nonce) throw corrupt();
        return permit;
    }

    public requested(
        transaction: MemoryAuthorityPermitTransaction,
        nonce: string
    ): TargetAuthorityPermitRequest | undefined {
        const bytes = this.requireTransaction(transaction).requested.get(nonce);
        if (bytes === undefined) return undefined;
        const request = TargetAuthorityPermitRequest.decode(bytes.slice());
        this.assertRequestedOwner(request);
        if (request.nonce !== nonce) throw corrupt();
        return request;
    }

    public consumed(
        transaction: MemoryAuthorityPermitTransaction,
        nonce: string
    ): Digest | undefined {
        const bytes = this.requireTransaction(transaction).consumed.get(nonce);
        if (bytes === undefined) return undefined;
        return this.decodeConsumed(transaction, nonce, bytes).digest();
    }

    public denied(
        transaction: MemoryAuthorityPermitTransaction,
        nonce: string
    ): TargetAuthorityPermitDenial | undefined {
        const bytes = this.requireTransaction(transaction).denied.get(nonce);
        if (bytes === undefined) return undefined;
        return this.decodeDenied(transaction, nonce, bytes);
    }

    public request(
        transaction: MemoryAuthorityPermitTransaction,
        request: TargetAuthorityPermitRequest
    ): TargetAuthorityPermitRequest {
        const scope = this.requireTransaction(transaction);
        this.assertRequestedOwner(request);
        const existing = this.requested(transaction, request.nonce);
        if (existing !== undefined) {
            if (!existing.digest().equals(request.digest())) {
                throw denied("Authority permit nonce is bound to another target request");
            }
            return existing;
        }
        this.requireUnused(transaction, request.nonce);
        scope.requested.set(request.nonce, TargetAuthorityPermitRequest.encode(request));
        return request;
    }

    public deny(
        transaction: MemoryAuthorityPermitTransaction,
        denial: TargetAuthorityPermitDenial
    ): TargetAuthorityPermitDenial {
        const scope = this.requireTransaction(transaction);
        this.assertRequestedOwner(denial.request);
        const request = this.requested(transaction, denial.request.nonce);
        if (request === undefined || !request.digest().equals(denial.request.digest())) {
            throw denied("Authority denial does not match its exact durable target request");
        }
        const existing = this.denied(transaction, denial.request.nonce);
        if (existing !== undefined) {
            if (!existing.digest().equals(denial.digest())) {
                throw denied("Authority permit nonce is bound to another Tenant denial");
            }
            return existing;
        }
        if (scope.consumed.has(denial.request.nonce)) {
            throw denied("Authority permit nonce was already consumed by this Actor owner");
        }
        scope.denied.set(denial.request.nonce, TargetAuthorityPermitDenial.encode(denial));
        return denial;
    }

    public issue(
        transaction: MemoryAuthorityPermitTransaction,
        permit: AuthorityPermit
    ): AuthorityPermit {
        const scope = this.requireTransaction(transaction);
        this.assertIssuedOwner(permit);
        const existing = this.issued(transaction, permit.nonce);
        if (existing !== undefined) {
            if (
                !existing.expectation.equals(permit.expectation) ||
                !existing.requestDigest.equals(permit.requestDigest)
            ) {
                throw denied("Authority permit nonce is bound to another issuance expectation");
            }
            return existing;
        }
        if (scope.consumed.has(permit.nonce)) {
            throw denied("Authority permit nonce was already used by this Actor owner");
        }
        scope.issued.set(permit.nonce, AuthorityPermit.encode(permit));
        return permit;
    }

    public consume(
        transaction: MemoryAuthorityPermitTransaction,
        authentication: AuthenticatedAuthorityPermit,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void {
        const scope = this.requireTransaction(transaction);
        requireAuthenticatedAuthorityPermit(authentication, permit);
        if (!permit.target.actor.equals(this.owner)) {
            throw denied("Authority permit targets another Actor owner");
        }
        permit.assertConsumable(expected, now);
        this.requireRequestedExpectation(transaction, permit.nonce, expected, permit);
        if (scope.denied.has(permit.nonce)) {
            throw denied("Authority permit request was denied by its Tenant");
        }
        if (scope.consumed.has(permit.nonce)) {
            throw denied("Authority permit nonce was already used by this Actor owner");
        }
        scope.consumed.set(permit.nonce, AuthorityPermit.encode(permit));
    }

    public snapshot(): MemoryAuthorityPermitSnapshot {
        return {
            version: 3,
            requested: Object.freeze(
                [...this.#requested]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([nonce, bytes]) => Object.freeze({ nonce, bytes: bytes.slice() }))
            ),
            issued: Object.freeze(
                [...this.#issued]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([nonce, bytes]) => Object.freeze({ nonce, bytes: bytes.slice() }))
            ),
            denied: Object.freeze(
                [...this.#denied]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([nonce, bytes]) => Object.freeze({ nonce, bytes: bytes.slice() }))
            ),
            consumed: Object.freeze(
                [...this.#consumed]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([nonce, bytes]) => Object.freeze({ nonce, bytes: bytes.slice() }))
            )
        };
    }

    private restore(snapshot: MemoryAuthorityPermitSnapshot): void {
        if (
            snapshot.version !== 3 ||
            !Array.isArray(snapshot.requested) ||
            !Array.isArray(snapshot.issued) ||
            !Array.isArray(snapshot.denied) ||
            !Array.isArray(snapshot.consumed)
        )
            throw corrupt();
        const requested = new Map<string, Uint8Array>();
        const issued = new Map<string, Uint8Array>();
        const denials = new Map<string, Uint8Array>();
        const consumed = new Map<string, Uint8Array>();
        for (const record of snapshot.requested) {
            if (!isRequestedPermitRecord(record) || requested.has(record.nonce)) throw corrupt();
            const request = TargetAuthorityPermitRequest.decode(record.bytes.slice());
            this.assertRequestedOwner(request);
            if (request.nonce !== record.nonce) throw corrupt();
            requested.set(record.nonce, TargetAuthorityPermitRequest.encode(request));
        }
        for (const record of snapshot.issued) {
            if (!isIssuedPermitRecord(record) || issued.has(record.nonce)) throw corrupt();
            const permit = AuthorityPermit.decode(record.bytes.slice());
            this.assertIssuedOwner(permit);
            if (permit.nonce !== record.nonce) throw corrupt();
            issued.set(record.nonce, AuthorityPermit.encode(permit));
        }
        for (const record of snapshot.denied) {
            if (!isDeniedPermitRecord(record) || denials.has(record.nonce)) throw corrupt();
            const denial = TargetAuthorityPermitDenial.decode(record.bytes.slice());
            this.assertRequestedOwner(denial.request);
            if (denial.request.nonce !== record.nonce) throw corrupt();
            denials.set(record.nonce, TargetAuthorityPermitDenial.encode(denial));
        }
        for (const record of snapshot.consumed) {
            if (!isConsumedPermitRecord(record) || consumed.has(record.nonce)) throw corrupt();
            consumed.set(record.nonce, record.bytes.slice());
        }
        for (const nonce of issued.keys()) {
            if (requested.has(nonce) || denials.has(nonce) || consumed.has(nonce)) throw corrupt();
        }
        for (const [nonce, bytes] of denials) {
            const denial = TargetAuthorityPermitDenial.decode(bytes.slice());
            const requestBytes = requested.get(nonce);
            const request =
                requestBytes === undefined
                    ? undefined
                    : TargetAuthorityPermitRequest.decode(requestBytes.slice());
            if (
                request === undefined ||
                consumed.has(nonce) ||
                !denial.request.digest().equals(request.digest())
            ) {
                throw corrupt();
            }
        }
        for (const [nonce, bytes] of consumed) {
            const permit = AuthorityPermit.decode(bytes.slice());
            const requestBytes = requested.get(nonce);
            const request =
                requestBytes === undefined
                    ? undefined
                    : TargetAuthorityPermitRequest.decode(requestBytes.slice());
            if (
                request === undefined ||
                permit.nonce !== nonce ||
                !permit.target.actor.equals(this.owner) ||
                !permit.expectation.equals(request.expectation) ||
                !permit.requestDigest.equals(request.digest())
            ) {
                throw corrupt();
            }
        }
        this.#requested = cloneBytesMap(requested);
        this.#issued = cloneBytesMap(issued);
        this.#denied = cloneBytesMap(denials);
        this.#consumed = cloneBytesMap(consumed);
    }

    private requireTransaction(
        transaction: MemoryAuthorityPermitTransaction
    ): MemoryAuthorityPermitScope {
        if (
            !(transaction instanceof MemoryAuthorityPermitTransaction) ||
            !this.#transactions.has(transaction)
        ) {
            throw new TypeError("Authority permit transaction belongs to another owner store");
        }
        if (this.#active?.transaction !== transaction) {
            throw new AgentCoreError(
                "actor.closed",
                "Authority permit transaction is no longer active"
            );
        }
        return this.#active;
    }

    private requireUnused(transaction: MemoryAuthorityPermitTransaction, nonce: string): void {
        const scope = this.requireTransaction(transaction);
        if (
            scope.requested.has(nonce) ||
            scope.issued.has(nonce) ||
            scope.denied.has(nonce) ||
            scope.consumed.has(nonce)
        )
            throw denied("Authority permit nonce was already used by this Actor owner");
    }

    private requireRequestedExpectation(
        transaction: MemoryAuthorityPermitTransaction,
        nonce: string,
        expected: AuthorityPermitExpectation,
        permit: AuthorityPermit
    ): void {
        const request = this.requested(transaction, nonce);
        if (request === undefined) {
            const scope = this.requireTransaction(transaction);
            if (scope.issued.has(nonce) || scope.consumed.has(nonce)) {
                this.requireUnused(transaction, nonce);
            }
            throw denied("Authority permit has no durable target request");
        }
        if (!request.expectation.equals(expected)) {
            throw denied("Authority permit does not match its exact target request");
        }
        if (!permit.requestDigest.equals(request.digest())) {
            throw denied("Authority permit was issued for another target request");
        }
    }

    private decodeConsumed(
        transaction: MemoryAuthorityPermitTransaction,
        expectedNonce: string,
        bytes: Uint8Array
    ): AuthorityPermit {
        const permit = AuthorityPermit.decode(bytes.slice());
        const request = this.requested(transaction, expectedNonce);
        if (
            request === undefined ||
            permit.nonce !== expectedNonce ||
            !permit.target.actor.equals(this.owner) ||
            !permit.expectation.equals(request.expectation) ||
            !permit.requestDigest.equals(request.digest())
        ) {
            throw corrupt();
        }
        return permit;
    }

    private decodeDenied(
        transaction: MemoryAuthorityPermitTransaction,
        expectedNonce: string,
        bytes: Uint8Array
    ): TargetAuthorityPermitDenial {
        const denial = TargetAuthorityPermitDenial.decode(bytes.slice());
        const request = this.requested(transaction, expectedNonce);
        if (
            request === undefined ||
            denial.request.nonce !== expectedNonce ||
            !denial.request.digest().equals(request.digest()) ||
            !denial.request.expectation.target.actor.equals(this.owner)
        ) {
            throw corrupt();
        }
        return denial;
    }

    private assertIssuedOwner(permit: AuthorityPermit): void {
        if (!permit.issuer.equals(this.owner)) {
            throw denied("Authority permit was issued by another Actor owner");
        }
    }

    private assertRequestedOwner(request: TargetAuthorityPermitRequest): void {
        if (!request.expectation.target.actor.equals(this.owner)) {
            throw denied("Authority permit request targets another Actor owner");
        }
    }
}

function isRequestedPermitRecord(
    value: unknown
): value is MemoryAuthorityPermitSnapshot["requested"][number] {
    return isStoredBytesRecord(value);
}

function isIssuedPermitRecord(
    value: unknown
): value is MemoryAuthorityPermitSnapshot["issued"][number] {
    return isStoredBytesRecord(value);
}

function isDeniedPermitRecord(
    value: unknown
): value is MemoryAuthorityPermitSnapshot["denied"][number] {
    return isStoredBytesRecord(value);
}

function isStoredBytesRecord(
    value: unknown
): value is { readonly nonce: string; readonly bytes: Uint8Array } {
    return (
        value !== null &&
        typeof value === "object" &&
        "nonce" in value &&
        typeof value.nonce === "string" &&
        "bytes" in value &&
        value.bytes instanceof Uint8Array
    );
}

function isConsumedPermitRecord(
    value: unknown
): value is MemoryAuthorityPermitSnapshot["consumed"][number] {
    return isStoredBytesRecord(value);
}

function cloneBytesMap(source: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
    return new Map([...source].map(([key, bytes]) => [key, bytes.slice()]));
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}

function corrupt(): AgentCoreError {
    return new AgentCoreError("codec.invalid", "Stored authority permit ownership is malformed");
}
