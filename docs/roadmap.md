# Roadmap

Phase numbers are the ones published in `genxevo_agent_status`, so an agent's
view and this document cannot drift.

## Phase 1B — shipped

Core contract, security surface, configuration, discovery, and two real MCP
tools: `genxevo_agent_status` and `genxevo_discover_project`.

## Phase 1B (remainder) — reading

- `genxevo_read_project_file` — a source, config or test-data file, redacted and
  framed as untrusted, through the same single door discovery already uses.
- `genxevo_read_locators` — locator declarations from a page object, via a
  **syntax-aware parse**, reporting anything it could not classify rather than a
  count it cannot stand behind.
- `genxevo_describe_environment` — the Node runtime and installed packages a run
  would actually use, and whether they satisfy what the project declares.

## Phase 1C — the browser

`genxevo_browser_session`, `genxevo_browser_navigate`, `genxevo_browser_interact`,
`genxevo_inspect_element`, `genxevo_evaluate_locators`, `genxevo_capture_evidence`.

`selenium-webdriver` becomes a dependency here and not before. Element inspection
returns the **neighbourhood** — state, attributes, ancestors, siblings, a
screenshot — not just the node, because a locator is repaired from context.
Locator evaluation is a batch under one explicit wait policy, iframes included.

## Phase 1D — execution

`genxevo_run_tests`, `genxevo_get_run`, `genxevo_compare_runs`.

One run, one identifier, one directory. Results are returned **by identifier**,
never by the newest file on disk. Comparison classifies each test as fixed, still
failing, newly failing or unchanged — never by comparing pass counts.

Execution goes through the selection validator already in this build, an argument
**array** with no shell, and a child environment with `NODE_OPTIONS` stripped.
`execution.enabled` defaults to `false`.

## Phase 1E — repair

Suggest a repair, apply it behind an explicit gate, and **require a verification
run**. A repair loop with no verification is a machine for producing confident
wrong answers, which is the failure this product exists to prevent.

## Not planned

A language model inside the server. Arbitrary command execution. Anything that
imports or evaluates project code.
