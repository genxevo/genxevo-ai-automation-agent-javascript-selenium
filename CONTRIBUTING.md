# Contributing

## The bar

This product exists to stop an agent producing confident, plausible, wrong
answers. The same bar applies to the code:

- **Every claimed capability has an automated test.** If it is in a description,
  a document or a result field, something asserts it.
- **No stubs.** A function that returns "not implemented" is not a contribution.
  Publish the capability as `planned` in the catalogue instead.
- **Comments say _why_, not _what_.** The code says what. A comment that
  paraphrases the line below it will be removed; a comment recording a rejected
  alternative will be kept forever.
- **Uncertainty is stated, never hidden.** `unknown`, `low` confidence and
  `partialSuccess` are correct answers.

## Before you open a pull request

```bash
npm install
npm run verify      # lint, format, tests with enforced coverage, package check
bash scripts/check.sh                # macOS / Linux
powershell -File scripts\check.ps1   # Windows
```

`npm run verify` must pass. Coverage thresholds are a **ratchet**: they may go up
in a PR that raises coverage, and they do not come down.

## Rules that are enforced, not requested

A test will fail if you break one of these, which is deliberate — convention
alone does not survive contact with a deadline.

| Rule                                                           | Enforced by                 |
| -------------------------------------------------------------- | --------------------------- |
| `src/core` imports only `node:` builtins and relative paths    | `test/architecture.test.js` |
| `src/core` never mentions the MCP SDK                          | same                        |
| The SDK appears only under `src/mcp`                           | same                        |
| Exactly one runtime dependency, pinned exactly                 | same                        |
| The transitive dependency count stays under its stated ceiling | same                        |
| Exactly one line in the source touches `process.stdout`        | same                        |
| No `console.log` anywhere                                      | same, plus ESLint           |
| No source file contains a raw control character                | same                        |
| No `child_process` import                                      | ESLint                      |

## Adding a capability

1. Add it to `src/core/capabilities/catalog.js` as `planned` first, with its
   phase and safety class. That single entry drives the documentation,
   `genxevo_agent_status` and the published MCP annotations, so they cannot
   drift.
2. Implement it in `core`, with no SDK import and no knowledge that MCP exists.
3. Register it in `src/mcp/server.js` — a thin adapter, no policy, no I/O, no
   branching. Nothing that could be wrong is allowed to live in a tool handler,
   because a handler cannot be unit tested through an MCP client.
4. Flip its catalogue state to `available` in the same commit that adds its
   tests, including an end-to-end assertion in `test/mcp.test.js`.

## Changing the contract

The envelope is versioned (`contractVersion`). Adding an optional field is a
minor change; changing a status value, a key order or a required field is a
breaking change and needs an ADR in `docs/decisions.md` stating the rejected
alternative.

## Style

Prettier and ESLint decide formatting and lint; do not argue with them in review.
British spelling in prose and in the one place it reaches the wire (`cancelled`).
Comments are full sentences.
