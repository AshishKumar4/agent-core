import { DatabaseSync } from "node:sqlite";

export class Database {
    #database;

    constructor(filename) {
        this.#database = new DatabaseSync(filename);
    }

    query(statement) {
        const prepared = this.#database.prepare(statement);

        return {
            all: (...bindings) => prepared.all(...bindings),
            run: (...bindings) => {
                prepared.run(...bindings);
            }
        };
    }

    transaction(operation) {
        return () => {
            this.#database.exec("BEGIN");

            try {
                const result = operation();
                this.#database.exec("COMMIT");
                return result;
            } catch (error) {
                this.#database.exec("ROLLBACK");
                throw error;
            }
        };
    }
}
