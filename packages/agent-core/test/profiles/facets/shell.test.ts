import { describe, expect, test } from "vitest";
import { CompatRange, SemVer } from "../../../src/core";
import { MemoryContentStore } from "../../../src/content";
import { evaluatePolicy } from "../../../src/definition";
import {
    BindingName,
    BindingRequirement,
    FacetPackageId,
    FilesystemFacet,
    FilesystemError,
    MemoryFilesystemBackend,
    OperationName,
    SHELL_OPERATIONS,
    SHELL_OPERATION_CONTRACTS,
    SHELL_REQUIRED_BINDING,
    ShellBackend,
    ShellCommandRegistryBackend,
    ShellError,
    ShellExecutionBoundary,
    ShellExecutionId,
    ShellFacet,
    ShellIoBackend,
    ShellTerminationClock,
    SystemShellTerminationClock,
    createShellManifest,
    tokenizeShellCommand,
    type OperationContext,
    type ShellIo,
    type ShellProcessBackend
} from "../../../src/facets";
import { InvocationId } from "../../../src/invocations";
import { denyingRuntime, operationDeclarationEvidence, recordingRuntime } from "./harness";

operationDeclarationEvidence("Shell", SHELL_OPERATIONS, { run: "execute", cancel: "mutate" });

describe("Shell protected facade", () => {
    test("[P11-SHELL-BOUNDARY] preserves the Filesystem path.invalid code for command escape", async () => {
        let boundaryFailure: unknown;
        const filesystem = new FilesystemFacet(
            recordingRuntime("shell-boundary-fs").runtime,
            new MemoryFilesystemBackend()
        );
        const registry = new ShellCommandRegistryBackend();
        registry.register("escape", {
            start: (context) =>
                immediateProcess(
                    (async () => {
                        try {
                            await context.filesystem.read({ path: "/../outside" });
                        } catch (error) {
                            boundaryFailure = error;
                            return 1;
                        }
                        return 0;
                    })()
                )
        });
        const shell = new ShellFacet(
            recordingRuntime("shell-boundary").runtime,
            new ShellBackend({ fs: filesystem }, registry, new RecordingIoBackend())
        );

        await expect(
            shell.run({ executionId: executionId("escape"), commandLine: "escape" })
        ).resolves.toBe(1);
        expect(boundaryFailure).toBeInstanceOf(FilesystemError);
        expect(boundaryFailure).toMatchObject({ detailCode: "path.invalid" });
    });

    test("[P11-SHELL-HANDOFF] hands off only to an explicitly registered external command", async () => {
        let externalStarts = 0;
        const registry = new ShellCommandRegistryBackend();
        const shell = createShell(registry);
        await expect(
            shell.run({ executionId: executionId("implicit"), commandLine: "external" })
        ).rejects.toMatchObject({ detailCode: "command.unknown" });
        expect(externalStarts).toBe(0);

        registry.register("external", {
            start: () => {
                externalStarts += 1;
                return immediateProcess(Promise.resolve(0));
            }
        });
        await expect(
            shell.run({ executionId: executionId("declared"), commandLine: "external" })
        ).resolves.toBe(0);
        expect(externalStarts).toBe(1);
    });

    test("[P11-SHELL-RUN] selects direct tier only for a bundled Turn-owned Session", () => {
        const descriptor = SHELL_OPERATION_CONTRACTS.run.descriptor;
        expect(descriptor.impact).toBe("execute");
        expect(
            evaluatePolicy({
                impact: descriptor.impact,
                turnOwnedSession: true,
                placement: "bundled"
            })
        ).toEqual({ approvalRequired: false, tier: "direct" });
        for (const decision of [
            evaluatePolicy({
                impact: descriptor.impact,
                turnOwnedSession: false,
                placement: "bundled"
            }),
            evaluatePolicy({
                impact: descriptor.impact,
                turnOwnedSession: true,
                placement: "dynamic"
            })
        ]) {
            expect(decision.tier).toBe("mediated");
        }
    });

    test("[P11-SHELL-COMPOSITION] executes a declared command against the Session Filesystem profile", async () => {
        const filesystemRuntime = recordingRuntime("shell-composition-fs");
        const filesystem = new FilesystemFacet(
            filesystemRuntime.runtime,
            new MemoryFilesystemBackend()
        );
        const registry = new ShellCommandRegistryBackend();
        registry.register("write", {
            start: (context) =>
                immediateProcess(
                    context.filesystem
                        .write({ path: "/composed", content: new Uint8Array([1]) })
                        .then(() => 0)
                )
        });
        const shell = new ShellFacet(
            recordingRuntime("shell-composition").runtime,
            new ShellBackend({ fs: filesystem }, registry, new RecordingIoBackend())
        );

        await expect(
            shell.run({ executionId: executionId("composition"), commandLine: "write" })
        ).resolves.toBe(0);
        expect(filesystemRuntime.admission.calls).toMatchObject([
            { kind: "invoke", name: "write", impact: "mutate" }
        ]);
    });

    test("[P11-SHELL-REGISTRY] resolves only explicitly registered commands", () => {
        const registry = new ShellCommandRegistryBackend();
        const command = { start: () => immediateProcess(Promise.resolve(0)) };
        registry.register("known", command);
        expect(registry.resolve("known")).toBe(command);
        expect(registry.resolve("unknown")).toBeUndefined();
    });

    test("[P11-SHELL-STREAMS] supplies streaming stdin, stdout, and stderr to commands", async () => {
        const io = new StreamingIoBackend();
        const registry = new ShellCommandRegistryBackend();
        registry.register("streams", {
            start: (context) =>
                immediateProcess(
                    (async () => {
                        for await (const chunk of context.io.stdin) context.io.writeStdout(chunk);
                        context.io.writeStderr(new Uint8Array([2]));
                        return 0;
                    })()
                )
        });
        const filesystem = new FilesystemFacet(
            recordingRuntime("shell-stream-fs").runtime,
            new MemoryFilesystemBackend()
        );
        const shell = new ShellFacet(
            recordingRuntime("shell-streams").runtime,
            new ShellBackend({ fs: filesystem }, registry, io)
        );

        await expect(
            shell.run({ executionId: executionId("streams"), commandLine: "streams" })
        ).resolves.toBe(0);
        expect(io.stdout).toEqual([new Uint8Array([1])]);
        expect(io.stderr).toEqual([new Uint8Array([2])]);
    });

    test("[P11-SHELL-UNKNOWN] rejects unknown commands without external handoff", async () => {
        const registry = new ShellCommandRegistryBackend();
        const shell = createShell(registry);
        await expect(
            shell.run({ executionId: executionId("unknown"), commandLine: "missing" })
        ).rejects.toMatchObject({ detailCode: "command.unknown" });
    });

    test("[P11-SHELL-FILESYSTEM] routes run/cancel, injects IO privately, and binds commands to exact env.fs", async () => {
        const filesystemRuntime = recordingRuntime("filesystem");
        const filesystem = new FilesystemFacet(
            filesystemRuntime.runtime,
            new MemoryFilesystemBackend()
        );
        const registry = new ShellCommandRegistryBackend();
        const waiting = deferred<number>();
        let waitTerminated = false;
        registry.register("wait", {
            start: () => ({
                completion: waiting.promise,
                forceTerminate() {
                    waitTerminated = true;
                    waiting.resolve(130);
                },
                confirmTerminated: () => waitTerminated,
                fence() {}
            })
        });
        registry.register("touch", {
            start(context) {
                return immediateProcess(
                    (async () => {
                        await context.filesystem.write({
                            path: context.argv[0]!,
                            content: new Uint8Array([1])
                        });
                        context.io.writeStdout(new Uint8Array([1]));
                        return 0;
                    })()
                );
            }
        });
        const io = new RecordingIoBackend();
        const backend = new ShellBackend({ fs: filesystem }, registry, io);
        const shellRuntime = recordingRuntime("shell");
        const shell = new ShellFacet(shellRuntime.runtime, backend);

        const running = shell.run({ executionId: executionId("one"), commandLine: "wait" });
        await expect(shell.cancel({ executionId: executionId("one") })).resolves.toBe(true);
        await expect(running).resolves.toBe(130);
        await expect(
            shell.run({ executionId: executionId("two"), commandLine: "touch /made" })
        ).resolves.toBe(0);

        expect(shellRuntime.admission.calls.map((call) => call.input)).toEqual([
            { executionId: "one", commandLine: "wait" },
            { executionId: "one" },
            { executionId: "two", commandLine: "touch /made" }
        ]);
        expect(filesystemRuntime.admission.calls.map((call) => call.name)).toEqual(["write"]);
        expect(io.opened).toEqual(["one", "two"]);
    });

    test("[P11-SHELL-CANCELLATION] cancel force-terminates within the configured bound and fences a non-cooperative process", async () => {
        const never = new Promise<number>(() => {});
        const clock = new ControlledTerminationClock();
        let starts = 0;
        let forceTerminations = 0;
        let fences = 0;
        const registry = new ShellCommandRegistryBackend();
        registry.register("stubborn", {
            start: () =>
                starts++ === 0
                    ? {
                          completion: never,
                          forceTerminate() {
                              forceTerminations += 1;
                          },
                          confirmTerminated: () => false,
                          fence() {
                              fences += 1;
                          }
                      }
                    : immediateProcess(Promise.resolve(0))
        });
        const shell = createShell(registry, clock, 25);
        const running = shell.run({
            executionId: executionId("stubborn"),
            commandLine: "stubborn"
        });
        let cancelSettled = false;
        const cancelling = shell.cancel({ executionId: executionId("stubborn") }).then((value) => {
            cancelSettled = true;
            return value;
        });
        await Promise.resolve();
        expect(forceTerminations).toBe(1);
        expect(clock.bounds).toEqual([25]);
        expect(cancelSettled).toBe(false);
        clock.elapse();
        await expect(cancelling).resolves.toBe(true);
        await expect(running).resolves.toBe(137);
        expect(fences).toBe(1);
        await expect(
            shell.run({ executionId: executionId("stubborn"), commandLine: "stubborn" })
        ).resolves.toBe(0);
    });

    test("[P11-SHELL-SINGLE-AUTHORITY] denial prevents command execution and IO acquisition", async () => {
        let starts = 0;
        const registry = new ShellCommandRegistryBackend();
        registry.register("effect", {
            start: () => {
                starts += 1;
                return immediateProcess(Promise.resolve(0));
            }
        });
        const io = new RecordingIoBackend();
        const filesystem = new FilesystemFacet(
            recordingRuntime("filesystem").runtime,
            new MemoryFilesystemBackend()
        );
        const shell = new ShellFacet(
            denyingRuntime("shell").runtime,
            new ShellBackend({ fs: filesystem }, registry, io)
        );
        await expect(
            shell.run({ executionId: executionId("denied"), commandLine: "effect" })
        ).rejects.toMatchObject({ code: "authority.denied" });
        expect(starts).toBe(0);
        expect(io.opened).toEqual([]);
    });
});

