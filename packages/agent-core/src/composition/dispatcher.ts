import type { CommandDispatcherInit, RegisteredProtocolCommand } from "../protocol";
import { CommandDispatcher } from "../protocol";

export interface ClosedCommandFamilies<Transaction, Read> {
    readonly bootstrap?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly authority?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly facets?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly runs?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly invocations?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly sourceRouting?: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly targetRouting?: readonly RegisteredProtocolCommand<Transaction, Read>[];
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
