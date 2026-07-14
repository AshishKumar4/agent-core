import { FilesystemError } from "./error";

export function normalizeFilesystemPath(value: string): string {
    if (
        value.length === 0 ||
        !value.startsWith("/") ||
        value.includes("\\") ||
        value.includes("\0")
    ) {
        throw invalidPath(value);
    }

    const segments: string[] = [];
    for (const segment of value.split("/")) {
        if (segment.length === 0 || segment === ".") continue;
        if (segment === "..") {
            if (segments.pop() === undefined) throw invalidPath(value);
            continue;
        }
        segments.push(segment);
    }
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function filesystemParent(path: string): string {
    const normalized = normalizeFilesystemPath(path);
    if (normalized === "/") return "/";
    const separator = normalized.lastIndexOf("/");
    return separator === 0 ? "/" : normalized.slice(0, separator);
}

function invalidPath(path: string): FilesystemError {
    return new FilesystemError(
        "path.invalid",
        path,
        "Path escapes or is outside the filesystem root"
    );
}
