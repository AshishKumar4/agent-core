import type { AuthorityPermitOwnerStore } from "@agent-core/core/authority";
import type { SynchronousResultGuard } from "@agent-core/core";
import { PermitIssuerDurableObjectHost } from "../src/index.js";
import { malformedInput } from "./assertions.js";

describe("PermitIssuerDurableObjectHost", () => {
    test("rejects a malformed RPC nonce before consulting the permit store", () => {
        let transactions = 0;
        const store: AuthorityPermitOwnerStore<undefined> = {
            transaction: <Result>(
                operation: (transaction: undefined) => Result,
                ..._guard: SynchronousResultGuard<Result>
            ): Result => {
                transactions += 1;
                return operation(undefined);
            },
            issued: () => undefined,
            consumed: () => undefined,
            issue: (_transaction, permit) => permit,
            consume: () => undefined
        };
        const host = new PermitIssuerDurableObjectHost(store);

        expect(host.issuedPermitRecord(malformedInput<string, number>(1))).toBeUndefined();
        expect(host.issuedPermitRecord("")).toBeUndefined();
        expect(transactions).toBe(0);
    });
});
