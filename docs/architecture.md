# Architecture

## The shape

```
src/
  core/                  ZERO third-party imports. Enforced by a test, not by convention.
    contract/            The envelope, the vocabularies, the schema, the validator
    security/            Path boundary, deny-list, redaction, bounded reads, selection
    config/              Defaults, validation, precedence
    discovery/           The workspace scan and what it concludes
    capabilities/        The two real capabilities, the catalogue, the invoker
    runs/                Run identity and directory model (used from phase 1D)
    support/             Clock, tokens, freezing, startup parsing
  mcp/                   The ONLY place the MCP SDK appears
    main.js              Process entry, and the stdout guard
    server.js            Tool registration; a thin adapter with no policy in it
    toolSchemas.js       The published input/output schemas
```

The dependency runs one way: `mcp` imports `core`, `core` never imports `mcp`,
and `core` never imports the SDK. `test/architecture.test.js` enforces all three
by scanning the source, because **npm has no per-directory dependency scoping
inside one package** — in C# this would be a project reference and in Maven a
compile classpath; in JavaScript that test is the only thing there is.

## The envelope

One envelope, nine statuses, emitted in a fixed key order.

| status               | meaning                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `success`            | The operation did what was asked.                                          |
| `partialSuccess`     | It worked, but something was truncated or unreadable. **Read `warnings`.** |
| `failure`            | The operation ran and did not succeed.                                     |
| `validationError`    | The caller sent something wrong.                                           |
| `configurationError` | An operator must change something before this can work.                    |
| `blocked`            | The server refused on security grounds. Do not retry the same request.     |
| `timeout`            | A deadline elapsed.                                                        |
| `cancelled`          | The client cancelled. British spelling, and it is the wire value.          |
| `skipped`            | The operation was deliberately not performed.                              |

`configurationError` and `blocked` exist as separate statuses so an agent can tell
"you must ask a human" and "stop asking" apart from "try again", which is the
distinction that decides whether a retry loop terminates.

**Status is DERIVED from the error's category**, so the two cannot disagree:
`validation` yields `validationError`, `configuration` yields `configurationError`,
`security` yields `blocked`, `timeout` and `cancelled` yield themselves, and every
remaining category - including `notImplemented`, `internal`, `environment` and
`notFound` - yields `failure`. So a call to a planned-but-unbuilt capability comes
back as `status: "failure"` carrying `error.category: "notImplemented"`; the
category is what tells an agent not to retry.

**Key order is part of the contract.** `JSON.stringify` emits string keys in
insertion order (ECMA-262), so an agent reading the text block sees `status`
before it has scrolled past a large `data`. `validateKeyOrder()` enforces it and
the invoker checks it on every result. There is no `[JsonPropertyOrder]`
equivalent to reach for and none is needed.

## Validation is ours

Measured against the real SDK: the low-level `Server` path **does not enforce
`outputSchema`**. A payload missing a required field, and one carrying a value
outside the published enum, were both delivered to the client untouched. There
is no safety net on that path.

So `envelopeSchema.js` is a frozen plain object with two consumers — it is
published to `tools/list` _and_ it is what `validateEnvelope()` checks every
result against before the result leaves the server. One artefact, no generator in
between, and no way for the promise and the check to drift apart.

That is also why the adapter uses the low-level `Server` rather than `McpServer`.
`McpServer.registerTool` rejects a raw JSON Schema and demands a Zod schema,
which would put a third-party library's semantics and release cadence between
GenXEvo and its own published contract.

## Cancellation

The SDK hands each call a live `AbortSignal`. The invoker composes it with its
own deadline via `AbortSignal.any([extra.signal, AbortSignal.timeout(ms)])` and
every long-running API takes a signal. Timeout and cancellation are reported as
**different statuses**, because an agent should retry one and not the other.

One JavaScript-specific hazard shapes the security code: **there is no regex
timeout and no way to interrupt a match.** A runaway match blocks the single
event loop, so the server stops answering everything — including the client's
cancellation, because a signal is only observed between turns of the loop and a
match is one turn. Every quantifier in `redaction.js` is therefore bounded, input
is capped at 1 MiB before any pattern runs, and the tests assert bounded work
against a wall clock.

## stdout

stdout belongs to the JSON-RPC transport, and three layers keep it clean. The
**runtime guard** in `main.js` is primary: the real stdout is captured into its
own stream before anything else runs and handed only to the transport, and
`process.stdout.write` is pointed at stderr for the life of the process. It has
to be primary here, because the SDK brings thirty-four transitive packages into
this process and no lint rule or source scan can see inside `node_modules`. The
guard runs before the SDK is loaded — static ESM imports are hoisted, so every
module that touches the SDK is imported **dynamically**, after the guard. Layer
two is a source-scan test; layer three is a CI assertion that `--version` writes
zero bytes to stdout using the `2>&1 >/dev/null` form, which proves the banner is
on stderr rather than merely absent from stdout.

## Evidence and trust

Every observation carries a trust level, and there are exactly two:
GenXEvo's own conclusions are `trusted`; anything that came out of your project is
`untrusted`, redacted and framed. Discovery emits at least one untrusted excerpt of a real project file on
every run, which means the boundary, the deny-list, the redactor and the framing
all have a live production call site and an end-to-end test — rather than being
built, unit-tested, and called from nowhere.
