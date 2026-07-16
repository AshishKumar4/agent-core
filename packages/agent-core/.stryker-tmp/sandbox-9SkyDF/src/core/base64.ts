// @ts-nocheck
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("Base64 input must be a Uint8Array");
    }
    const source = new Uint8Array(bytes);
    let encoded = "";
    for (let index = 0; index < source.length; index += 3) {
        const first = source[index]!;
        const second = source[index + 1];
        const third = source[index + 2];
        const bits = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
        encoded += alphabet[(bits >>> 18) & 63];
        encoded += alphabet[(bits >>> 12) & 63];
        encoded += second === undefined ? "=" : alphabet[(bits >>> 6) & 63];
        encoded += third === undefined ? "=" : alphabet[bits & 63];
    }
    return encoded;
}

export function decodeBase64(value: string): Uint8Array {
    if (
        typeof value !== "string" ||
        value.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
        throw new TypeError("Base64 value must use canonical RFC 4648 encoding");
    }

    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const decoded = new Uint8Array((value.length / 4) * 3 - padding);
    let output = 0;
    for (let index = 0; index < value.length; index += 4) {
        const first = decodeDigit(value[index]!);
        const second = decodeDigit(value[index + 1]!);
        const third = value[index + 2] === "=" ? 0 : decodeDigit(value[index + 2]!);
        const fourth = value[index + 3] === "=" ? 0 : decodeDigit(value[index + 3]!);
        const bits = (first << 18) | (second << 12) | (third << 6) | fourth;
        decoded[output] = (bits >>> 16) & 255;
        output += 1;
        if (output < decoded.length) {
            decoded[output] = (bits >>> 8) & 255;
            output += 1;
        }
        if (output < decoded.length) {
            decoded[output] = bits & 255;
            output += 1;
        }
    }
    if (encodeBase64(decoded) !== value) {
        throw new TypeError("Base64 value must use canonical RFC 4648 encoding");
    }
    return decoded;
}

function decodeDigit(value: string): number {
    const digit = alphabet.indexOf(value);
    if (digit < 0) {
        throw new TypeError("Base64 value contains an invalid digit");
    }
    return digit;
}
