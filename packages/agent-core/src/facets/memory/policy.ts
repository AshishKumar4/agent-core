export const DEFAULT_MEMORY_INDEXED_PREFIXES = ["memory/", "sessions/", "identity.md"] as const;
export const DEFAULT_MEMORY_EXCLUDED_PREFIXES = ["sandbox/", "shared/", "cloudflare/"] as const;

export interface MemoryPathPolicy {
	curatedFile?: string;
	memoryDir?: string;
	indexedPrefixes?: readonly string[];
	indexedFiles?: readonly string[];
	excludedPrefixes?: readonly string[];
}

export function normalizeMemoryPath(path: string): string {
	return path.replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/+$/, "");
}

export function isExcludedMemoryPath(path: string, policy?: MemoryPathPolicy): boolean {
	const normalized = normalizeMemoryPath(path);
	const excludedPrefixes = policy?.excludedPrefixes ?? DEFAULT_MEMORY_EXCLUDED_PREFIXES;
	return excludedPrefixes.some((prefix) => normalized.startsWith(prefix))
		|| normalized === "sandbox"
		|| normalized === "shared"
		|| normalized === "cloudflare";
}

export function shouldIndexMemoryPath(path: string, policy?: MemoryPathPolicy): boolean {
	const normalized = normalizeMemoryPath(path);
	if (isExcludedMemoryPath(normalized, policy)) return false;
	if ((policy?.indexedFiles ?? []).includes(normalized)) return true;
	const indexedPrefixes = policy?.indexedPrefixes ?? DEFAULT_MEMORY_INDEXED_PREFIXES;
	return indexedPrefixes.some((prefix) => {
		const normalizedPrefix = normalizeMemoryPath(prefix);
		return prefix.endsWith("/") ? normalized.startsWith(`${normalizedPrefix}/`) : normalized === normalizedPrefix;
	});
}

export function isIndexableMemoryFile(path: string, policy?: MemoryPathPolicy): boolean {
	const normalized = normalizeMemoryPath(path);
	if (!shouldIndexMemoryPath(normalized, policy)) return false;
	return normalized.endsWith(".md") || (policy?.indexedFiles ?? []).includes(normalized);
}

export function memoryPathDateKey(path: string): string {
	return path.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

export function sortMemoryIndexPaths(paths: string[], policy?: MemoryPathPolicy): string[] {
	const curatedFile = policy?.curatedFile ?? "memory/MEMORY.md";
	const memoryDir = policy?.memoryDir ?? "memory";
	return [...new Set(paths.map(normalizeMemoryPath).filter(Boolean))].sort((a, b) => {
		const ca = memoryPathCategory(a, curatedFile, memoryDir);
		const cb = memoryPathCategory(b, curatedFile, memoryDir);
		if (ca !== cb) return ca - cb;

		const da = memoryPathDateKey(a);
		const db = memoryPathDateKey(b);
		if (da || db) {
			const dateCompare = db.localeCompare(da);
			if (dateCompare !== 0) return dateCompare;
		}

		return a.localeCompare(b);
	});
}

function memoryPathCategory(path: string, curatedFile: string, memoryDir: string): number {
	if (path === curatedFile) return 0;
	if (path === "identity.md") return 1;
	if (path === "soul.md") return 2;
	if (memoryPathDateKey(path)) return 3;
	if (path.startsWith("sessions/")) return 4;
	if (path.startsWith(`${memoryDir}/`)) return 5;
	return 6;
}
