function invalidDefinition(message: string): Error {
    return new Error(message);
}

export function taxonomyShadow(): never {
    throw invalidDefinition("shadowed");
}
