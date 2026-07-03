export class FilePath {
    readonly #segments: readonly string[];
    readonly #value: string;

    private constructor(segments: readonly string[]) {
        this.#segments = Object.freeze([...segments]);
        this.#value = segments.join("/");
    }

    public static root(): FilePath {
        return new FilePath([]);
    }

    public static parse(value: string): FilePath {
        if (value === "") {
            return FilePath.root();
        }

        if (
            value.startsWith("/") ||
            value.endsWith("/") ||
            value.includes("\\") ||
            value.includes("\0")
        ) {
            throw new TypeError(`Invalid file path: ${value}`);
        }

        const segments = value.split("/");

        if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
            throw new TypeError(`Invalid file path: ${value}`);
        }

        return new FilePath(segments);
    }

    public get root(): boolean {
        return this.#segments.length === 0;
    }

    public child(name: string): FilePath {
        if (
            name === "" ||
            name === "." ||
            name === ".." ||
            name.includes("/") ||
            name.includes("\\") ||
            name.includes("\0")
        ) {
            throw new TypeError(`Invalid file name: ${name}`);
        }

        return new FilePath([...this.#segments, name]);
    }

    public parts(): readonly string[] {
        return this.#segments;
    }

    public first(): string | null {
        return this.#segments[0] ?? null;
    }

    public append(path: FilePath): FilePath {
        return new FilePath([...this.#segments, ...path.#segments]);
    }

    public relativeTo(parent: FilePath): FilePath {
        if (!this.startsWith(parent)) {
            throw new RangeError(`${this} is not within ${parent}`);
        }

        return new FilePath(this.#segments.slice(parent.#segments.length));
    }

    public parent(): FilePath {
        if (this.root) {
            return this;
        }

        return new FilePath(this.#segments.slice(0, -1));
    }

    public equals(other: FilePath): boolean {
        return this.#value === other.#value;
    }

    public startsWith(other: FilePath): boolean {
        if (other.#segments.length > this.#segments.length) {
            return false;
        }

        return other.#segments.every(
            (segment, index) => this.#segments[index] === segment
        );
    }

    public toString(): string {
        return this.#value;
    }
}
