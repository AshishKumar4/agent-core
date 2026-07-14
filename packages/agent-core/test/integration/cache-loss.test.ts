import { ContentRef, Digest } from "../../src/core";
import {
    InMemoryMemoryIndexBackend,
    MemoryEntry,
    type MemoryContentBackend
} from "../../src/facets";
import { expect, test } from "vitest";

test("[C13-ADV-CACHE-LOSS] rebuilds a lost derived index from canonical content", () => {
    const reference = ContentRef.fromDigest(Digest.sha256(new TextEncoder().encode("canonical")));
    const entry = new MemoryEntry("memory", reference, "scope.read", 1);
    const content: MemoryContentBackend = {
        resolve: (candidate) => (candidate.equals(reference) ? { text: "recoverable value" } : null)
    };

    const lost = new InMemoryMemoryIndexBackend();
    expect(lost.search("recoverable")).toEqual([]);
    const rebuilt = lost.replace([entry], content);
    expect(rebuilt.search("recoverable")).toEqual([entry.id]);
});
