import { FilesystemError } from "./error";
import { DetailedProfileError } from "../profile-runtime";
import {
    FilesystemBackend,
    FilesystemTargetState,
    FilesystemWriteMode,
    type FilesystemPage,
    type FilesystemReadRange,
    type FilesystemStat
} from "./facet";
import { filesystemParent, normalizeFilesystemPath } from "./path";

interface MemoryNode {
    readonly kind: "file" | "directory";
    readonly content?: Uint8Array;
    readonly modifiedAt: number;
}

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

export class MemoryFilesystemBackend extends FilesystemBackend {
    readonly #nodes = new Map<string, MemoryNode>();
    readonly #maxFileBytes: number;
    #clock = 0;

    public constructor(maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
        super();
        if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) {
            throw new TypeError("Maximum file size must be a non-negative safe integer");
        }
        this.#maxFileBytes = maxFileBytes;
        this.#nodes.set("/", { kind: "directory", modifiedAt: this.tick() });
    }

    public read(path: string, range: FilesystemReadRange = {}): Uint8Array {
        const normalized = normalizeFilesystemPath(path);
        const node = this.node(normalized);
        if (node.kind === "directory")
            throw fileError("is-a-directory", normalized, "Cannot read a directory");
        const content = node.content!;
        const offset = range.offset ?? 0;
        const length = range.length;
        if (
            !isNonNegativeInteger(offset) ||
            (length !== undefined && !isNonNegativeInteger(length))
        ) {
            throw invalidInput("Read range values must be non-negative safe integers");
        }
        if (offset >= content.byteLength) return new Uint8Array();
        const available = content.byteLength - offset;
        const count = length === undefined ? available : Math.min(length, available);
        return content.slice(offset, offset + count);
    }

    public stat(path: string): FilesystemStat {
        const normalized = normalizeFilesystemPath(path);
        return this.toStat(normalized, this.node(normalized));
    }

    public list(path: string, cursor?: string, limit = 100): FilesystemPage {
        const normalized = normalizeFilesystemPath(path);
        this.directory(normalized);
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw invalidInput("List limit must be positive");
        }
        const prefix = normalized === "/" ? "/" : `${normalized}/`;
        const entries = [...this.#nodes.entries()]
            .filter(
                ([candidate]) =>
                    candidate !== normalized &&
                    candidate.startsWith(prefix) &&
                    !candidate.slice(prefix.length).includes("/")
            )
            .map(([candidate, node]) => this.toStat(candidate, node))
            .sort((left, right) => left.path.localeCompare(right.path));
        const normalizedCursor = cursor === undefined ? undefined : normalizeFilesystemPath(cursor);
        const start =
            normalizedCursor === undefined
                ? 0
                : entries.findIndex((entry) => entry.path > normalizedCursor);
        const pageStart = start < 0 ? entries.length : start;
        const pageEntries = entries.slice(pageStart, pageStart + limit);
        const next =
            pageStart + pageEntries.length < entries.length ? pageEntries.at(-1)?.path : undefined;
        const page = { entries: Object.freeze(pageEntries) };
        return Object.freeze(next === undefined ? page : { ...page, cursor: next });
    }

    public write(
        path: string,
        content: Uint8Array,
        mode: FilesystemWriteMode = FilesystemWriteMode.upsert
    ): void {
        const normalized = this.mutablePath(path);
        if (content.byteLength > this.#maxFileBytes) {
            throw fileError("too-large", normalized, "File exceeds the configured size limit");
        }
        const parent = filesystemParent(normalized);
        this.directory(parent);
        const existing = this.#nodes.get(normalized);
        if (existing?.kind === "directory")
            throw fileError("is-a-directory", normalized, "Path is a directory");
        // The comparison and the replacement occupy one step: nothing runs between reading
        // the node and setting it, so a guard cannot pass against content it did not replace.
        mode.requireWritable(
            normalized,
            existing === undefined
                ? FilesystemTargetState.absent
                : FilesystemTargetState.present(existing.content!)
        );
        this.#nodes.set(normalized, {
            kind: "file",
            content: content.slice(),
            modifiedAt: this.tick()
        });
    }

    public remove(path: string): void {
        const normalized = this.mutablePath(path);
        this.node(normalized);
        const prefix = `${normalized}/`;
        for (const candidate of this.#nodes.keys()) {
            if (candidate === normalized || candidate.startsWith(prefix))
                this.#nodes.delete(candidate);
        }
    }

    public move(source: string, destination: string): void {
        const normalizedSource = this.mutablePath(source);
        const normalizedDestination = this.mutablePath(destination);
        const sourceNode = this.node(normalizedSource);
        if (normalizedSource === normalizedDestination) return;
        if (this.#nodes.has(normalizedDestination)) {
            throw fileError("exists", normalizedDestination, "Destination already exists");
        }
        if (
            sourceNode.kind === "directory" &&
            normalizedDestination.startsWith(`${normalizedSource}/`)
        ) {
            throw fileError(
                "path.invalid",
                normalizedDestination,
                "Cannot move a directory into itself"
            );
        }
        this.directory(filesystemParent(normalizedDestination));

        const prefix = `${normalizedSource}/`;
        const moved = [...this.#nodes.entries()].filter(
            ([candidate]) => candidate === normalizedSource || candidate.startsWith(prefix)
        );
        for (const [candidate] of moved) this.#nodes.delete(candidate);
        for (const [candidate, node] of moved) {
            this.#nodes.set(
                `${normalizedDestination}${candidate.slice(normalizedSource.length)}`,
                node
            );
        }
    }

    public mkdir(path: string, recursive = false): void {
        const normalized = normalizeFilesystemPath(path);
        if (normalized === "/") return;
        const existing = this.#nodes.get(normalized);
        if (existing !== undefined) {
            if (existing.kind === "directory")
                throw fileError("exists", normalized, "Directory already exists");
            throw fileError("not-a-directory", normalized, "Path is not a directory");
        }
        const missing: string[] = [];
        let candidate = normalized;
        while (!this.#nodes.has(candidate)) {
            missing.push(candidate);
            candidate = filesystemParent(candidate);
        }
        this.directory(candidate);
        if (!recursive && missing.length > 1) {
            throw fileError(
                "not-found",
                filesystemParent(normalized),
                "Parent directory does not exist"
            );
        }
        for (const directory of missing.reverse()) {
            this.#nodes.set(directory, { kind: "directory", modifiedAt: this.tick() });
        }
    }

    private mutablePath(path: string): string {
        const normalized = normalizeFilesystemPath(path);
        if (normalized === "/")
            throw fileError("path.invalid", normalized, "Filesystem root cannot be mutated");
        return normalized;
    }

    private node(path: string): MemoryNode {
        const node = this.#nodes.get(path);
        if (node === undefined) throw fileError("not-found", path, "Path does not exist");
        return node;
    }

    private directory(path: string): MemoryNode {
        const node = this.node(path);
        if (node.kind !== "directory")
            throw fileError("not-a-directory", path, "Path is not a directory");
        return node;
    }

    private toStat(path: string, node: MemoryNode): FilesystemStat {
        return Object.freeze({
            path,
            kind: node.kind,
            size: node.content?.byteLength ?? 0,
            modifiedAt: node.modifiedAt
        });
    }

    private tick(): number {
        this.#clock += 1;
        return this.#clock;
    }
}

function isNonNegativeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function fileError(
    code: ConstructorParameters<typeof FilesystemError>[0],
    path: string,
    message: string
): FilesystemError {
    return new FilesystemError(code, path, message);
}

function invalidInput(message: string): DetailedProfileError<"operation.invalid-input"> {
    return new DetailedProfileError("operation.invalid-input", "operation.invalid-input", message);
}
