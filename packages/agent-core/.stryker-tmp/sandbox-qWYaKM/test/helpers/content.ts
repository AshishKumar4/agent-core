// @ts-nocheck
import { ContentRef, Digest } from "../../src/core";

const encoder = new TextEncoder();

export function testDigest(value: string): Digest {
    return Digest.sha256(encoder.encode(value));
}

export function testContentRef(value: string): ContentRef {
    return ContentRef.fromDigest(testDigest(value));
}
