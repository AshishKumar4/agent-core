/**
 * MIME-based binary detection for our shell commands.
 *
 * Adapted from LIFO OS (`packages/core/src/utils/mime.ts`, MIT-licensed) —
 * trimmed to the extensions we actually encounter in agent workspaces.
 * We intentionally err on the side of "text" — the default for unknown
 * extensions is `text/plain` so `.env`, dotfiles without an extension, and
 * anything else opaque is still grep'able.
 */

const MIME_BY_EXT = new Map<string, string>([
	// Text / source
	[".txt", "text/plain"], [".md", "text/markdown"], [".json", "application/json"],
	[".js", "text/javascript"], [".mjs", "text/javascript"], [".cjs", "text/javascript"],
	[".ts", "text/typescript"], [".jsx", "text/jsx"], [".tsx", "text/tsx"],
	[".css", "text/css"], [".scss", "text/css"], [".sass", "text/css"], [".less", "text/css"],
	[".html", "text/html"], [".htm", "text/html"], [".xml", "text/xml"],
	[".yaml", "text/yaml"], [".yml", "text/yaml"], [".toml", "text/toml"],
	[".ini", "text/plain"], [".cfg", "text/plain"], [".conf", "text/plain"],
	[".sh", "text/x-shellscript"], [".bash", "text/x-shellscript"], [".zsh", "text/x-shellscript"],
	[".py", "text/x-python"], [".rb", "text/x-ruby"], [".go", "text/x-go"], [".rs", "text/x-rust"],
	[".c", "text/x-c"], [".cpp", "text/x-c++"], [".h", "text/x-c"], [".hpp", "text/x-c++"],
	[".java", "text/x-java"], [".kt", "text/x-kotlin"], [".swift", "text/x-swift"],
	[".csv", "text/csv"], [".tsv", "text/tab-separated-values"],
	[".log", "text/plain"], [".env", "text/plain"],
	[".sql", "text/x-sql"], [".graphql", "text/x-graphql"],
	[".vue", "text/x-vue"], [".svelte", "text/x-svelte"],
	[".lean", "text/plain"],
	// Binary
	[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
	[".gif", "image/gif"], [".webp", "image/webp"], [".ico", "image/x-icon"],
	[".bmp", "image/bmp"], [".tiff", "image/tiff"],
	[".mp4", "video/mp4"], [".webm", "video/webm"], [".mov", "video/quicktime"],
	[".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".ogg", "audio/ogg"],
	[".zip", "application/zip"], [".tar", "application/x-tar"], [".gz", "application/gzip"],
	[".pdf", "application/pdf"], [".wasm", "application/wasm"],
	[".exe", "application/x-msdownload"], [".dll", "application/x-msdownload"],
	[".so", "application/x-sharedlib"], [".dylib", "application/x-sharedlib"],
]);

/** Treat SVG as text (it IS text/XML) even though its MIME is "image/svg+xml". */
const TEXT_MIMES = new Set(["application/json", "application/xml", "image/svg+xml"]);

export function getMimeType(filename: string): string {
	// Dotfiles with no extension (".env", ".gitignore") → use whole name
	const slash = filename.lastIndexOf("/");
	const base = slash === -1 ? filename : filename.slice(slash + 1);
	if (base.startsWith(".") && !base.slice(1).includes(".")) {
		return MIME_BY_EXT.get(base.toLowerCase()) ?? "text/plain";
	}
	const dot = base.lastIndexOf(".");
	if (dot === -1 || dot === 0) return "text/plain"; // no extension → assume text
	const ext = base.slice(dot).toLowerCase();
	return MIME_BY_EXT.get(ext) ?? "application/octet-stream";
}

export function isBinaryFile(filename: string): boolean {
	const mime = getMimeType(filename);
	if (mime.startsWith("text/")) return false;
	if (TEXT_MIMES.has(mime)) return false;
	return true;
}
