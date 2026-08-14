import { requireSynchronousResult, type ActorRef, type SynchronousResultGuard } from "../actors";
import { Digest } from "../core";
import { AgentCoreError } from "../errors";
import type { AuthorityCheckEvidence } from "./evidence";
import { AuthorityPermit, AuthorityPermitExpectation } from "./permit";
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
    consumed(transaction: Transaction, nonce: string): Digest | undefined;
    request(
        transaction: Transaction,
        request: TargetAuthorityPermitRequest
    ): TargetAuthorityPermitRequest;
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
    readonly version: 2;
    readonly requested: readonly { readonly nonce: string; readonly bytes: Uint8Array }[];
    readonly issued: readonly { readonly nonce: string; readonly bytes: Uint8Array }[];
    readonly consumed: readonly { readonly nonce: string; readonly bytes: Uint8Array }[];
}

export class MemoryAuthorityPermitTransaction {
    public constructor(
        readonly ownerToken: MemoryAuthorityPermitOwner,
        readonly requestedRecords: Map<string, Uint8Array>,
        readonly issuedRecords: Map<string, Uint8Array>,
        readonly consumedRecords: Map<string, Uint8Array>
    ) {}
}

class MemoryAuthorityPermitOwner {}

export class MemoryAuthorityPermitStore
    implements
        AuthorityPermitTargetStore<MemoryAuthorityPermitTransaction>,
        AuthorityPermitIssueStore<MemoryAuthorityPermitTransaction>
{
    readonly #ownerToken = Object.freeze(new MemoryAuthorityPermitOwner());
    #requested = new Map<string, Uint8Array>();
    #issued = new Map<string, Uint8Array>();
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
        const transaction = new MemoryAuthorityPermitTransaction(
            this.#ownerToken,
            cloneBytesMap(this.#requested),
            cloneBytesMap(this.#issued),
            cloneBytesMap(this.#consumed)
        );
        const result = requireSynchronousResult(operation(transaction));
        this.#requested = transaction.requestedRecords;
        this.#issued = transaction.issuedRecords;
        this.#consumed = transaction.consumedRecords;
        return result;
    }

    public issued(
        transaction: MemoryAuthorityPermitTransaction,
        nonce: string
    ): AuthorityPermit | undefined {
        this.requireTransaction(transaction);
        const bytes = transaction.issuedRecords.get(nonce);
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
        this.requireTransaction(transaction);
        const bytes = transaction.requestedRecords.get(nonce);
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
        this.requireTransaction(transaction);
        const bytes = transaction.consumedRecords.get(nonce);
        if (bytes === undefined) return undefined;
        return this.decodeConsumed(transaction, nonce, bytes).digest();
    }

    public request(
        transaction: MemoryAuthorityPermitTransaction,
        request: TargetAuthorityPermitRequest
    ): TargetAuthorityPermitRequest {
        this.requireTransaction(transaction);
        this.assertRequestedOwner(request);
        const existing = this.requested(transaction, request.nonce);
        if (existing !== undefined) {
            if (!existing.digest().equals(request.digest())) {
                throw denied("Authority permit nonce is bound to another target request");
            }
            return existing;
        }
        this.requireUnused(transaction, request.nonce);
        transaction.requestedRecords.set(
            request.nonce,
            TargetAuthorityPermitRequest.encode(request)
        );
        return request;
    }

    public issue(
        transaction: MemoryAuthorityPermitTransaction,
        permit: AuthorityPermit
    ): AuthorityPermit {
        this.requireTransaction(transaction);
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
        if (transaction.consumedRecords.has(permit.nonce)) {
            throw denied("Authority permit nonce was already used by this Actor owner");
        }
        transaction.issuedRecords.set(permit.nonce, AuthorityPermit.encode(permit));
        return permit;
    }

    public consume(
        transaction: MemoryAuthorityPermitTransaction,
        authentication: AuthenticatedAuthorityPermit,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void {
        this.requireTransaction(transaction);
        requireAuthenticatedAuthorityPermit(authentication, permit);
        if (!permit.target.actor.equals(this.owner)) {
            throw denied("Authority permit targets another Actor owner");
        }
        permit.assertConsumable(expected, now);
        this.requireRequestedExpectation(transaction, permit.nonce, expected, permit);
        if (transaction.consumedRecords.has(permit.nonce)) {
            throw denied("Authority permit nonce was already used by this Actor owner");
        }
        transaction.consumedRecords.set(permit.nonce, AuthorityPermit.encode(permit));
    }

    public snapshot(): MemoryAuthorityPermitSnapshot {
        return {
            version: 2,
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
            consumed: Object.freeze(
                [...this.#consumed]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([nonce, bytes]) => Object.freeze({ nonce, bytes: bytes.slice() }))
            )
        };
    }

    private restore(snapshot: MemoryAuthorityPermitSnapshot): void {
        if (
            snapshot.version !== 2 ||
            !Array.isArray(snapshot.requested) ||
            !Array.isArray(snapshot.issued) ||
            !Array.isArray(snapshot.consumed)
        )
            throw corrupt();
        const transaction = new MemoryAuthorityPermitTransaction(
            this.#ownerToken,
            new Map(),
            new Map(),
            new Map()
        );
        for (const record of snapshot.requested) {
            if (!isRequestedPermitRecord(record) || transaction.requestedRecords.has(record.nonce))
                throw corrupt();
            const request = TargetAuthorityPermitRequest.decode(record.bytes.slice());
            this.assertRequestedOwner(request);
            if (request.nonce !== record.nonce) throw corrupt();
            transaction.requestedRecords.set(
                record.nonce,
                TargetAuthorityPermitRequest.encode(request)
            );
        }
        for (const record of snapshot.issued) {
            if (!isIssuedPermitRecord(record) || transaction.issuedRecords.has(record.nonce))
                throw corrupt();
            const permit = AuthorityPermit.decode(record.bytes.slice());
            this.assertIssuedOwner(permit);
            if (permit.nonce !== record.nonce) throw corrupt();
            transaction.issuedRecords.set(record.nonce, AuthorityPermit.encode(permit));
        }
        for (const record of snapshot.consumed) {
            if (!isConsumedPermitRecord(record) || transaction.consumedRecords.has(record.nonce))
                throw corrupt();
            transaction.consumedRecords.set(record.nonce, record.bytes.slice());
            this.decodeConsumed(transaction, record.nonce, record.bytes);
        }
        for (const nonce of transaction.issuedRecords.keys()) {
            if (transaction.requestedRecords.has(nonce) || transaction.consumedRecords.has(nonce))
                throw corrupt();
        }
        for (const nonce of transaction.consumedRecords.keys()) {
            if (!transaction.requestedRecords.has(nonce)) throw corrupt();
        }
        this.#requested = transaction.requestedRecords;
        this.#issued = transaction.issuedRecords;
        this.#consumed = transaction.consumedRecords;
    }

    private requireTransaction(transaction: MemoryAuthorityPermitTransaction): void {
        if (
            !(transaction instanceof MemoryAuthorityPermitTransaction) ||
            transaction.ownerToken !== this.#ownerToken
        )
            throw new TypeError("Authority permit transaction belongs to another owner store");
    }

    private requireUnused(transaction: MemoryAuthorityPermitTransaction, nonce: string): void {
        if (
            transaction.requestedRecords.has(nonce) ||
            transaction.issuedRecords.has(nonce) ||
            transaction.consumedRecords.has(nonce)
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
            if (transaction.issuedRecords.has(nonce) || transaction.consumedRecords.has(nonce)) {
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
