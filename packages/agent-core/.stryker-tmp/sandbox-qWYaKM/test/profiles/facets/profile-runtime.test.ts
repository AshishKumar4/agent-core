// @ts-nocheck
import { describe, expect, test } from "vitest";
import { JsonSchema } from "../../../src/core";
import {
    DetailedProfileError,
    OperationDescriptor,
    OperationName,
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
import { recordingRuntime } from "./harness";

interface ExampleInput extends PublicProfileInput {
    readonly value: string;
}

const inputSchema = strictObjectSchema({ value: { type: "string" } }, ["value"]);
const outputSchema = new JsonSchema({ type: "string" });
const contract = new ProfileOperationContract(
    "example",
    new OperationDescriptor(new OperationName("example"), "observe", inputSchema, outputSchema),
    profileWireCodec<ExampleInput>(
        (input) => ({ value: input.value }),
        (data) => ({ value: (data as { value: string }).value })
    ),
    profileWireCodec<string>(
        (value) => value,
        (data) => String(data)
    ),
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
        ).rejects.toMatchObject({ code: "facet.inactive" });
        expect(admission.calls).toEqual([]);
    });
});

class ReceiptSubstitutionPort extends ProtectedOperationPort<{ readonly substituted: true }> {
    public async invoke(
        _request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<{ readonly substituted: true }>> {
        return { kind: "receipt", receipt: { substituted: true } };
    }
}

export function denied(): DetailedProfileError<"runtime.denied"> {
    return new DetailedProfileError(
        "authority.denied",
        "runtime.denied",
        "Protected profile admission denied"
    );
}
