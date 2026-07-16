// @ts-nocheck
declare module "bun:sqlite" {
    export class Database {
        public constructor(filename: string);

        public query<Row, Binding extends readonly unknown[]>(
            statement: string
        ): {
            all(...bindings: Binding): readonly Row[];
            run(...bindings: Binding): void;
        };

        public transaction<Result>(operation: () => Result): () => Result;
    }
}
