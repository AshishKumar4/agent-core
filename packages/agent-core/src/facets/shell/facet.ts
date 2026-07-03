import { AuthoritySummary, FacetDescription } from "../description";
import { Facet } from "../facet";
import type { FacetContext } from "../context";
import { FacetDataSchemas, type FacetDataMap } from "../data";
import { FacetOperationName, FacetVersion } from "../id";
import { FacetOperation, FacetOperationHandler, OperationDescriptor, OperationSet } from "../operation";
import type { OperationContext } from "../../operations";
import type { Shell } from "./index";

const version = new FacetVersion("1.0.0");

export class ShellFacet extends Facet {
    public constructor(
        context: FacetContext,
        private readonly shell: Shell
    ) {
        super(context);
    }

    public describe(): FacetDescription {
        return new FacetDescription(
            "Shell",
            "Executes shell commands through a bound virtual filesystem.",
            version,
            AuthoritySummary.scoped("Executes commands against the bound shell environment.")
        );
    }

    public operations(): OperationSet {
        return OperationSet.of([
            new FacetOperation(
                new OperationDescriptor(
                    new FacetOperationName("exec"),
                    "Execute a shell command.",
                    "execute",
                    FacetDataSchemas.object(),
                    FacetDataSchemas.object()
                ),
                new ExecHandler(this.shell)
            )
        ]);
    }
}

class ExecHandler extends FacetOperationHandler<FacetDataMap, FacetDataMap> {
    public constructor(private readonly shell: Shell) {
        super();
    }

    public async execute(_context: OperationContext, input: FacetDataMap): Promise<FacetDataMap> {
        const result = await this.shell.exec(stringField(input, "command"), optionalStringField(input, "stdin"));
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode
        };
    }
}

function stringField(input: FacetDataMap, field: string): string {
    const value = input[field];
    if (typeof value !== "string") {
        throw new TypeError(`${field} must be a string`);
    }

    return value;
}

function optionalStringField(input: FacetDataMap, field: string): string | undefined {
    const value = input[field];
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new TypeError(`${field} must be a string`);
    }

    return value;
}
