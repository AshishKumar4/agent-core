// @ts-nocheck
import { Digest, type JsonValue } from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import {
    BindingName,
    DetailedProfileError,
    FacetRef,
    FilesystemError,
    ProfileEffectContext,
    ProfileRuntimeEffectsPort,
    ProfileRuntimeHostBinding,
    ProtectedOperationPort,
    ProtectedProfileRuntimePort,
    type EventDeclaration,
    type FacetData,
    type FilesystemBackend,
    type FilesystemReaderBackend,
    type OperationDescriptor,
    type ProfileControlAdmission,
    type ProtectedOperationRequest,
    type ProtectedOperationResult
} from "../../../src/facets";
import {
    AttemptReceipt,
    EffectAttemptId,
    InvocationId,
    type Receipt,
    ReceiptId
} from "../../../src/invocations";
import { describe, expect, test } from "vitest";

export type TestReceipt = Receipt;

export interface RecordedProfileCall {
    readonly host: ProfileRuntimeHostBinding;
    readonly kind: "invoke" | "emit" | "control";
    readonly name: string;
    readonly impact?: OperationDescriptor["impact"];
    readonly input: JsonValue;
    readonly context?: ProfileEffectContext;
    readonly receipt?: TestReceipt;
}

export type ProfileAdmissionRewrite = (
    kind: RecordedProfileCall["kind"],
    name: string,
    input: JsonValue
) => JsonValue;

export type ProfileTargetAdmission = (
    request: ProtectedOperationRequest,
    admittedInput: JsonValue
) => unknown;

export class RecordingProfileAdmission extends ProtectedOperationPort<TestReceipt> {
    public readonly calls: RecordedProfileCall[] = [];
    public readonly handlerOutputs: JsonValue[] = [];
    #callSequence = 0;
    #receiptSequence = 0;

    public constructor(
        private readonly rewrite: ProfileAdmissionRewrite = (_kind, _name, input) => input,
        private readonly targetAdmission: ProfileTargetAdmission = () => undefined
    ) {
        super();
    }

