/**
 * What the Workers runtime hands back is untyped by construction: a Worker Loader
 * handle, a dispatch namespace service, an agent-authored entry point and whatever a
 * storage transaction callback returned all arrive with no contract this program can
 * check. The only evidence available is whether the value answers the one method about
 * to be called on it, so that question is asked once here and each caller names the
 * contract the method belongs to.
 */
export function answersPlatformMethod<Contract extends object>(
    value: unknown,
    member: (candidate: Partial<Contract>) => Contract[keyof Contract] | undefined
): boolean {
    // A stub is an object; an entry point exported as a function is equally one.
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return false;
    }
    // SAFETY: the check above established that `value` carries properties, so reading one
    // through the contract's optional view is a plain property get that cannot throw, and
    // the result is proved callable before any caller's `value is Contract` rests on it.
    // The read has to stay a property get: the runtime's stubs are Proxies that answer
    // through their `get` trap alone, so `in` and own-property descriptors miss members
    // that are really there.
    const method = member(value as Partial<Contract>);
    // `typeof` rather than `instanceof Function`, because these values cross an isolate
    // boundary and a function built in another realm has a different `Function`.
    return typeof method === "function";
}