describe("Shell backends", () => {
    test("[P11-SHELL-PARSER] tokenizes explicitly and rejects duplicate or malformed commands", () => {
        expect(tokenizeShellCommand("tool 'one two' three\\ four \"\"")).toEqual([
            "tool",
            "one two",
            "three four",
            ""
        ]);
        expect(() => tokenizeShellCommand("tool 'unfinished")).toThrow(ShellError);
        const registry = new ShellCommandRegistryBackend();
        registry.register("ok", { start: () => immediateProcess(Promise.resolve(0)) });
        expect(() =>
            registry.register("ok", { start: () => immediateProcess(Promise.resolve(0)) })
        ).toThrow(expect.objectContaining({ detailCode: "command.duplicate" }));
        expect(() =>
            registry.register("not valid", { start: () => immediateProcess(Promise.resolve(0)) })
        ).toThrow(expect.objectContaining({ detailCode: "command.invalid" }));
    });

    test("validates termination bounds, exit-code wire values, and missing command targets", async () => {
        const process = immediateProcess(Promise.resolve(0));
        expect(
            () => new ShellExecutionBoundary(process, new ControlledTerminationClock(), -1)
        ).toThrow(TypeError);
        expect(
            () => new ShellExecutionBoundary(process, new ControlledTerminationClock(), 0, 1.5)
        ).toThrow(TypeError);
        expect(() => SHELL_OPERATION_CONTRACTS.run.decodeOutput(1.5)).toThrow(TypeError);

        const registry = new ShellCommandRegistryBackend();
        const filesystem = new FilesystemFacet(
            recordingRuntime("filesystem-shell-validation").runtime,
            new MemoryFilesystemBackend()
        );
        expect(
            () =>
                new ShellBackend({ fs: filesystem }, registry, new RecordingIoBackend(), {
                    confirmationMilliseconds: -1
                })
        ).toThrow(TypeError);
        const backend = new ShellBackend({ fs: filesystem }, registry, new RecordingIoBackend());
        expect(() => new ShellExecutionId("")).toThrow(TypeError);
        await expect(
            backend.run({ executionId: executionId("empty-command"), commandLine: "   " })
        ).rejects.toMatchObject({ detailCode: "command.empty" });
        await expect(
            backend.run({ executionId: executionId("unknown-command"), commandLine: "missing" })
        ).rejects.toMatchObject({ detailCode: "command.unknown" });
        await expect(backend.cancel(executionId("missing"))).resolves.toBe(false);
    });

    test("keeps execution IDs exclusive and tokenizes quote characters inside another quote", async () => {
        expect(tokenizeShellCommand(`tool "a'b" 'c"d'`)).toEqual(["tool", "a'b", 'c"d']);
        const pending = deferred<number>();
        const registry = new ShellCommandRegistryBackend();
        registry.register("wait", { start: () => immediateProcess(pending.promise) });
        const shell = createShell(registry);
        const running = shell.run({ executionId: executionId("exclusive"), commandLine: "wait" });

        await expect(
            shell.run({ executionId: executionId("exclusive"), commandLine: "wait" })
        ).rejects.toMatchObject({ detailCode: "execution.invalid" });
        pending.resolve(0);
        await expect(running).resolves.toBe(0);
    });

    test("fails closed across force, confirmation, fence, and completion failures", async () => {
        const never = new Promise<number>(() => {});
        let fences = 0;
        const forceFailure = new ShellExecutionBoundary(
            {
                completion: never,
                forceTerminate() {
                    throw new TypeError("force failed");
                },
                confirmTerminated: () => false,
                fence() {
                    fences += 1;
                    throw new TypeError("fence failed");
                }
            },
            new ControlledTerminationClock(),
            0
        );
        await expect(forceFailure.terminate()).resolves.toBeUndefined();
        await expect(forceFailure.wait()).resolves.toBe(137);
        expect(fences).toBe(1);

        const confirmed = new ShellExecutionBoundary(
            {
                completion: never,
                forceTerminate() {},
                confirmTerminated: () => true,
                fence() {
                    throw new TypeError("confirmation should avoid fencing");
                }
            },
            new ControlledTerminationClock(),
            100
        );
        await expect(confirmed.terminate()).resolves.toBeUndefined();
        await expect(confirmed.wait()).resolves.toBe(137);

        const confirmationFailure = new ShellExecutionBoundary(
            {
                completion: never,
                forceTerminate() {},
                confirmTerminated() {
                    throw new TypeError("confirmation failed");
                },
                fence() {
                    fences += 1;
                }
            },
            new ControlledTerminationClock(),
            100
        );
        await expect(confirmationFailure.terminate()).resolves.toBeUndefined();
        await expect(confirmationFailure.wait()).resolves.toBe(137);
        expect(fences).toBe(2);

        const rejected = new ShellExecutionBoundary(
            immediateProcess(Promise.reject(new TypeError("process failed"))),
            new ControlledTerminationClock(),
            0
        );
        await expect(rejected.wait()).resolves.toBe(1);
        expect(rejected.live).toBe(false);
    });

    test("system termination clock waits in real time", { tags: "p1" }, async () => {
        const clock = new SystemShellTerminationClock();
        const start = Date.now();
        await clock.wait(30);
        expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    });

    test(
        "terminate never fences a process that terminates cooperatively",
        { tags: "p1" },
        async () => {
            let fences = 0;
            const confirmedBoundary = new ShellExecutionBoundary(
                {
                    completion: new Promise<number>(() => {}),
                    forceTerminate() {},
                    confirmTerminated: () => true,
                    fence() {
                        fences += 1;
                    }
                },
                new ControlledTerminationClock(),
                1_000
            );
            await expect(confirmedBoundary.terminate()).resolves.toBeUndefined();
            await expect(confirmedBoundary.wait()).resolves.toBe(137);
            expect(fences).toBe(0);

            const completion = deferred<number>();
            const completedBoundary = new ShellExecutionBoundary(
                {
                    completion: completion.promise,
                    forceTerminate() {
                        completion.resolve(130);
                    },
                    confirmTerminated: () => false,
                    fence() {
                        fences += 1;
                    }
                },
                new ControlledTerminationClock(),
                1_000
            );
            await expect(completedBoundary.terminate()).resolves.toBeUndefined();
            await expect(completedBoundary.wait()).resolves.toBe(130);
            expect(fences).toBe(0);
        }
    );

    test("frees the execution ID once a run completes", { tags: "p1" }, async () => {
        const registry = new ShellCommandRegistryBackend();
        registry.register("ok", { start: () => immediateProcess(Promise.resolve(0)) });
        const shell = createShell(registry);
        await expect(
            shell.run({ executionId: executionId("again"), commandLine: "ok" })
        ).resolves.toBe(0);
        await expect(
            shell.run({ executionId: executionId("again"), commandLine: "ok" })
        ).resolves.toBe(0);
    });

    test("decodes run wire inputs and cancel outputs exactly", { tags: "p1" }, () => {
        const decoded = SHELL_OPERATION_CONTRACTS.run.decodeInput({
            executionId: "wire",
            commandLine: "tool"
        });
        expect(decoded.executionId.value).toBe("wire");
        expect(decoded.commandLine).toBe("tool");
        expect(SHELL_OPERATION_CONTRACTS.cancel.decodeOutput(true)).toBe(true);
        expect(SHELL_OPERATION_CONTRACTS.cancel.decodeOutput(false)).toBe(false);
    });

    test(
        "keeps escapes literal inside single quotes and tokenizes escaped blanks",
        { tags: "p1" },
        () => {
            expect(tokenizeShellCommand("tool 'a\\b'")).toEqual(["tool", "a\\b"]);
            expect(tokenizeShellCommand("\\ ")).toEqual([" "]);
        }
    );

    test("reports shell failures with exact codes and messages", { tags: "p2" }, async () => {
        const error = new ShellError("command.empty", "example");
        expect(error.name).toBe("ShellError");
        expect(error.code).toBe("operation.invalid-input");
        expect(() => new ShellExecutionId("")).toThrow(
            "Shell execution ID must contain between 1 and 256 characters"
        );
        expect(() => new ShellExecutionId(" padded")).toThrow(
            "Shell execution ID must be canonical"
        );
        expect(() => tokenizeShellCommand("'oops")).toThrow(
            expect.objectContaining({
                detailCode: "command.invalid",
                message: "Command line has an unfinished quote or escape"
            })
        );
        const registry = new ShellCommandRegistryBackend();
        expect(() =>
            registry.register("bad name", { start: () => immediateProcess(Promise.resolve(0)) })
        ).toThrow("Shell command name must be canonical");
        const shell = createShell(registry);
        await expect(
            shell.run({ executionId: executionId("blank"), commandLine: " " })
        ).rejects.toMatchObject({ message: "Command line is empty" });
        await expect(
            shell.run({ executionId: executionId("missing"), commandLine: "missing" })
        ).rejects.toMatchObject({ message: "Unknown command: missing" });
        expect(() =>
            SHELL_OPERATION_CONTRACTS.run.decodeInput({ executionId: 5, commandLine: "tool" })
        ).toThrow("Shell execution ID must be a string");
        expect(() =>
            SHELL_OPERATION_CONTRACTS.run.decodeInput({ executionId: "wire", commandLine: 5 })
        ).toThrow("Shell command line must be a string");
    });

    test(
        "executes run and cancel through the manifest-validated internal runtime",
        { tags: "p1" },
        async () => {
            const registry = new ShellCommandRegistryBackend();
            registry.register("ok", { start: () => immediateProcess(Promise.resolve(7)) });
            const filesystem = new FilesystemFacet(
                recordingRuntime("shell-internal-fs").runtime,
                new MemoryFilesystemBackend()
            );
            const backend = new ShellBackend({ fs: filesystem }, registry, new RecordingIoBackend());
            const manifest = createShellManifest(manifestInit());
            const internal = new ShellFacet(
                recordingRuntime("shell-internal").runtime,
                backend
            ).asInternalRuntime(manifest);

            expect(internal.manifest).toBe(manifest);
            await expect(
                internal
                    .operation(new OperationName("run"))
                    ?.execute(operationContext(), { executionId: "internal-run", commandLine: "ok" })
            ).resolves.toBe(7);
            await expect(
                internal
                    .operation(new OperationName("cancel"))
                    ?.execute(operationContext(), { executionId: "internal-absent" })
            ).resolves.toBe(false);
        }
    );
});

