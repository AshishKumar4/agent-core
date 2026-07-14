import { hasOnlyUnicodeScalarValues } from "./unicode";

const MAX_SECRET_COMPONENT_LENGTH = 2048;

export class SecretRef {
    public readonly source: string;
    public readonly provider: string;
    public readonly id: string;

    public constructor(source: string, provider: string, id: string) {
        this.source = requireSecretComponent(source, "source");
        this.provider = requireSecretComponent(provider, "provider");
        this.id = requireSecretComponent(id, "id");
        Object.freeze(this);
    }

    public equals(other: SecretRef): boolean {
        return (
            other instanceof SecretRef &&
            this.source === other.source &&
            this.provider === other.provider &&
            this.id === other.id
        );
    }
}

function requireSecretComponent(value: string, name: string): string {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value.length > MAX_SECRET_COMPONENT_LENGTH ||
        !hasOnlyUnicodeScalarValues(value)
    ) {
        throw new TypeError(
            `Secret reference ${name} must not be blank or exceed ${MAX_SECRET_COMPONENT_LENGTH} characters`
        );
    }
    return value;
}
