import { requireSynchronousResult, type ActorRef, type SynchronousResultGuard } from "../actors";
import { Digest } from "../core";
import { AgentCoreError } from "../errors";
import { AuthorityPermit, AuthorityPermitExpectation } from "./permit";

export interface AuthorityPermitOwnerStore<Transaction> {
    transaction<Result>(
        operation: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Result;
    issued(transaction: Transaction, nonce: string): AuthorityPermit | undefined;
    consumed(transaction: Transaction, nonce: string): Digest | undefined;
    issue(transaction: Transaction, permit: AuthorityPermit): AuthorityPermit;
    consume(
        transaction: Transaction,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void;
}

export abstract class AuthorityPermitAuthorityPort<Transaction> {
    public abstract admits(
        transaction: Transaction,
        expectation: AuthorityPermitExpectation,
        issuedAt: Date
    ): boolean;
}

export class AuthorityPermitIssuer<Transaction> {
    public constructor(
        private readonly store: AuthorityPermitOwnerStore<Transaction>,
        private readonly authority: AuthorityPermitAuthorityPort<Transaction>
    ) {}

    public issue(
        transaction: Transaction,
        expectation: AuthorityPermitExpectation,
        nonce: string,
        issuedAt: Date,
        expiresAt: Date
    ): AuthorityPermit {
        const candidate = new AuthorityPermit({ ...expectation, nonce, issuedAt, expiresAt });
        const existing = this.store.issued(transaction, candidate.nonce);
        if (existing !== undefined) {
            if (!existing.expectation.equals(candidate.expectation)) {
                throw denied("Authority permit nonce is bound to another issuance expectation");
            }
            return existing;
        }
        if (!this.authority.admits(transaction, expectation, issuedAt)) {
            throw denied("Current Tenant authority does not admit permit issuance");
        }
        return this.store.issue(transaction, candidate);
    }
}

export abstract class AuthorityPermitAdmissionPort<Transaction> {
    public abstract consume(
        transaction: Transaction,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void;
}

export class StoredAuthorityPermitAdmissionPort<
    Transaction
> extends AuthorityPermitAdmissionPort<Transaction> {
    public constructor(private readonly store: AuthorityPermitOwnerStore<Transaction>) {
        super();
    }

    public consume(
        transaction: Transaction,
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void {
        this.store.consume(transaction, permit, expected, now);
    }
}

export interface MemoryAuthorityPermitSnapshot {
    readonly version: 1;
    readonly issued: readonly { readonly nonce: string; readonly bytes: Uint8Array }[];
    readonly consumed: readonly { readonly nonce: string; readonly digest: string }[];
}

export class MemoryAuthorityPermitTransaction {
    public constructor(
        readonly ownerToken: object,
        readonly issuedRecords: Map<string, Uint8Array>,
        readonly consumedRecords: Map<string, string>
    ) {}
}

export class MemoryAuthorityPermitStore implements AuthorityPermitOwnerStore<MemoryAuthorityPermitTransaction> {
    readonly #ownerToken = Object.freeze({});
    #issued = new Map<string, Uint8Array>();
    #consumed = new Map<string, string>();

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
            cloneBytesMap(this.#issued),
            new Map(this.#consumed)
        );
        const result = requireSynchronousResult(operation(transaction));
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

    public consumed(
        transaction: MemoryAuthorityPermitTransaction,
        nonce: string
    ): Digest | undefined {
        this.requireTransaction(transaction);
        const digest = transaction.consumedRecords.get(nonce);
        return digest === undefined ? undefined : new Digest(digest);
    }

    public issue(
        transaction: MemoryAuthorityPermitTransaction,
        permit: AuthorityPermit
    ): AuthorityPermit {
        this.requireTransaction(transaction);
        this.assertIssuedOwner(permit);
        const existing = this.issued(transaction, permit.nonce);
        if (existing !== undefined) {
            if (!existing.expectation.equals(permit.expectation)) {
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
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date
    ): void {
        this.requireTransaction(transaction);
        if (!permit.target.actor.equals(this.owner)) {
            throw denied("Authority permit targets another Actor owner");
        }
        permit.assertConsumable(expected, now);
        this.requireUnused(transaction, permit.nonce);
        transaction.consumedRecords.set(permit.nonce, permit.digest().value);
    }

    public snapshot(): MemoryAuthorityPermitSnapshot {
        return {
            version: 1,
            issued: Object.freeze(
                [...this.#issued]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([nonce, bytes]) => Object.freeze({ nonce, bytes: bytes.slice() }))
            ),
            consumed: Object.freeze(
                [...this.#consumed]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([nonce, digest]) => Object.freeze({ nonce, digest }))
            )
        };
    }

    private restore(snapshot: MemoryAuthorityPermitSnapshot): void {
        if (
            snapshot.version !== 1 ||
            !Array.isArray(snapshot.issued) ||
            !Array.isArray(snapshot.consumed)
        )
            throw corrupt();
        const transaction = new MemoryAuthorityPermitTransaction(
            this.#ownerToken,
            new Map(),
            new Map()
        );
        for (const record of snapshot.issued) {
            if (
                record === null ||
                typeof record !== "object" ||
                typeof record.nonce !== "string" ||
                !(record.bytes instanceof Uint8Array) ||
                transaction.issuedRecords.has(record.nonce)
            )
                throw corrupt();
            const permit = AuthorityPermit.decode(record.bytes.slice());
            this.assertIssuedOwner(permit);
            if (permit.nonce !== record.nonce) throw corrupt();
            transaction.issuedRecords.set(record.nonce, AuthorityPermit.encode(permit));
        }
        for (const record of snapshot.consumed) {
            if (
                record === null ||
                typeof record !== "object" ||
                typeof record.nonce !== "string" ||
                typeof record.digest !== "string" ||
                transaction.consumedRecords.has(record.nonce)
            )
                throw corrupt();
            new Digest(record.digest);
            transaction.consumedRecords.set(record.nonce, record.digest);
        }
        for (const nonce of transaction.issuedRecords.keys()) {
            if (transaction.consumedRecords.has(nonce)) throw corrupt();
        }
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
        if (transaction.issuedRecords.has(nonce) || transaction.consumedRecords.has(nonce))
            throw denied("Authority permit nonce was already used by this Actor owner");
    }

    private assertIssuedOwner(permit: AuthorityPermit): void {
        if (!permit.issuer.equals(this.owner)) {
            throw denied("Authority permit was issued by another Actor owner");
        }
    }
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
