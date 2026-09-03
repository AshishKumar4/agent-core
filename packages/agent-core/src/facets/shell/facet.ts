import { Contributions, Contribution, OperationDescriptor } from "../contribution";
import { type FilesystemFacet } from "../filesystem";
import { requireDataObject, requireSafeInteger, requireString } from "../data";
import { OperationName, SlotName } from "../id";
import { ShellExecutionId } from "./id";
import type { FacetManifest } from "../manifest";
import {
    DetailedProfileError,
    InternalProfileFacetRuntime,
    ProfileOperationContract,
    profileWireCodec,
    type ProtectedProfileRuntimePort,
    type PublicProfileInput,
    schema,
    strictObjectSchema
} from "../profile-runtime";

export interface ShellIo {
    readonly stdin: AsyncIterable<Uint8Array>;
    writeStdout(chunk: Uint8Array): void;
    writeStderr(chunk: Uint8Array): void;
}

export abstract class ShellIoBackend {
    public abstract open(executionId: ShellExecutionId): ShellIo;
}

export interface ShellEnvironmentBindingPort<Receipt> {
    readonly fs: FilesystemFacet<Receipt>;
}

export interface ShellCommandContext<Receipt> {
    readonly argv: readonly string[];
    readonly filesystem: FilesystemFacet<Receipt>;
    readonly io: ShellIo;
}

export interface ShellProcessBackend {
    readonly completion: Promise<number>;
    forceTerminate(): void;
    confirmTerminated(): boolean | Promise<boolean>;
    fence(): void;
}

export abstract class ShellTerminationClock {
    public abstract wait(milliseconds: number): Promise<void>;
}

export class SystemShellTerminationClock extends ShellTerminationClock {
    public async wait(milliseconds: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
}

export interface ShellTerminationConfig {
    readonly confirmationMilliseconds: number;
    readonly terminatedExitCode?: number;
}

export class ShellExecutionBoundary {
    readonly #result: Promise<number>;
    readonly #terminatedExitCode: number;
    #resolveResult!: (exitCode: number) => void;
    #termination: Promise<void> | undefined;
    #live = true;

