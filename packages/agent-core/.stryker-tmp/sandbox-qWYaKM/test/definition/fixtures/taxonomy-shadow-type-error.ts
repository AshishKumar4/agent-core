// @ts-nocheck
class TypeError extends Error {}

export function taxonomyShadowTypeError(): never {
    throw new TypeError("shadowed global");
}
