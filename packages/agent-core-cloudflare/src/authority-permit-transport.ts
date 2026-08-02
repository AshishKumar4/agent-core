import type { ActorRef, Digest, SynchronousResultGuard } from "@agent-core/core";
import { requireSynchronousResult } from "@agent-core/core";
import type {
    AuthorityPermitExpectation,
    AuthorityPermitOwnerStore
} from "@agent-core/core/authority";
import {
    AuthorityPermit,
    AuthorityPermitAuthenticator,
    AuthorityPermitIssuedRecordSource
} from "@agent-core/core/authority";
import type { CloudflareErrorPort } from "./error.js";
import { operationalFailure } from "./error.js";
import type { ActorNamespaceLocation, DurableObjectNamespaceLike } from "./namespace.js";
import { locateActorObject } from "./namespace.js";

/**
 * The RPC surface a Tenant Actor's Durable Object exposes for permit
 * authentication: given a nonce, return the canonical issued-record bytes from
 * the Tenant's own permit store, or undefined when no such issuance exists.
 */
export interface PermitIssuerObjectStub {
    issuedPermitRecord(nonce: string): Promise<Uint8Array | undefined>;
}

/**
 * Serves a Tenant Durable Object's issued permit records to targets. The record
 * comes from the Tenant's own store inside the Tenant's own object — the
 * authoritative issuance evidence a target authenticates against.
 */
export class PermitIssuerDurableObjectHost<Transaction> {
    public constructor(private readonly store: AuthorityPermitOwnerStore<Transaction>) {}

    public issuedPermitRecord(nonce: string): Uint8Array | undefined {
        if (typeof nonce !== "string" || nonce.length === 0) return undefined;
        return this.store.transaction((transaction) => {
            const permit = this.store.issued(transaction, nonce);
            if (permit === undefined) return undefined;
            return AuthorityPermit.encode(permit);
        });
    }
}

/**
 * Authenticates permits against the issuing Tenant's Durable Object. The stub
 * address derives from the issuer reference the TARGET computes for its own
 * Tenant — never from caller-supplied permit fields — so a permit naming any
 * other issuer resolves to the wrong object and finds no issuance record:
 * transport establishes issuer identity (C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING).
 */
export class DurableObjectPermitRecordSource<
    ObjectId,
    Stub extends PermitIssuerObjectStub
> extends AuthorityPermitIssuedRecordSource {
    public constructor(
        private readonly namespace: DurableObjectNamespaceLike<ObjectId, Stub>,
        private readonly tenantIssuer: ActorRef,
        private readonly errors: CloudflareErrorPort,
        private readonly location: ActorNamespaceLocation = {}
    ) {
        super();
    }

    public async issued(
        issuer: ActorRef,
        nonce: string,
        _digest: Digest
    ): Promise<Uint8Array | undefined> {
        if (!issuer.equals(this.tenantIssuer)) {
            // A permit naming a foreign issuer never reaches a foreign object;
            // the target only ever consults its own Tenant's issuance store.
            return undefined;
        }
        const stub = locateActorObject(
            this.namespace,
            { kind: this.tenantIssuer.kind, id: this.tenantIssuer.id },
            this.errors,
            this.location
        );
        const record = await stub.issuedPermitRecord(nonce);
        if (record === undefined || record === null) return undefined;
        if (!(record instanceof Uint8Array)) {
            operationalFailure(
                this.errors,
                "operation.invalid-output",
                "Tenant permit issuance record transport returned invalid bytes"
            );
        }
        return record;
    }
}

/**
 * Target-owned permit admission (C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION).
 * Authentication against the issuing Tenant's Durable Object happens first and
 * alone on the asynchronous side; the expectation match, single-use nonce
 * consumption, validity window, and the EffectAttempt append then execute in
 * ONE synchronous SQLite span with no intervening await (§8.5), so a restart,
 * replay, or rollback either admits the attempt with its consumed nonce or
 * leaves both absent.
 */
export class DurableObjectPermitAdmission<Transaction> {
    readonly #authenticator: AuthorityPermitAuthenticator;

    public constructor(
        private readonly store: AuthorityPermitOwnerStore<Transaction>,
        source: AuthorityPermitIssuedRecordSource
    ) {
        this.#authenticator = new AuthorityPermitAuthenticator(source);
    }

    public async admit<Result>(
        permit: AuthorityPermit,
        expected: AuthorityPermitExpectation,
        now: Date,
        appendEffectAttempt: (transaction: Transaction) => Result,
        ...guard: SynchronousResultGuard<Result>
    ): Promise<Result> {
        const authentication = await this.#authenticator.authenticate(permit, expected);
        return this.store.transaction((transaction) => {
            this.store.consume(transaction, authentication, permit, expected, now);
            return requireSynchronousResult(appendEffectAttempt(transaction));
        }, ...guard);
    }
}
