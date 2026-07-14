import type { CommandDispatcherInit, ProtocolCommand } from "../protocol";
import { CommandDispatcher } from "../protocol";

export interface ClosedCommandFamilies<Transaction, Read> {
    readonly bootstrap?: readonly ProtocolCommand<Transaction, Read>[];
    readonly authority?: readonly ProtocolCommand<Transaction, Read>[];
    readonly facets?: readonly ProtocolCommand<Transaction, Read>[];
    readonly runs?: readonly ProtocolCommand<Transaction, Read>[];
    readonly invocations?: readonly ProtocolCommand<Transaction, Read>[];
    readonly sourceRouting?: readonly ProtocolCommand<Transaction, Read>[];
    readonly targetRouting?: readonly ProtocolCommand<Transaction, Read>[];
}

export type ClosedDispatcherInit<Transaction, Read, ReadTransaction = Transaction> = Omit<
    CommandDispatcherInit<Transaction, Read, ReadTransaction>,
    "commands"
> & {
    readonly commands: ClosedCommandFamilies<Transaction, Read>;
};

export function createClosedCommandDispatcher<Transaction, Read, ReadTransaction = Transaction>(
    init: ClosedDispatcherInit<Transaction, Read, ReadTransaction>
): CommandDispatcher<Transaction, Read, ReadTransaction> {
    const commands = Object.freeze([
        ...(init.commands.bootstrap ?? []),
        ...(init.commands.authority ?? []),
        ...(init.commands.facets ?? []),
        ...(init.commands.runs ?? []),
        ...(init.commands.invocations ?? []),
        ...(init.commands.sourceRouting ?? []),
        ...(init.commands.targetRouting ?? [])
    ]);
    return new CommandDispatcher({ ...init, commands });
}
