/** Bytes per `String.fromCharCode` call: spreading a whole payload overflows the stack. */
const CHUNK_BYTES = 8_192;

export function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_BYTES));
    }
    return btoa(binary);
}
