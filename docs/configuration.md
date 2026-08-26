# Configuration

## Precedence

Command line → environment → configuration file → defaults.

Later sources never override earlier ones, and nothing is inferred. Keys
beginning with `_` are treated as comments, so a configuration file can explain
itself without tripping the unknown-key advisory.

## The file

`genxevo.config.json`, named with `--config`. See
`genxevo.config.example.json` and the three worked examples under
`examples/configs/`.

```jsonc
{
  "workspace": {
    "ignoredDirectories": ["node_modules", ".git", "coverage", "dist", "build"],
    "maxScanDepth": 12,
    "maxScanEntries": 20000,
  },
  "security": {
    "redactSecrets": true,
    "frameUntrustedContent": true,
    "deniedFileGlobs": ["**/.npmrc", "**/.env*", "**/*.pem", "..."],
    "additionalSecretKeyFragments": [],
  },
  "execution": {
    "enabled": false,
    "runner": "auto",
    "requireSelection": true,
    "defaultTimeoutSeconds": 600,
    "useProjectScripts": false,
  },
  "browser": { "kind": "chrome", "headless": true },
  "repair": { "maxCyclesPerFailure": 3, "requireVerificationRun": true },
  "evidence": { "maxExcerptCharacters": 1200 },
  "logging": { "level": "info" },
}
```

## Environment variables

Seven, and no others are read:

| Variable                    | Effect                                            |
| --------------------------- | ------------------------------------------------- |
| `GENXEVO_WORKSPACE`         | Workspace root                                    |
| `GENXEVO_CONFIG`            | Configuration file path                           |
| `GENXEVO_LOG_LEVEL`         | `error` / `warn` / `info` / `debug`               |
| `GENXEVO_REDACT_SECRETS`    | `false` disables redaction — advisory, and loudly |
| `GENXEVO_EXECUTION_ENABLED` | Policy for phase 1D                               |
| `GENXEVO_BROWSER_KIND`      | Policy for phase 1C                               |
| `GENXEVO_BROWSER_HEADLESS`  | Policy for phase 1C                               |

`--help` lists them, and a test asserts that it lists _all_ of them, so the usage
text cannot drift from the code.

## Fatal versus advisory

A **fatal** issue stops the server from being configured; the server still starts
and every capability returns the same `configurationError` explaining what to fix.
An **advisory** issue is reported in `warnings` and on stderr, and the server runs.

Some advisories are deliberately loud. `"security.deniedFileGlobs": []` is
syntactically valid and means "deny nothing" — it is accepted, because an
operator may genuinely want it, and it is warned about on every single call,
because far more often it means someone emptied the wrong array. The same applies
to `redactSecrets: false`. **A permissive-empty setting is never silent.**

Unknown keys are advisory rather than fatal: a typo should tell you it is a typo,
not stop the server.
