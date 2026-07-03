const MIN_SLATE_SCHEMA_VERSION_LENGTH = 1;
const MAX_SLATE_SCHEMA_VERSION_LENGTH = 128;

export function requireSlateSchemaVersion(schemaVersion: string, subject: string): void {
    if (
        schemaVersion.length < MIN_SLATE_SCHEMA_VERSION_LENGTH
        || schemaVersion.length > MAX_SLATE_SCHEMA_VERSION_LENGTH
    ) {
        throw new TypeError(`${subject} must contain between 1 and 128 characters`);
    }
}
