import { describe, expect, test } from "vitest";
import { decodeCanonicalJson, encodeCanonicalJson, type JsonValue } from "../../src/core";
import {
    decodeContent,
    decodeOptionalPrincipalRef,
    requireInteger
} from "../../src/workspaces/codec";
import {
    ActionId,
    ContentRetentionId,
    EventCursor,
    InboxReferenceId,
    RetainedRecordRef
} from "../../src/workspaces/id";
import { InboxEventReference } from "../../src/workspaces/inbox";
import { ContentRetentionReference } from "../../src/workspaces/retention";
import { Subscription } from "../../src/workspaces/subscription";
import { content, inboxFixture, retentionFixture, subscriptionFixture } from "./fixtures";

type JsonObject = { readonly [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return (
        value !== undefined && value !== null && !Array.isArray(value) && typeof value === "object"
    );
}

function recordPayload(bytes: Uint8Array): JsonObject {
    const envelope = decodeCanonicalJson(bytes);
    if (!isJsonObject(envelope) || !isJsonObject(envelope["payload"])) {
        throw new TypeError("Test fixture must contain an object payload");
    }
    return envelope["payload"];
}

function recordBytes(kind: string, payload: JsonValue): Uint8Array {
    return encodeCanonicalJson({ kind, payload, version: { major: 1, minor: 0 } });
}

describe("workspace codec mutation coverage", () => {
    test(
        "requireInteger accepts zero and rejects non-natural encodings exactly",
        {
            tags: "p1"
        },
        () => {
            expect(requireInteger(0, "Sequence")).toBe(0);
            expect(requireInteger(42, "Sequence")).toBe(42);
            const invalid: readonly JsonValue[] = ["7", -1, 0.5, 2 ** 53, null, true];
            for (const value of invalid) {
                expect(() => requireInteger(value, "Sequence")).toThrow(
                    expect.objectContaining({
                        message: "Sequence must be a non-negative safe integer"
                    })
                );
            }
        }
    );

    test("decodeContent reports its subject in reference and digest errors", { tags: "p2" }, () => {
        const sample = content("codec-content");
        expect(() =>
            decodeContent({ ref: 7, digest: sample.digest.value }, "Sample content")
        ).toThrow(
            expect.objectContaining({ message: "Sample content reference must be a string" })
        );
        expect(() => decodeContent({ ref: sample.ref.value, digest: 7 }, "Sample content")).toThrow(
            expect.objectContaining({ message: "Sample content digest must be a string" })
        );
    });

    test(
        "decodeOptionalPrincipalRef reports its subject in tenant and ID errors",
        {
            tags: "p2"
        },
        () => {
            expect(() =>
                decodeOptionalPrincipalRef(
                    { tenant: 7, principal: "principal-test" },
                    "Sample principal"
                )
            ).toThrow(
                expect.objectContaining({ message: "Sample principal Tenant must be a string" })
            );
            expect(() =>
                decodeOptionalPrincipalRef(
                    { tenant: "tenant-test", principal: 7 },
                    "Sample principal"
                )
            ).toThrow(expect.objectContaining({ message: "Sample principal ID must be a string" }));
        }
    );
});

describe("workspace ID mutation coverage", () => {
    test(
        "workspace ID classes report their exact subjects in constructor errors",
        {
            tags: "p2"
        },
        () => {
            expect(new ActionId("action").value).toBe("action");
            expect(() => new ActionId(" padded ")).toThrow(
                expect.objectContaining({
                    message: "Action ID must be a nonblank canonical string"
                })
            );
            expect(() => new ActionId("a".repeat(257))).toThrow(
                expect.objectContaining({
                    message: "Action ID must contain between 1 and 256 characters"
                })
            );
            const cases = [
                {
                    make: (): ContentRetentionId => new ContentRetentionId(""),
                    subject: "Content retention ID"
                },
                { make: (): EventCursor => new EventCursor(""), subject: "Event cursor" },
                {
                    make: (): InboxReferenceId => new InboxReferenceId(""),
                    subject: "Inbox reference ID"
                },
                {
                    make: (): RetainedRecordRef => new RetainedRecordRef(""),
                    subject: "Retained record reference"
                }
            ];
            for (const entry of cases) {
                expect(entry.make).toThrow(
                    expect.objectContaining({
                        message: `${entry.subject} must contain between 1 and 256 characters`
                    })
                );
            }
        }
    );
});

describe("ContentRetentionReference mutation coverage", () => {
    test("decode reports each tampered field with its exact subject label", { tags: "p2" }, () => {
        const reference = retentionFixture({
            id: "retention-labels",
            recordKind: "view",
            recordId: "surface-labels@0",
            content: content("retention-labels")
        });
        const payload = recordPayload(ContentRetentionReference.encode(reference));
        const cases = [
            { field: "content", value: 5, message: "Retained content must be an object" },
            { field: "id", value: 5, message: "Content retention ID must be a string" },
            { field: "tenant", value: 5, message: "Content retention tenant must be a string" },
            { field: "actor", value: 5, message: "Content retention Actor must be an object" },
            { field: "record", value: 5, message: "Retained record reference must be a string" }
        ];
        for (const entry of cases) {
            expect(() =>
                ContentRetentionReference.decode(
                    recordBytes("workspace.content-retention-reference", {
                        ...payload,
                        [entry.field]: entry.value
                    })
                )
            ).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: `Invalid workspace.content-retention-reference record: ${entry.message}`
                })
            );
        }
    });
});

describe("InboxEventReference mutation coverage", () => {
    test("decode reports each tampered field with its exact subject label", { tags: "p2" }, () => {
        const payload = recordPayload(InboxEventReference.encode(inboxFixture("labels")));
        const cases = [
            { field: "id", value: 5, message: "Inbox reference ID must be a string" },
            { field: "turn", value: 5, message: "Inbox Turn ID must be a string" },
            { field: "event", value: 5, message: "Inbox Event ID must be a string" }
        ];
        for (const entry of cases) {
            expect(() =>
                InboxEventReference.decode(
                    recordBytes("workspace.inbox-reference", {
                        ...payload,
                        [entry.field]: entry.value
                    })
                )
            ).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: `Invalid workspace.inbox-reference record: ${entry.message}`
                })
            );
        }
    });

    test("lease epoch accepts zero and rejects negative values exactly", { tags: "p1" }, () => {
        expect(inboxFixture("epoch-zero", 0, 0).leaseEpoch).toBe(0);
        expect(() => inboxFixture("epoch-negative", 0, -1)).toThrow(
            expect.objectContaining({
                message: "Inbox sequence and lease epoch must be non-negative safe integers"
            })
        );
    });
});

describe("Subscription mutation coverage", () => {
    test("decode reports each tampered field with its exact subject label", { tags: "p2" }, () => {
        const payload = recordPayload(Subscription.encode(subscriptionFixture("labels")));
        const cases = [
            { field: "id", value: 5, message: "Subscription ID must be a string" },
            {
                field: "revision",
                value: "one",
                message: "Subscription revision must be a non-negative safe integer"
            },
            { field: "target", value: 5, message: "Subscription target must be a string" },
            { field: "mapping", value: 5, message: "Subscription mapping must be an array" }
        ];
        for (const entry of cases) {
            expect(() =>
                Subscription.decode(
                    recordBytes("workspace.subscription", {
                        ...payload,
                        [entry.field]: entry.value
                    })
                )
            ).toThrow(
                expect.objectContaining({
                    code: "codec.invalid",
                    message: `Invalid workspace.subscription record: ${entry.message}`
                })
            );
        }
    });
});