    public async invoke(
        request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<TestReceipt>> {
        this.#callSequence += 1;
        const intentDigest = Digest.sha256(new TextEncoder().encode(JSON.stringify(request.input)));
        const attempt = new EffectAttemptId(`profile-attempt-${this.#callSequence}`);
        const admittedInput = this.rewrite(
            "invoke",
            request.operation.descriptor.name.value,
            request.input
        );
        const context = Object.freeze({
            invocation: new InvocationId(`profile-invocation-${this.#callSequence}`),
            itemIndex: 0,
            idempotencyKey: `profile-idempotency-${this.#callSequence}`,
            attempt: Object.freeze({ id: attempt, ordinal: 0, intentDigest }),
            targetAdmission: this.targetAdmission(request, admittedInput),
            signal: new AbortController().signal,
            content: new MemoryContentStore()
        });
        const effectContext = ProfileEffectContext.fromOperation(context);
        const operation = request.operation.descriptor;
        const input = request.input;
        expect(Object.isFrozen(input) || typeof input !== "object" || input === null).toBe(true);
        expect(operation.input.accepts(input)).toBe(true);
        this.calls.push({
            host: new ProfileRuntimeHostBinding(request.facet, request.binding),
            kind: "invoke",
            name: operation.name.value,
            impact: operation.impact,
            input,
            context: effectContext
        });
        const output = await request.operation.execute(context, admittedInput);
        expect(operation.output.accepts(output)).toBe(true);
        this.handlerOutputs.push(output);
        if (request.resultMode === "receipt") this.#receiptSequence += 1;
        const receipt = new AttemptReceipt(
            new ReceiptId(
                request.resultMode === "receipt"
                    ? `profile-receipt-${this.#receiptSequence}`
                    : `profile-output-receipt-${this.#callSequence}`
            ),
            attempt,
            "succeeded",
            undefined,
            new Date(this.#callSequence),
            undefined
        );
        return request.resultMode === "receipt"
            ? Object.freeze({ kind: "receipt" as const, receipt })
            : Object.freeze({ kind: "output" as const, output, receipt });
    }
}

export class RecordingProfileEffects extends ProfileRuntimeEffectsPort<TestReceipt> {
    public constructor(
        private readonly calls: RecordedProfileCall[],
        private readonly handlerOutputs: JsonValue[],
        private readonly rewrite: ProfileAdmissionRewrite = (_kind, _name, input) => input
    ) {
        super();
    }

    public async emit(
        host: ProfileRuntimeHostBinding,
        declaration: EventDeclaration,
        payload: JsonValue,
        cause: TestReceipt
    ): Promise<void> {
        expect(declaration.payload.accepts(payload)).toBe(true);
        this.calls.push({
            host,
            kind: "emit",
            name: declaration.kind.value,
            input: payload,
            receipt: cause
        });
    }

    public async control(
        host: ProfileRuntimeHostBinding,
        control: ProfileControlAdmission,
        input: JsonValue,
        admittedHandler: (input: JsonValue) => Promise<JsonValue>
    ): Promise<JsonValue> {
        expect(control.input.accepts(input)).toBe(true);
        this.calls.push({ host, kind: "control", name: control.name, input });
        const output = await admittedHandler(this.rewrite("control", control.name, input));
        expect(control.output.accepts(output)).toBe(true);
        this.handlerOutputs.push(output);
        return output;
    }

    public async render(
        _host: ProfileRuntimeHostBinding,
        _descriptor: import("../../../src/facets").SurfaceDescriptor,
        _context: import("../../../src/facets").OperationContext,
        input: FacetData
    ): Promise<FacetData> {
        return input;
    }
}

export class DenyingProfileAdmission extends ProtectedOperationPort<TestReceipt> {
    public async invoke(
        _request: ProtectedOperationRequest
    ): Promise<ProtectedOperationResult<TestReceipt>> {
        throw denied();
    }
}

export class DenyingProfileEffects extends ProfileRuntimeEffectsPort<TestReceipt> {
    public async emit(
        _host: ProfileRuntimeHostBinding,
        _declaration: EventDeclaration,
        _payload: JsonValue,
        _cause: TestReceipt
    ): Promise<void> {
        throw denied();
    }

    public async control(
        _host: ProfileRuntimeHostBinding,
        _control: ProfileControlAdmission,
        _input: JsonValue,
        _admittedHandler: (input: JsonValue) => Promise<JsonValue>
    ): Promise<JsonValue> {
        throw denied();
    }

    public async render(): Promise<FacetData> {
        throw denied();
    }
}

export function recordingRuntime(
    profile: string,
    rewrite?: ProfileAdmissionRewrite,
    targetAdmission?: ProfileTargetAdmission
): {
    readonly admission: RecordingProfileAdmission;
    readonly effects: RecordingProfileEffects;
    readonly runtime: ProtectedProfileRuntimePort<TestReceipt>;
} {
    const admission = new RecordingProfileAdmission(rewrite, targetAdmission);
    const effects = new RecordingProfileEffects(admission.calls, admission.handlerOutputs, rewrite);
    const runtime = new ProtectedProfileRuntimePort(
        new ProfileRuntimeHostBinding(new FacetRef(`profile:${profile}`), new BindingName(profile)),
        admission,
        effects
    );
    runtime.activate();
    return {
        admission,
        effects,
        runtime
    };
}

export function denyingRuntime(profile: string): {
    readonly admission: DenyingProfileAdmission;
    readonly runtime: ProtectedProfileRuntimePort<TestReceipt>;
} {
    const admission = new DenyingProfileAdmission();
    const runtime = new ProtectedProfileRuntimePort(
        new ProfileRuntimeHostBinding(new FacetRef(`profile:${profile}`), new BindingName(profile)),
        admission,
        new DenyingProfileEffects()
    );
    runtime.activate();
    return {
        admission,
        runtime
    };
}

export function operationDeclarationEvidence(
    profile: string,
    operations: readonly OperationDescriptor[],
    expected: Readonly<Record<string, OperationDescriptor["impact"]>>
): void {
    describe(`${profile} operation declaration evidence`, () => {
        test("declares exact names, impacts, valid schemas, and immutable descriptors", () => {
            expect(
                Object.fromEntries(
                    operations.map((operation) => [operation.name.value, operation.impact])
                )
            ).toEqual(expected);
            for (const operation of operations) {
                operation.input.assertValid();
                operation.output.assertValid();
                expect(Object.isFrozen(operation)).toBe(true);
            }
            expect(Object.isFrozen(operations)).toBe(true);
        });
    });
}

export function filesystemReaderBackendEvidence(
    implementation: string,
    create: () => { readonly reader: FilesystemReaderBackend; readonly seed: FilesystemBackend }
): void {
    describe(`${implementation} filesystem reader backend evidence`, () => {
        test("reads byte ranges and returns stat-inclusive sorted pages", () => {
            const { reader, seed } = create();
            seed.mkdir("/docs");
            seed.write("/docs/b", new Uint8Array([1, 2, 3, 4]));
            seed.write("/docs/a", new Uint8Array([5]));
            expect([...reader.read("/docs/b", { offset: 1, length: 2 })]).toEqual([2, 3]);
            const first = reader.list("/docs", undefined, 1);
            expect(first.entries).toEqual([reader.stat("/docs/a")]);
            expect(first.cursor).toBe("/docs/a");
            expect(reader.list("/docs", first.cursor, 1).entries).toEqual([reader.stat("/docs/b")]);
        });
    });
}

export function mutableFilesystemBackendEvidence(
    implementation: string,
    create: () => FilesystemBackend
): void {
    describe(`${implementation} mutable filesystem backend evidence`, () => {
        test("honors write modes, atomic validation, and move semantics", () => {
            const filesystem = create();
            filesystem.mkdir("/a");
            filesystem.write("/a/file", new Uint8Array([1]), "create");
            expectFilesystemCode(
                () => filesystem.write("/a/file", new Uint8Array(), "create"),
                "exists"
            );
            expectFilesystemCode(
                () => filesystem.write("/missing", new Uint8Array(), "replace"),
                "not-found"
            );
            filesystem.move("/a", "/b");
            expect([...filesystem.read("/b/file")]).toEqual([1]);
            expectFilesystemCode(() => filesystem.move("/b", "/b/child"), "path.invalid");
        });
    });
}

function expectFilesystemCode(
    action: () => unknown,
    detailCode: FilesystemError["detailCode"]
): void {
    try {
        action();
        throw new TypeError("Expected filesystem operation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(FilesystemError);
        expect(error).toMatchObject({ detailCode, detail: { code: detailCode } });
    }
}

function denied(): DetailedProfileError<"runtime.denied"> {
    return new DetailedProfileError(
        "authority.denied",
        "runtime.denied",
        "Protected profile admission denied"
    );
}
