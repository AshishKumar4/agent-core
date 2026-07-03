# Important instructions:

**We have never made the codebase public and thus there is absolutely no need for any kind of 'migrations' or 'keeping things backward compatible'. If something is dead/stale, just remove and build things better. **

## 1. Coding Standards & Conventions
​
**Code Style:** Follow established language-specific style guides. Automated formatting tools are mandatory. Use oxlint for JavaScript/TypeScript and ruff for Python.
​
**Modularity:** Code must be organized into logical, small, and reusable functions/modules. Business logic should be strictly separated from input/output handling.
​
**Readability:** Use clear, descriptive names for variables, functions, and classes. Add meaningful, concise, clean and straightforward comments where the *why* of the code is not immediately obvious.

**Pure Functions:** Prefer pure functions over impure ones. Pure functions have no side effects and are easier to test and reason about.

**Object Orientation:** Use object-oriented programming principles where appropriate. Encapsulate data and behavior together in classes.

**Rely on abstractions:** Use abstraction to hide complexity and make code more maintainable. Inherit from base classes when possible. If two classes have similar functionality, consider creating a base class.

**Elegance, simplicity, minimalism:** Everything should be designed with elegance, simplicity, and minimalism in mind, over hacky, short term solutions. Avoid over-engineering and unnecessary complexity which does not add value. But this doesn't mean sacrificing functionality, reliability, or performance. We always design for long term maintainability and scalability.

**Avoid hard coding strings and values:** Avoid hard coding strings and values. Use constants or configuration files instead.

**Avoid magic numbers:** Avoid magic numbers. Use constants or configuration files instead.

**Design with observability and tracing in mind:** Design with observability and tracing in mind. Use logging, metrics, and tracing to understand the behavior of the system. Design components, classes and functions with observability in mind. Build observability into the design from the start, using elegant primitives such as decorators and middleware.

**Design with error handling in mind:** Design with error handling in mind. Use try-catch blocks to handle errors gracefully. Use custom exceptions to provide more context about the error. Look into the Effects TS library and Better Results library. I love golang's error handling patterns.

**Strict typing:** Use strict typing to ensure type safety and prevent runtime errors. Use TypeScript's type system to catch errors at compile time.

**Rely on existing libraries and frameworks:** Use existing libraries and frameworks whenever possible to avoid reinventing the wheel. Always research on the latest best available options.

**Organize code:** Organize code in a logical and consistent manner. Use consistent naming conventions and file structure.

**Formal verification:** Use formal verification tools to ensure logical correctness and reliability.

**Research, ideate and architecture first:** Always research, ideate and architecture before implementing any code. This ensures that the code is well-designed and follows best practices.

**Audit and review:** Regularly audit and review code to ensure it meets the established standards and best practices.

**DRY** (Don't Repeat Yourself): Avoid code duplication by creating reusable functions and modules.

**Modularity and composition:** Break down complex problems into smaller, manageable modules that can be composed together to solve the problem.

​
## 2. Testing & Quality Assurance
​
**Unit Tests:** Every new feature or fix must be accompanied by comprehensive unit tests that cover core functionality and edge cases.

**Test Coverage:** *Requirement:* Code coverage must not decrease below the established project threshold (e.g., 80%).

**Integration Tests:** Implement tests to verify the agent's interaction with external APIs and databases.
​
**Test Framework:** Specify the required testing framework (e.g., Jest, Pytest).
​
**Mocking:** Use mocking for external service dependencies to ensure tests are fast, reliable, and isolated. But rely on real services whenever possible, such as using wrangler/vitest for durable objects.

**Functional Testing:** Implement tests to verify every component's ability to perform its intended functions.

**Always write tests decoupled from the implementation details.**

IMPORTANT: This repository uses pnpm, not npm. Always use pnpm.

IMPORTANT: Remember when using RPC to use promise pipelining whenever possible. Cap'n Web implements promise pipelining (similar to Cap'n Proto). This means that if an RPC returns a stub, it's not necessary to await the RPC -- the promise itself can be used in place of the stub. Also, Cap'n Web lets you use the promise for a future result (even if it isn't a stub) in the arguments for another call; the promise will be replaced with its resolution on the server side before delivering the arguments. See the Cap'n Web README.md for more details.

IMPORTANT: When using React's useState(), the state value cannot be an RPC stub. At runtime, all stubs appear to be callable (because the system doesn't actually know if the stub points to a function on the server side or not). But the setter returned by useState() has different behavior if passed a function (including any callable object): it calls the function in order to get the state. In order to avoid this problem, whenever a useState() state will contain an RpcStub, it's important to wrap the stub in an object, and set the state to that object instead.

IMPORTANT: RPC stubs must be disposed to prevent resource leaks on the server side. Call `stub[Symbol.dispose]()` when the stub is no longer needed (or use a `using` declaration where possible). In particular, when a React component obtains a stub in a useEffect, the cleanup function should dispose the stub.