    public constructor(
        private readonly process: ShellProcessBackend,
        private readonly clock: ShellTerminationClock,
        private readonly confirmationMilliseconds: number,
        terminatedExitCode = 137
    ) {
        if (!Number.isSafeInteger(confirmationMilliseconds) || confirmationMilliseconds < 0) {
            throw new TypeError(
                "Shell termination confirmation bound must be a non-negative safe integer"
            );
        }
        if (!Number.isSafeInteger(terminatedExitCode)) {
            throw new TypeError("Shell terminated exit code must be a safe integer");
        }
        this.#terminatedExitCode = terminatedExitCode;
        this.#result = new Promise((resolve) => {
            this.#resolveResult = resolve;
        });
        void process.completion.then(
            (exitCode) => this.settle(exitCode),
            () => this.settle(1)
        );
    }

    public wait(): Promise<number> {
        return this.#result;
    }

    public get live(): boolean {
        return this.#live;
    }

    public terminate(): Promise<void> {
        this.#termination ??= this.terminateAfterProcessSettlement();
        return this.#termination;
    }

    private async terminateAfterProcessSettlement(): Promise<void> {
        try {
            this.process.forceTerminate();
        } catch {
            this.fenceAndSettle();
            return;
        }
        // Only one of the three outcomes is termination; a timeout and a failed
        // confirmation are the same answer, so the race carries whether the process
        // terminated rather than which arm said so.
        const terminated = await Promise.race([
            this.#result.then(() => true),
            this.confirmedTermination(),
            this.clock.wait(this.confirmationMilliseconds).then(
                () => false,
                () => false
            )
        ]);
        if (terminated) this.settle(this.#terminatedExitCode);
        else this.fenceAndSettle();
    }

    private async confirmedTermination(): Promise<boolean> {
        try {
            if (await this.process.confirmTerminated()) return true;
        } catch {
            // A confirmation that fails has answered; a confirmation that reports the
            // process still running has not, and leaves the bound below to answer.
            return false;
        }
        return new Promise(() => {});
    }

    private fenceAndSettle(): void {
        try {
            this.process.fence();
        } catch {
            // The local fence still closes this handle even if remote cleanup reports failure.
        } finally {
            this.settle(this.#terminatedExitCode);
        }
    }

    // Every path that ends the execution settles it, and several of them run for the same
    // execution: a cancelled process still completes. The first exit code is the one that
    // stands, which resolving an already-resolved result gives without a re-entry guard.
    private settle(exitCode: number): void {
        this.#live = false;
        this.#resolveResult(exitCode);
    }
}

export interface ShellCommand<Receipt> {
    start(context: ShellCommandContext<Receipt>): ShellProcessBackend;
}

export interface ShellRunInput extends PublicProfileInput {
    readonly executionId: ShellExecutionId;
    readonly commandLine: string;
}

export interface ShellCancelInput extends PublicProfileInput {
    readonly executionId: ShellExecutionId;
}

const runInputSchema = strictObjectSchema(
    {
        executionId: { type: "string", minLength: 1 },
        commandLine: { type: "string" }
    },
    ["executionId", "commandLine"]
);
const cancelInputSchema = strictObjectSchema({ executionId: { type: "string", minLength: 1 } }, [
    "executionId"
]);
const exitCodeSchema = schema({ type: "integer" });
const booleanSchema = schema({ type: "boolean" });
const runInputCodec = profileWireCodec<ShellRunInput>(
    (input) => ({ executionId: input.executionId.value, commandLine: input.commandLine }),
    (data) => {
        const object = requireDataObject(data, "Shell run input");
        return {
            executionId: new ShellExecutionId(
                requireString(object["executionId"], "Shell execution ID")
            ),
            commandLine: requireString(object["commandLine"], "Shell command line")
        };
    }
);
const cancelInputCodec = profileWireCodec<ShellCancelInput>(
    (input) => ({ executionId: input.executionId.value }),
    (data) => ({
        executionId: new ShellExecutionId(
            requireString(
                requireDataObject(data, "Shell cancel input")["executionId"],
                "Shell execution ID"
            )
        )
    })
);

export const SHELL_OPERATION_CONTRACTS = Object.freeze({
    run: new ProfileOperationContract<"run", ShellRunInput, number>(
        "run",
        new OperationDescriptor(
            new OperationName("run"),
            "execute",
            runInputSchema,
            exitCodeSchema
        ),
        runInputCodec,
        profileWireCodec(
            (value) => value,
            (data) => requireSafeInteger(data, "Exit code")
        ),
        "output"
    ),
    cancel: new ProfileOperationContract<"cancel", ShellCancelInput, boolean>(
        "cancel",
        new OperationDescriptor(
            new OperationName("cancel"),
            "mutate",
            cancelInputSchema,
            booleanSchema
        ),
        cancelInputCodec,
        profileWireCodec(
            (value) => value,
            (data) => data === true
        ),
        "output"
    )
});

export const SHELL_OPERATIONS: readonly OperationDescriptor[] = Object.freeze(
    Object.values(SHELL_OPERATION_CONTRACTS).map((contract) => contract.descriptor)
);
export const SHELL_CONTRIBUTIONS = new Contributions([
    new Contribution(
        new SlotName("operations"),
        SHELL_OPERATIONS.map((operation) => operation.toData())
    )
]);

export class ShellCommandRegistryBackend<Receipt> {
    readonly #commands = new Map<string, ShellCommand<Receipt>>();

    public register(name: string, command: ShellCommand<Receipt>): void {
        requireCommandName(name);
        if (this.#commands.has(name)) {
            throw new ShellError(
                "command.duplicate",
                `Shell command ${name} is already registered`
            );
        }
        this.#commands.set(name, command);
    }

    public resolve(name: string): ShellCommand<Receipt> | undefined {
        return this.#commands.get(name);
    }
}

export class ShellBackend<Receipt> {
    readonly #executions = new Map<string, ShellExecutionBoundary>();

    public constructor(
        private readonly environment: ShellEnvironmentBindingPort<Receipt>,
        private readonly registry: ShellCommandRegistryBackend<Receipt>,
        private readonly io: ShellIoBackend,
        private readonly termination: ShellTerminationConfig = { confirmationMilliseconds: 1_000 },
        private readonly clock: ShellTerminationClock = new SystemShellTerminationClock()
    ) {
        if (
            !Number.isSafeInteger(termination.confirmationMilliseconds) ||
            termination.confirmationMilliseconds < 0
        ) {
            throw new TypeError(
                "Shell termination confirmation bound must be a non-negative safe integer"
            );
        }
    }

    /**
     * SPEC §4.1 (C13-FACET-CANCELLATION-REACH): this call awaits the process under the
     * invocation's own lifetime, so it passes that invocation's cancellation on to the side
     * effect it owns. Cancellation runs the same termination a §11.2 `cancel` runs — the
     * force-terminate, the confirmation bound, and the fence — because a cancelled Turn and
     * an explicit cancel end one execution the same way, and the run still returns the exit
     * code the boundary settled on rather than abandoning its own wait.
     */
    public async run(request: ShellRunInput, cancellation?: AbortSignal): Promise<number> {
        const executionKey = request.executionId.value;
        if (this.#executions.has(executionKey)) {
            throw new ShellError(
                "execution.invalid",
                "Shell execution ID must be nonblank and unique while running"
            );
        }
        const argv = tokenizeShellCommand(request.commandLine);
        const name = argv[0];
        if (name === undefined) throw new ShellError("command.empty", "Command line is empty");
        const command = this.registry.resolve(name);
        if (command === undefined)
            throw new ShellError("command.unknown", `Unknown command: ${name}`);
        const execution = new ShellExecutionBoundary(
            command.start({
                argv: Object.freeze(argv.slice(1)),
                filesystem: this.environment.fs,
                io: this.io.open(request.executionId)
            }),
            this.clock,
            this.termination.confirmationMilliseconds,
            this.termination.terminatedExitCode
        );
        // One run owns its registration from set to delete. A cancel settles the
        // execution, and settling resolves the result this call is already awaiting, so
        // the run's own finally always frees the key before any cancel resumes — which
        // is also why no second run can claim the key while this one is registered.
        this.#executions.set(executionKey, execution);
        const terminate = (): void => {
            void execution.terminate();
        };
        // An already-aborted signal fires no listener, so the two arms are one decision:
        // cancellation that arrived before the process started still reaches it.
        if (cancellation?.aborted === true) terminate();
        else cancellation?.addEventListener("abort", terminate, { once: true });
        try {
            return await execution.wait();
        } finally {
            cancellation?.removeEventListener("abort", terminate);
            this.#executions.delete(executionKey);
        }
    }

    public async cancel(executionId: ShellExecutionId): Promise<boolean> {
        const execution = this.#executions.get(executionId.value);
        if (execution === undefined) return false;
        await execution.terminate();
        return true;
    }
}

export class ShellFacet<Receipt> {
    public static readonly operations = SHELL_OPERATIONS;

    public constructor(
        private readonly runtime: ProtectedProfileRuntimePort<Receipt>,
        private readonly backend: ShellBackend<Receipt>
    ) {}

    public asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime {
        return new InternalProfileFacetRuntime({
            manifest,
            runtime: this.runtime,
            operations: [
                this.runtime.operation(SHELL_OPERATION_CONTRACTS.run, (input, context) =>
                    this.backend.run(input, context.cancellation)
                ),
                this.runtime.operation(SHELL_OPERATION_CONTRACTS.cancel, (input) =>
                    this.backend.cancel(input.executionId)
                )
            ]
        });
    }

    public run(input: ShellRunInput): Promise<number> {
        return this.runtime.invoke(SHELL_OPERATION_CONTRACTS.run, input, (admitted, context) =>
            this.backend.run(admitted, context.cancellation)
        );
    }

    public cancel(input: ShellCancelInput): Promise<boolean> {
        return this.runtime.invoke(SHELL_OPERATION_CONTRACTS.cancel, input, (admitted) =>
            this.backend.cancel(admitted.executionId)
        );
    }
}

export type ShellErrorCode =
    | "command.empty"
    | "command.unknown"
    | "command.invalid"
    | "command.duplicate"
    | "execution.invalid";

export class ShellError extends DetailedProfileError<ShellErrorCode> {
    public constructor(detailCode: ShellErrorCode, message: string) {
        super("operation.invalid-input", detailCode, message);
        this.name = "ShellError";
    }
}

export function tokenizeShellCommand(commandLine: string): string[] {
    const tokens: string[] = [];
    let token = "";
    let quote: "'" | '"' | undefined;
    let escaped = false;
    let started = false;

    for (const character of commandLine) {
        if (escaped) {
            token += character;
            escaped = false;
            started = true;
            continue;
        }
        if (character === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }
        if (character === "'" || character === '"') {
            if (quote === character) quote = undefined;
            else if (quote === undefined) quote = character;
            else token += character;
            started = true;
            continue;
        }
        if (/\s/u.test(character) && quote === undefined) {
            if (started) tokens.push(token);
            token = "";
            started = false;
            continue;
        }
        token += character;
        started = true;
    }
    if (escaped || quote !== undefined) {
        throw new ShellError("command.invalid", "Command line has an unfinished quote or escape");
    }
    if (started) tokens.push(token);
    return tokens;
}

function requireCommandName(name: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
        throw new ShellError("command.invalid", "Shell command name must be canonical");
    }
}
