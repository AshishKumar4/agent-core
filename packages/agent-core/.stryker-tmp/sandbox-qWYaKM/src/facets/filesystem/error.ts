// @ts-nocheck
import { DetailedProfileError } from "../profile-runtime";

export type FilesystemErrorCode =
    "not-found" | "exists" | "not-a-directory" | "is-a-directory" | "path.invalid" | "too-large";

export const FILESYSTEM_ERROR_CODES: readonly FilesystemErrorCode[] = Object.freeze([
    "not-found",
    "exists",
    "not-a-directory",
    "is-a-directory",
    "path.invalid",
    "too-large"
]);

export class FilesystemError extends DetailedProfileError<FilesystemErrorCode> {
    public constructor(
        code: FilesystemErrorCode,
        public readonly path: string,
        message: string
    ) {
        if (!FILESYSTEM_ERROR_CODES.includes(code)) {
            throw new TypeError("Filesystem error code is outside the fixed profile set");
        }
        super("operation.invalid-input", code, message);
        this.name = "FilesystemError";
    }
}
