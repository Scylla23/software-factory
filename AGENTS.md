# Repository guidance

- Use the pinned Bun version and install dependencies with `bun install --frozen-lockfile`.
- Run `scripts/test-watchdog.sh` and `bun run typecheck` from a macOS checkout outside the system temp directory.
- Add regression coverage in the existing Bun suite and follow the coverage and mutation rules in the [testing policy](docs/testing-policy.md).
- Preserve owner and commit binding at both approval gates, attempt receipts across restarts, and task, role, and session binding on structured outputs.
- Keep publishing credentials with the controller and keep agent reads, writes, and tools scoped to the role.
