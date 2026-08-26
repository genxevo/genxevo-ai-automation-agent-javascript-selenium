# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the
caveat that while the version is `0.x`, the published result contract is
versioned separately by `contractVersion`.

## [Unreleased]

## [0.1.0-alpha.1] — 2026-08-25

The Phase 1B foundation: the real core and two real MCP tools. No stubs.

### Added

- **`genxevo_agent_status`** — configuration state, approved workspace roots
  (names only), security policy, host Node runtime, and the full capability
  catalogue with each entry's state and phase.
- **`genxevo_discover_project`** — manifests, lockfiles and the package manager
  they imply; the test runner the project itself states it uses; test roots;
  module system; the pinned Node version and its source; the browser automation
  library, distinguishing Selenium from WebdriverIO and Playwright; page-object
  candidates; and what is actually installed, read from
  `node_modules/.package-lock.json`. Every conclusion carries its signals and an
  explicit confidence level.
- The GenXEvo result envelope: nine statuses, a fixed key order, structured
  errors with a `retryable` flag derived from the error category, warnings,
  evidence with a trust level on every item, and next actions.
- **GenXEvo-owned output validation.** The published `outputSchema` object is the
  same object every result is validated against, in-process, before it leaves the
  server. Measured: the SDK's low-level path does not enforce `outputSchema`.
- Security surface, wired to a live call site rather than to nothing: path
  containment after symlink and junction resolution, a deny-list that applies to
  every server-initiated read, bounded reads, secret redaction with bounded
  quantifiers and an input cap, and selection validation.
- Configuration with CLI → environment → file → defaults precedence, a
  fatal/advisory split, and loud advisories for permissive-empty settings.
- 265 tests, including a real MCP stdio integration test that spawns the server
  and speaks the protocol over pipes, and an architecture test suite that
  enforces the dependency firewall and stdout discipline by scanning the source.
- c8 coverage with **enforced** thresholds.
- Documentation, agent prompts, worked configuration examples, and cross-platform
  verification scripts.

### Fixed (relative to the sibling C# and Python products this design learned from)

- **Alternate data streams.** Both siblings test only the first colon in a
  candidate path, so `C:\x\f.txt:hidden` is accepted. Every colon is now checked.
- **Whole-identifier key exemptions.** Both siblings use `includes()` and
  short-circuit, so `AuthModePassword` matches the `authmode` exemption and its
  value is emitted verbatim. Exemptions are now matched as whole normalised
  identifiers.
- **Security controls with no callers.** In both siblings the path boundary, the
  redactor and the untrusted-content framing are built, fully unit-tested and
  called from nowhere, and one of them bypasses its own boundary during
  discovery. Here every server-initiated read goes through one door, and
  discovery uses it.
- **Credentials in command-line flags.** `package.json` script values are shell
  command lines and discovery publishes a manifest excerpt, so `curl -u
admin:<secret>` was a real path from a project file to an agent transcript.
  Found by the end-to-end MCP test, not by review.

### Security

- stdout carries JSON-RPC and nothing else, guarded at runtime before the SDK is
  loaded, and asserted byte-wise against a spawned server.
- No absolute path leaves the server in any field of any result.
- Internal exceptions are sanitised to a constructor name and, where present, a
  Node system code. No message, no stack trace, no path.
- This build starts no process, and no `child_process` import exists in `src/`.

[unreleased]: https://github.com/GenXEvo/genxevo-ai-automation-agent-javascript-selenium/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/GenXEvo/genxevo-ai-automation-agent-javascript-selenium/releases/tag/v0.1.0-alpha.1
