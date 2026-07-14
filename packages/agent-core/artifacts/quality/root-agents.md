# Workspace Instruction Snapshot

This checked-in snapshot preserves the cross-cutting workspace rules used by the W0
compliance checker in clean CI environments.

- Maintain a todo list for complex or long-running tasks and update it as work progresses.
- Avoid large downloads and unnecessary generated artifacts in the limited workspace.
- Work in isolated worktrees, do not modify unrelated concurrent changes, and commit only owned files.
- Use pnpm where the repository-local instructions require it.
- Search for and respect every applicable AGENTS.md file.
- Keep code DRY, simple, resilient, self-documenting, and architecturally correct.
- Comments explain why rather than narrating what code does.
