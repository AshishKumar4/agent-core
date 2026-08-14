import type { AuthorityPermitIssueStore } from "@agent-core/core/authority";
import type { SynchronousResultGuard } from "@agent-core/core";
import { ActorId, ActorRef } from "@agent-core/core/actors";
import { PermitIssuerDurableObjectHost } from "../src/index.js";
import { malformedInput } from "./assertions.js";

describe("PermitIssuerDurableObjectHost", () => {
    test("rejects a malformed RPC nonce before consulting the permit store", () => {
        let transactions = 0;
        const store: AuthorityPermitIssueStore<undefined> = {
            owner: new ActorRef("tenant", new ActorId("permit-host")),
            transaction: <Result>(
                operation: (transaction: undefined) => Result,
                ..._guard: SynchronousResultGuard<Result>
            ): Result => {
                transactions += 1;
                return operation(undefined);
            },
            issued: () => undefined,
            issue: (_transaction, permit) => permit
        };
        const host = new PermitIssuerDurableObjectHost(store);

        expect(host.issuedPermitRecord(malformedInput<string, number>(1))).toBeUndefined();
        expect(host.issuedPermitRecord("")).toBeUndefined();
        expect(transactions).toBe(0);
    });
});
