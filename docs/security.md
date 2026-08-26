# Security

GenXEvo's job is to be the part of the system that **does not guess**. The model
reasons; the server refuses.

## Threat model

The agent is not the adversary, but it is influenceable. Content in the
automation project — a README, a test fixture, a comment in a page object — can
be written by anyone with commit access and reaches the model as text. So the
rules are:

1. **The server refuses, not the model.** Every boundary is enforced in code
   before a value exists, not by asking the model to behave.
2. **Project content is data, never instruction.** It is framed as `untrusted`
   and the server instructions tell the agent so on every session.
3. **A secret that reaches a transcript has left the operator's control.**
   Redaction happens at the server, before the value is placed in a result.

## The controls

### Path containment

Five steps, in this order: structural checks, canonicalisation, containment,
deny-list, intent gate.

Canonicalisation walks up to the deepest existing ancestor and resolves it with
`fs.realpathSync.native`, so **symlinks and Windows junctions are resolved before
containment is tested** — a link pointing out of the workspace is refused rather
than followed. Containment is part-wise via `path.relative`, so `/work/project`
does not contain `/work/project-evil`.

Structural checks are pure functions with an explicit `windows` flag, so Windows
rules are tested on every platform: UNC paths, device paths, drive-relative
paths, and **alternate data streams**. The ADS check examines _every_ colon, not
only the first — `C:\x\f.txt:hidden` is refused. Both sibling products accept it;
this one does not, and there is a test naming the case.

A refusal echoes the candidate you supplied, **never the resolved path**. The
boundary's location is not the agent's business, and a transcript that records it
hands an attacker the map.

### The deny-list applies to every read

`**/.npmrc`, `**/.yarnrc*`, `**/.pnpmfile.cjs`, `**/.env*`, key material and
their kind are **never opened**, rather than opened and filtered.

This is the correction of a real defect both siblings ship: their deny-lists were
true for agent-supplied paths and false for server-initiated ones, and one of
them probed every source file directly while its deny-list named the very files
holding framework secrets. Here, `boundedRead` is the **single door** every
server-initiated read goes through, and discovery reads through it — so the
control has a live call site rather than a unit test and no caller.

`node_modules` is never walked. `node_modules/.package-lock.json` is read by
direct path, because what is _installed_ is frequently not what a project
_declares_, and an agent that cannot tell those apart will debug the wrong thing.

### Redaction

Key-aware patterns run **before** value-shape patterns, and key exemptions match
a **whole normalised identifier**, not a substring — so `passwordFieldLocator`
survives (an agent must be able to repair the locator it was asked to look at)
while `AuthModePassword` is redacted. Both siblings get that second case wrong by
short-circuiting on `includes()`.

JavaScript-specific shapes are covered because this is a JavaScript product:
`.npmrc` `_authToken` lines, `npm_` tokens, template-literal assignments, and
credentials passed as command-line flags — the last found by the end-to-end MCP
test rather than by review, because `package.json` script values _are shell
command lines_ and discovery publishes a manifest excerpt.

JSON is parsed **raw and then redacted by key**, never redacted as text and then
parsed: substituting a marker into a string containing an escaped quote produces
text that is no longer valid JSON, and the manifest would be reported as
unparseable when it was merely sensitive.

Every quantifier is bounded and input is capped at 1 MiB. See the note on regex
timeouts in [architecture.md](architecture.md); in JavaScript this is a liveness
control, not a performance nicety.

### Error sanitisation

Internal exceptions never reach the client. `sanitiseInternal` keeps only the
exception's constructor name and, when present, a Node system code such as
`ENOENT`. No message, no stack trace, no path. What the agent gets is a
structured GenXEvo error with a code, a category, a `retryable` flag **derived**
from the category rather than set by hand, and a remediation it can act on.

### Selection validation

Any selection beginning with `-` is refused outright, before kind dispatch,
because every JavaScript runner has at least one flag that loads and executes an
arbitrary module: `--require`, `--config`, `--setupFiles`, `--globalSetup`,
`--import`, `--loader`, `--reporter`. `NODE_OPTIONS` can inject `--require` into
every child process, so phase 1D strips it from the child environment rather than
validating around it.

A `testName` selection is accepted as a **literal substring only**. Mocha's
`--grep` and Jest's `-t` treat their argument as a regular expression, which is
both a selection surprise and — given that JavaScript regexes cannot be timed out
— a way to hang the runner. Metacharacters are refused rather than escaped,
because escaping quietly changes what the agent asked for.

Two layers protect the process boundary and both are required: this validator,
and an argument **array** with no shell. Neither alone is sufficient.

### Execution

This build starts no process. There is no `child_process` import anywhere in
`src/`, and a lint rule enforces the absence rather than a comment promising it.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
