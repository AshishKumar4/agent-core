import { type ActorRef } from "../actors";
import { Digest } from "../core";
import { AgentCoreError } from "../errors";
import { AuthorityPermit, AuthorityPermitExpectation } from "./permit";

const authenticationIssuer = Symbol("authority-permit-authentication-issuer");
const issuedAuthentications = new WeakSet<object>();

export abstract class AuthorityPermitIssuedRecordSource {
    public abstract issued(
        issuer: ActorRef,
        nonce: string,
        digest: Digest
    ): Promise<Uint8Array | undefined>;
}

export class AuthenticatedAuthorityPermit {
    readonly #permit: AuthorityPermit;

    public constructor(issuer: symbol, permit: AuthorityPermit) {
        if (issuer !== authenticationIssuer) {
            throw denied("Authority permit authentication has an invalid issuer");
        }
        this.#permit = AuthorityPermit.decode(AuthorityPermit.encode(permit));
        issuedAuthentications.add(this);
        Object.freeze(this);
    }

    public matches(permit: AuthorityPermit): boolean {
        return sameBytes(AuthorityPermit.encode(this.#permit), AuthorityPermit.encode(permit));
    }
}

export class AuthorityPermitAuthenticator {
    public constructor(private readonly source: AuthorityPermitIssuedRecordSource) {}

    public async authenticate(
        candidate: AuthorityPermit,
        expected: AuthorityPermitExpectation
    ): Promise<AuthenticatedAuthorityPermit> {
        if (!candidate.expectation.equals(expected)) {
            throw denied("Authority permit does not match the target expectation");
        }
        const canonicalBytes = await this.source.issued(
            expected.issuer,
            candidate.nonce,
            candidate.digest()
        );
        if (canonicalBytes === undefined) {
            throw denied("Authority permit has no authenticated issuer record");
        }
        let canonical: AuthorityPermit;
        try {
            canonical = AuthorityPermit.decode(canonicalBytes);
        } catch {
            throw denied("Authority permit issuer record is malformed");
        }
        if (
            !canonical.expectation.equals(expected) ||
            !sameBytes(AuthorityPermit.encode(canonical), AuthorityPermit.encode(candidate))
        ) {
            throw denied("Authority permit differs from its authenticated issuer record");
        }
        return new AuthenticatedAuthorityPermit(authenticationIssuer, canonical);
    }
}

export function requireAuthenticatedAuthorityPermit(
    authentication: AuthenticatedAuthorityPermit,
    permit: AuthorityPermit
): void {
    if (
        !issuedAuthentications.has(authentication) ||
        !AuthenticatedAuthorityPermit.prototype.matches.call(authentication, permit)
    ) {
        throw denied("Authority permit lacks authenticated issuer evidence");
    }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
    );
}

function denied(message: string): AgentCoreError {
    return new AgentCoreError("authority.denied", message);
}
