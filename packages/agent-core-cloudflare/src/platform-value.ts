/**
 * What the Workers runtime hands back is untyped by construction: a Worker Loader
 * handle, a dispatch namespace service, an agent-authored entry point and whatever a
 * storage transaction callback returned all arrive with no contract this program can
 * check. The only evidence available is what the value carries under the one name about
 * to be used, so that read happens once here and each caller names the contract the
 * member belongs to.
 */
export function platformMember<Contract extends object>(
    value: unknown,
    member: (candidate: Partial<Contract>) => Contract[keyof Contract] | undefined
): Contract[keyof Contract] | undefined {
    // A stub is an object; an entry point exported as a function is equally one.
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return undefined;
    }
    // SAFETY: the check above established that `value` carries properties, so reading one
    // through the contract's optional view is a plain property get that cannot throw, and
    // what comes back is still checked before any caller's narrowing rests on it. The read
    // has to stay a property get: the runtime's stubs are Proxies that answer through
    // their `get` trap alone, so `in` and own-property descriptors report members that are
    // really there as absent.
    return member(value as Partial<Contract>);
}

/** The usual question: does the value answer the method the caller is about to call. */
export function answersPlatformMethod<Contract extends object>(
    value: unknown,
    member: (candidate: Partial<Contract>) => Contract[keyof Contract] | undefined
): boolean {
    // `typeof` rather than `instanceof Function`, because these values cross an isolate
    // boundary and a function built in another realm has a different `Function`.
    return typeof platformMember(value, member) === "function";
}