class RecordingIoBackend extends ShellIoBackend {
    public readonly opened: string[] = [];
    public open(executionId: ShellExecutionId): ShellIo {
        this.opened.push(executionId.value);
        return emptyIo();
    }
}

class StreamingIoBackend extends ShellIoBackend {
    public readonly stdout: Uint8Array[] = [];
    public readonly stderr: Uint8Array[] = [];

    public open(): ShellIo {
        return {
            stdin: (async function* () {
                yield new Uint8Array([1]);
            })(),
            writeStdout: (bytes) => this.stdout.push(bytes),
            writeStderr: (bytes) => this.stderr.push(bytes)
        };
    }
}

function createShell(
    registry: ShellCommandRegistryBackend<unknown>,
    clock: ShellTerminationClock = new ControlledTerminationClock(true),
    confirmationMilliseconds = 0
): ShellFacet<unknown> {
    const filesystem = new FilesystemFacet(
        recordingRuntime("filesystem").runtime,
        new MemoryFilesystemBackend()
    );
    return new ShellFacet(
        recordingRuntime("shell").runtime,
        new ShellBackend(
            { fs: filesystem },
            registry,
            new RecordingIoBackend(),
            { confirmationMilliseconds },
            clock
        )
    );
}

function immediateProcess(completion: Promise<number>): ShellProcessBackend {
    return { completion, forceTerminate() {}, confirmTerminated: () => true, fence() {} };
}

