import { describe, expect, test } from "vitest";
import { JsonSchema } from "../../../src/core";
import {
    DetailedProfileError,
    OperationDescriptor,
    OperationName,
    ProfileControlContract,
    ProfileOperationContract,
    ProfileRuntimeEffectsPort,
    ProtectedOperationPort,
    ProtectedProfileRuntimePort,
    profileWireCodec,
    strictObjectSchema,
    type PublicProfileInput,
    type ProtectedOperationRequest,
    type ProtectedOperationResult
} from "../../../src/facets";
import { AttemptReceipt, EffectAttemptId, ReceiptId } from "../../../src/invocations";
import { recordingRuntime, type TestReceipt } from "./harness";

interface ExampleInput extends PublicProfileInput {
    readonly value: string;
}

const inputSchema = strictObjectSchema({ value: { type: "string" } }, ["value"]);
const outputSchema = new JsonSchema({ type: "string" });
const descriptor = new OperationDescriptor(
    new OperationName("example"),
    "observe",
    inputSchema,
    outputSchema
);
const inputCodec = profileWireCodec<ExampleInput>(
    (input) => ({ value: input.value }),
    (data) => ({ value: (data as { value: string }).value })
);
const outputCodec = profileWireCodec<string>(
    (value) => value,
    (data) => String(data)
);
const contract = new ProfileOperationContract(
    "example",
    descriptor,
    inputCodec,
    outputCodec,
    "output"
);

