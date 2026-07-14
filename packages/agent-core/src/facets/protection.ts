const MIN_PROTECTION_DOMAIN_LABEL_LENGTH = 1;
const MAX_PROTECTION_DOMAIN_LABEL_LENGTH = 128;

export type ProtectionDomainKind = "frontend" | "backend";

export type ProtectionDomainSecretPolicy = "no-secrets" | "may-hold-secrets";

export class ProtectionDomain {
    public constructor(
        public readonly kind: ProtectionDomainKind,
        public readonly label: string,
        public readonly secretPolicy: ProtectionDomainSecretPolicy
    ) {
        if (
            label.length < MIN_PROTECTION_DOMAIN_LABEL_LENGTH ||
            label.length > MAX_PROTECTION_DOMAIN_LABEL_LENGTH
        ) {
            throw new TypeError(
                "Protection domain label must contain between 1 and 128 characters"
            );
        }

        if (kind === "frontend" && secretPolicy === "may-hold-secrets") {
            throw new TypeError("Frontend protection domains cannot hold secrets");
        }
    }

    public get canHoldSecrets(): boolean {
        return this.secretPolicy === "may-hold-secrets";
    }

    public equals(other: ProtectionDomain): boolean {
        return (
            this.kind === other.kind &&
            this.label === other.label &&
            this.secretPolicy === other.secretPolicy
        );
    }
}
