# Troubleshooting

## The server does not appear in the client's tool list

Almost always the command or path in the client configuration. Run it by hand:

```bash
node /abs/path/to/src/mcp/main.js --version
```

That writes to **stderr** and leaves stdout empty, on purpose. Silence on stdout
is the correct result, not a symptom.

On Windows, check that backslashes are escaped in the JSON.

## Every tool returns "not configured"

No workspace was approved. The workspace is never inferred — not from the current
directory, not from an environment variable that happened to be set. Add
`--workspace` to the client configuration and restart the client.

The server starting unconfigured is deliberate: a server that exits leaves the
client showing something that simply vanished, which is the least diagnosable
failure an operator can be handed.

## The handshake fails with a JSON parse error

Something wrote to stdout. In this server that should be impossible — the guard
redirects `process.stdout.write` to stderr before the SDK loads — so if you see
it, check whether the client is launching a _wrapper script_ that prints a banner
before invoking node. That is outside the server's process and outside the
guard's reach.

## Discovery says the runner is `unknown`

That is an answer, not a failure. Nothing in the project stated which runner it
uses, and GenXEvo will not infer one from a folder name. Add the runner to
`devDependencies` or a runner config file, or tell the agent which one to assume.

## Discovery reports WebdriverIO or Playwright

Then this project is not a Selenium project, and `seleniumCompatible` is `false`.
That is worth acting on rather than working around: this build's later phases
target Selenium, and applying them to a WebdriverIO project produces confident,
plausible, wrong advice.

## `status` is `partialSuccess`

The scan hit a limit or could not read something. Read `warnings`. **"Not found"
may mean "not looked at."** Raise `workspace.maxScanEntries` or `maxScanDepth`,
or narrow the workspace root.

## A file I expected to be read was not

Check the deny-list. `.npmrc`, `.env*`, key material and their kind are never
opened — not opened and filtered, never opened. `deniedFileGlobCount` in
`genxevo_agent_status` tells you how many rules are active.

## npm refuses to install

`engine-strict=true` and a floor of Node 22.13. That refusal is the intended
behaviour: installing on an older runtime produces failures much later and much
further from the cause.

## A value I need came back redacted

Redaction errs towards over-redacting: a false positive costs one clarifying
question, a false negative leaks a credential. If a key in your project is
legitimately non-secret but reads like one, that is worth reporting as an issue
with the key name — the exemption list is matched as a whole identifier and is
meant to grow.