describe("Protected profile runtime port", () => {
    test("executes a W3 Operation only after protected admission", async () => {
        const { runtime, admission } = recordingRuntime("example");
        let called = false;
        const output = await runtime.invoke(contract, { value: "input" }, (input, context) => {
            called = true;
            expect(input).toEqual({ value: "input" });
            expect(context.attempt?.value).toBe("profile-attempt-1");
            expect(context.attemptOrdinal).toBe(0);
            expect(context.intentDigest).toBeDefined();
            return "output";
        });

        expect(called).toBe(true);
        expect(output).toBe("output");
        expect(admission.calls.map((call) => call.name)).toEqual(["example"]);
    });

    test("validates wire input before the protected port and output before release", async () => {
        const { runtime, admission } = recordingRuntime("validation");
        await expect(
            runtime.invoke(contract, { value: 7 } as never, () => "unused")
        ).rejects.toMatchObject({ code: "operation.invalid-input", detailCode: "wire.input" });
        expect(admission.calls).toEqual([]);

        await expect(
            runtime.invoke(contract, { value: "valid" }, () => 7 as never)
        ).rejects.toMatchObject({ code: "operation.invalid-output", detailCode: "wire.output" });
    });

    test("rejects result-kind substitution from the protected port", async () => {
        const { runtime: template } = recordingRuntime("kind-template");
        const runtime = new ProtectedProfileRuntimePort(
            template.host,
            new ReceiptSubstitutionPort(),
            recordingRuntime("kind-effects").effects as unknown as ProfileRuntimeEffectsPort<{
                readonly substituted: true;
            }>
        );
        runtime.activate();
        await expect(
            runtime.invoke(contract, { value: "input" }, () => "output")
        ).rejects.toMatchObject({ code: "operation.invalid-output", detailCode: "wire.output" });
    });

    test("blocks inactive execution before encoding or admission", async () => {
        const { runtime, admission } = recordingRuntime("inactive");
        runtime.deactivate();
        await expect(
            runtime.invoke(contract, { value: "input" }, () => "output")
        ).rejects.toMatchObject({
            code: "facet.inactive",
            detailCode: "facet.inactive",
            message: "Profile Facet runtime is inactive"
        });
        expect(admission.calls).toEqual([]);
    });

    test("returns receipt evidence alongside decoded output", { tags: "p0" }, async () => {
        const { runtime } = recordingRuntime("with-receipt");
        const result = await runtime.invokeWithReceipt(
            contract,
            { value: "input" },
            (input) => input.value
        );
        expect(result.output).toBe("input");
        expect(result.receipt).toBeInstanceOf(AttemptReceipt);
        expect(Object.isFrozen(result)).toBe(true);
    });

    test("rejects protected results lacking source receipt evidence", { tags: "p0" }, async () => {
        const evidence = {
            code: "operation.invalid-output",
            detailCode: "wire.output",
            message: "Protected Operation port omitted source Event Receipt evidence"
        };
        await expect(
            runtimeWith(new ReceiptKindPort()).invokeWithReceipt(
                contract,
                { value: "input" },
                () => "output"
            )
        ).rejects.toMatchObject(evidence);
        await expect(
            runtimeWith(new ReceiptlessOutputPort()).invokeWithReceipt(
                contract,
                { value: "input" },
                () => "output"
            )
        ).rejects.toMatchObject(evidence);
    });

    test("requires a Receipt result for receipt-mode operations", { tags: "p0" }, async () => {
        const receiptContract = new ProfileOperationContract(
            "example",
            descriptor,
            inputCodec,
            outputCodec,
            "receipt"
        );
        await expect(
            runtimeWith(new ReceiptlessOutputPort()).invoke(
                receiptContract,
                { value: "input" },
                () => "output"
            )
        ).rejects.toMatchObject({
            code: "operation.invalid-output",
            detailCode: "wire.output",
            message: "Protected Operation port omitted the operation Receipt"
        });
    });

    test("validates rewritten operation admissions before decoding", { tags: "p0" }, async () => {
        const { runtime } = recordingRuntime("invoke-rewrite", (kind, _name, input) =>
            kind === "invoke" ? { value: 7 } : input
        );
        await expect(
            runtime.invoke(contract, { value: "input" }, (input) => input.value)
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            detailCode: "wire.input",
            message: "Profile input does not match its Operation schema"
        });
    });

    test("reports control wire failures on the input side", { tags: "p0" }, async () => {
        const controlContract = new ProfileControlContract(
            "example.control",
            inputSchema,
            outputSchema,
            inputCodec,
            outputCodec
        );
        const { runtime } = recordingRuntime("control");
        await expect(
            runtime.control(controlContract, { value: "input" }, (input) => input.value)
        ).resolves.toBe("input");

        const encodeThrowing = new ProfileControlContract(
            "example.control",
            inputSchema,
            outputSchema,
            profileWireCodec<ExampleInput>(
                () => {
                    throw new TypeError("encode");
                },
                (data) => ({ value: (data as { value: string }).value })
            ),
            outputCodec
        );
        await expect(
            runtime.control(encodeThrowing, { value: "input" }, (input) => input.value)
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            detailCode: "wire.input",
            message: "Profile input encoding failed"
        });

        const decodeThrowing = new ProfileControlContract(
            "example.control",
            inputSchema,
            outputSchema,
            profileWireCodec<ExampleInput>(
                (input) => ({ value: input.value }),
                () => {
                    throw new TypeError("decode");
                }
            ),
            outputCodec
        );
        await expect(
            runtime.control(decodeThrowing, { value: "input" }, (input) => input.value)
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            detailCode: "wire.input",
            message: "Profile input decoding failed"
        });

        const { runtime: rewriting } = recordingRuntime("control-rewrite", (kind, _name, input) =>
            kind === "control" ? { value: 7 } : input
        );
        await expect(
            rewriting.control(controlContract, { value: "input" }, (input) => input.value)
        ).rejects.toMatchObject({
            code: "operation.invalid-input",
            detailCode: "wire.input",
            message: "Profile input does not match its Operation schema"
        });
    });
});

class ReceiptSubstitutionPort extends ProtectedOperationPort<{ readonly substituted: true }> {
    public async invoke(
        _request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<{ readonly substituted: true }>> {
        return { kind: "receipt", receipt: { substituted: true } };
    }
}

class ReceiptKindPort extends ProtectedOperationPort<TestReceipt> {
    public async invoke(
        _request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<TestReceipt>> {
        return {
            kind: "receipt",
            receipt: new AttemptReceipt(
                new ReceiptId("substituted-receipt"),
                new EffectAttemptId("substituted-attempt"),
                "succeeded",
                undefined,
                new Date(0),
                undefined
            )
        };
    }
}

class ReceiptlessOutputPort extends ProtectedOperationPort<TestReceipt> {
    public async invoke(
        _request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<TestReceipt>> {
        return { kind: "output", output: "output" };
    }
}

function runtimeWith(
    port: ProtectedOperationPort<TestReceipt>
): ProtectedProfileRuntimePort<TestReceipt> {
    const { runtime: template, effects } = recordingRuntime("substitution");
    const runtime = new ProtectedProfileRuntimePort(template.host, port, effects);
    runtime.activate();
    return runtime;
}

export function denied(): DetailedProfileError<"runtime.denied"> {
    return new DetailedProfileError(
        "authority.denied",
        "runtime.denied",
        "Protected profile admission denied"
    );
}
