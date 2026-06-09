# Contributing to agent-coord-mcp

Thanks for your interest. This is a small, focused project — contributions that stay within that spirit are most welcome.

## What we want

- Bug fixes
- New MCP tools or improvements to existing ones
- Better tests (especially around identity binding and delivery edge cases)
- Documentation improvements
- `coord-chat` TUI polish

If you have a larger idea (a new phase, a new transport, federation), open an issue first to discuss it before writing code.

## Setup

```sh
git clone https://github.com/davidbalzan/agent-coord-mcp.git
cd agent-coord-mcp
npm install        # also builds via the `prepare` hook
```

Run the server directly during development:

```sh
npm run dev        # tsx watch — no manual rebuild needed
```

Or build and run:

```sh
npm run build
node dist/server.js
```

**Node ≥ 18** required.

## Tests

```sh
npm test
```

Tests live in `test/`. They spawn real stdio server subprocesses and make real MCP tool calls — no mocks. Keep it that way: the integration tests catch things unit tests miss (delivery timing, identity binding across session boundaries, cursor math).

New tools should have tests covering at minimum:
- The happy path
- Rejection when the caller's identity doesn't match
- Edge cases specific to the tool (e.g. idempotency, empty results)

A clean `doctor()` run is included in the test suite as an end-to-end consistency check. Your changes shouldn't break it.

## Code style

- TypeScript, strict mode
- No `any` unless it genuinely simplifies — define a proper type
- No comments explaining *what* the code does — only add a comment when the *why* is non-obvious
- Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`

## Project conventions

**State is JSONL-backed.** Coordination happens through `~/agent-coord/` files. New features should read/write those files using the existing lock/append patterns in `src/store.ts` — don't introduce a database or in-memory-only state.

**Tools are self-contained.** Each MCP tool is registered in `src/tools.ts` and calls into `src/store.ts`. Keep the boundary clean.

**Identity gate.** Every tool that takes a `from` or `agentId` must pass through `gate()`. Do not add a new caller-identity parameter and skip the gate — that's how spoofing bugs happen.

**Backward compatibility.** The JSONL schema and tool signatures are used by Claude Code, Cursor, and other clients that may be pinned to older versions. Prefer additive changes (new optional fields, new tools) over breaking changes.

## Submitting a PR

1. Fork the repo and create a branch: `git checkout -b feat/your-thing`
2. Write the change + tests
3. Run `npm test` — all tests must pass
4. Commit with a conventional commit message
5. Open a PR with a short description of what it does and why

PRs that touch the identity/binding code, the lock/write path, or the delivery pipeline will get extra scrutiny — these are the surfaces where bugs have real consequences.

## Reporting bugs

Open a GitHub issue. Include:
- What you expected to happen
- What actually happened
- The relevant section of `~/agent-coord/` state (redact any tokens)
- Your Node version and OS
