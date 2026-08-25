/** Establishes the only structural fact shared by Worker runtime objects and stubs. */
export function isPlatformObject(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** Establishes callability without claiming an argument or return contract. */
export function isPlatformMethod(value: unknown): value is (...args: never[]) => void {
    return typeof value === "function";
}

/** Establishes the primitive number representation and excludes infinities and NaN. */
export function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

export function isText(value: unknown): value is string {
    return typeof value === "string";
}

export function isBoolean(value: unknown): value is boolean {
    return typeof value === "boolean";
}

/** Establishes that a thrown platform value carries a readable message. */
export function isPlatformMessage(value: unknown): value is { readonly message: string } {
    return isPlatformObject(value) && "message" in value && isText(value.message);
}
