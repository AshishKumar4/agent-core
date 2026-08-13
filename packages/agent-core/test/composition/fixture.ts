/**
 * A record's own fields, writable, so a test can assemble an init one field at a time and add
 * an optional field only when it is present. Writing an absent field as `undefined` is not the
 * same thing under `exactOptionalPropertyTypes`.
 */
export type Assembled<Fields> = { -readonly [Field in keyof Fields]: Fields[Field] };

/**
 * A stand-in for a port the test drives down a single path. These port interfaces are wide —
 * InvocationPersistence alone declares twenty members — so writing throwing stubs for the ones a
 * path never reaches would be a copy of the interface that drifts from it. The members the path
 * does reach are spelled out and typed against the real port.
 */
export function reaching<Port>(reached: Partial<Port>): Port {
    // SAFETY: only the members present on `reached` may be called. A path that grows a call to an
    // absent one fails at that call rather than reading a wrong answer from a stub.
    return reached as never;
}

/**
 * A placeholder for an argument a port only forwards. A delegation test asserts which source
 * method ran, not what it was handed; reading any property of one throws, so a port that starts
 * inspecting a forwarded argument fails there instead of passing on an undefined field.
 */
export function forwarded<Value>(): Value {
    const unread = new Proxy(
        {},
        {
            get(_target, property) {
                throw new TypeError(`A forwarded argument was read: ${String(property)}`);
            }
        }
    );
    // SAFETY: the proxy stands in for a value the port under test never reads. It satisfies no
    // member of `Value`, and reading one throws rather than answering.
    return unread as never;
}
