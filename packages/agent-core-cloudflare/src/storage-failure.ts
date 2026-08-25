import type { CloudflareCapturedCause } from "./error.js";
import { isPlatformMessage, isText } from "./platform-value.js";

/**
 * The documented text a full object returns for every write while reads and DELETEs keep
 * working (https://developers.cloudflare.com/durable-objects/platform/limits/#what-happens-when-a-durable-object-exceeds-its-storage-limit).
 * The runtime reports the condition as a message and nothing else, and the same page
 * documents matching this marker as the way to reach the drain-to-recover path, so the
 * marker is the platform's contract here rather than a guess about its wording.
 */
const FULL_MARKER = "SQLITE_FULL";

/**
 * The documented text a storage operation past the platform's internal timeout returns,
 * which also resets the object
 * (https://developers.cloudflare.com/durable-objects/observability/troubleshooting/).
 */
const RESET_MARKER = "exceeded timeout";

/**
 * Why one storage call failed, in the terms a caller can act on. A full object, a reset
 * object and a refused statement are three different conditions with three different
 * recoveries, so a substrate that reports one code for all three tells a caller nothing
 * it can use.
 */
export abstract class CloudflareStorageFailure {
    /** The object holds its storage limit: writes fail, reads and DELETEs still work. */
    public static get full(): CloudflareStorageFailure {
        return fullStorage;
    }

    /** A storage call passed the platform's internal timeout, which resets the object. */
    public static get reset(): CloudflareStorageFailure {
        return resetStorage;
    }

    /** The statement itself was refused; the object is serving and its storage is intact. */
    public static get statement(): CloudflareStorageFailure {
        return statementFailure;
    }

    /**
     * Reads a thrown platform value as one of the three conditions. An unrecognized
     * throw is a refused statement, which is the reading that claims least: it neither
     * offers a drain that would not help nor a retry that would spin.
     */
    public static classify(cause: CloudflareCapturedCause): CloudflareStorageFailure {
        const thrown = cause.value;
        const message = isText(thrown)
            ? thrown
            : isPlatformMessage(thrown)
              ? thrown.message
              : undefined;
        if (message === undefined) return statementFailure;
        if (message.includes(FULL_MARKER)) return fullStorage;
        if (message.includes(RESET_MARKER)) return resetStorage;
        return statementFailure;
    }

    /** Whether deleting rows can recover this object with no deployment step. */
    public abstract get drainable(): boolean;

    /** Whether the same call may succeed on a later instance of this same object. */
    public abstract get transient(): boolean;

    /** The clause a raised failure names, so the three stay distinguishable in a log. */
    public abstract get summary(): string;

    public equals(other: CloudflareStorageFailure): boolean {
        return this === other;
    }
}

class FullStorage extends CloudflareStorageFailure {
    public get drainable(): boolean {
        return true;
    }

    public get transient(): boolean {
        return false;
    }

    public get summary(): string {
        return "storage is full, so writes fail while reads and deletes keep working";
    }
}

class ResetStorage extends CloudflareStorageFailure {
    public get drainable(): boolean {
        return false;
    }

    public get transient(): boolean {
        return true;
    }

    public get summary(): string {
        return "storage call passed the platform timeout, which reset the object";
    }
}

class StatementFailure extends CloudflareStorageFailure {
    public get drainable(): boolean {
        return false;
    }

    public get transient(): boolean {
        return false;
    }

    public get summary(): string {
        return "statement was refused, so the object is serving and its storage is intact";
    }
}

const fullStorage = new FullStorage();
const resetStorage = new ResetStorage();
const statementFailure = new StatementFailure();
