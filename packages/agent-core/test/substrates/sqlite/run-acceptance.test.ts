import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorId, ActorRef } from "../../../src/actors";
import {
    AcceptanceCriterion,
    AcceptanceId,
    AcceptanceVerdict,
    RunRepository
} from "../../../src/agents";
import { OperationRef } from "../../../src/facets";
import { ReceiptId } from "../../../src/invocation-references";
import { SqliteRunStorage } from "../../../src/substrates/sqlite/run";
import { FileSqlite } from "../../helpers/sqlite";
import { digest } from "../../agents/runs/fixture";

const owner = new ActorRef("workspace", new ActorId("workspace-run-owner"));

describe("SQLite Run acceptance storage", () => {
    it(
        "[run.acceptance-criterion] [run.acceptance-verdict] survive file-backed close and reopen with exact identities intact",
        { tags: "p0" },
        () => {
            const directory = mkdtempSync(join(tmpdir(), "w5-run-acceptance-sqlite-"));
            const path = join(directory, "acceptance.sqlite");
            const acceptance = new AcceptanceId("restart-acceptance");
            const criterion = new AcceptanceCriterion({
                id: acceptance,
                operation: new OperationRef("verifier-package:verify")
            });
            const recorded = new AcceptanceVerdict({
                acceptance,
                subject: digest("e"),
                receipt: new ReceiptId("restart-verifier-receipt")
            });
            try {
                const firstDatabase = new FileSqlite(path);
                const repository = new RunRepository(new SqliteRunStorage(firstDatabase, owner));
                repository.transaction((tx) => {
                    repository.insertAcceptanceCriterion(tx, criterion);
                    repository.insertAcceptanceVerdict(tx, recorded);
                });
                firstDatabase.close();

                const secondDatabase = new FileSqlite(path);
                const restarted = new RunRepository(new SqliteRunStorage(secondDatabase, owner));
                expect(
                    restarted.transaction((tx) => restarted.loadAcceptanceCriterion(tx, acceptance))
                ).toEqual(criterion);
                expect(
                    restarted.transaction((tx) =>
                        restarted.loadAcceptanceVerdict(tx, acceptance, digest("e"))
                    )
                ).toEqual(recorded);
                expect(
                    restarted.transaction((tx) =>
                        restarted.loadAcceptanceVerdict(tx, acceptance, digest("f"))
                    )
                ).toBeUndefined();
                expect(() =>
                    restarted.transaction((tx) =>
                        restarted.insertAcceptanceVerdict(
                            tx,
                            new AcceptanceVerdict({
                                acceptance,
                                subject: digest("e"),
                                receipt: new ReceiptId("conflicting-receipt")
                            })
                        )
                    )
                ).toThrow(/immutable/);
                secondDatabase.close();
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        }
    );
});
