import { BindingName, ProtectionDomain } from "../../src/facets";
import type { TurnLeaseCommit, TurnLeaseVerifier } from "../../src/agents";
import type { AuthorityVerifier, BindingAuthority } from "../../src/authority";
import { Principal, PrincipalId } from "../../src/identity";
import { OperationContext, OperationId } from "../../src/operations";
import { NoopObservability, ObservationContext } from "../../src/observability";

export function testOperationContext(
    name: string,
    binding: BindingName = new BindingName("test"),
    authority: BindingAuthority | undefined = undefined,
    authorityVerifier: AuthorityVerifier | undefined = undefined,
    lease: TurnLeaseCommit | undefined = undefined,
    leaseVerifier: TurnLeaseVerifier | undefined = undefined
): OperationContext {
    const init = {
        id: new OperationId(`operation-${name}`),
        principal: new Principal(new PrincipalId(`principal-${name}`), "service", "active"),
        domain: new ProtectionDomain("backend", "test", "no-secrets"),
        binding,
        lease,
        observability: new NoopObservability(ObservationContext.root(`trace-${name}`, `span-${name}`))
    };

    return new OperationContext({
        ...init,
        ...(authority === undefined ? {} : { authority }),
        ...(authorityVerifier === undefined ? {} : { authorityVerifier }),
        ...(leaseVerifier === undefined ? {} : { leaseVerifier })
    });
}