class ControlledTerminationClock extends ShellTerminationClock {
    public readonly bounds: number[] = [];
    readonly #gate = deferred<void>();

    public constructor(private readonly immediate = false) {
        super();
    }

    public wait(milliseconds: number): Promise<void> {
        this.bounds.push(milliseconds);
        return this.immediate ? Promise.resolve() : this.#gate.promise;
    }

    public elapse(): void {
        this.#gate.resolve();
    }
}

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
} {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

function emptyIo(): ShellIo {
    return {
        stdin: (async function* (): AsyncIterable<Uint8Array> {})(),
        writeStdout() {},
        writeStderr() {}
    };
}

function executionId(value: string): ShellExecutionId {
    return new ShellExecutionId(value);
}

function manifestInit() {
    return {
        id: new FacetPackageId("profile.shell"),
        version: new SemVer("1.0.0"),
        compat: new CompatRange("^1.0.0", "^1.0.0"),
        bindings: [
            new BindingRequirement(
                new BindingName(SHELL_REQUIRED_BINDING),
                new FacetPackageId(`dependency.${SHELL_REQUIRED_BINDING}`),
                new CompatRange("^1.0.0", "^1.0.0")
            )
        ]
    };
}

function operationContext(): OperationContext {
    return {
        invocation: new InvocationId("shell-internal-invocation"),
        itemIndex: 0,
        idempotencyKey: "shell-internal-idempotency",
        signal: new AbortController().signal,
        content: new MemoryContentStore()
    };
}
