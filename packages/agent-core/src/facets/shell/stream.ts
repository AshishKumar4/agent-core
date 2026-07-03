import type { InputStream, OutputStream } from "./types";

/**
 * Buffered stdout/stderr. Collects writes into an array and joins on read —
 * avoids quadratic string concatenation for commands that emit many small chunks.
 */
export class BufferedOutput implements OutputStream {
	private chunks: string[] = [];

	write(text: string): void {
		if (text.length > 0) this.chunks.push(text);
	}

	read(): string {
		if (this.chunks.length === 0) return "";
		if (this.chunks.length === 1) return this.chunks.at(0) ?? "";
		const joined = this.chunks.join("");
		this.chunks = [joined];
		return joined;
	}
}

/** Resolves the upstream pipe output lazily so commands that don't read stdin don't pay for materialization. */
export class StringInput implements InputStream {
	private value: string;
	constructor(value: string) { this.value = value; }
	async readAll(): Promise<string> { return this.value; }
}
