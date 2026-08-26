# Examples

Working configurations, validated by `test/examples.test.js` in CI. A shipped
example that no longer parses is a broken onboarding path, so these are tested
like any other code.

| File                                                                         | What it is for                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`configs/minimal.genxevo.config.json`](configs/minimal.genxevo.config.json) | The smallest useful file. Every safe default, one widened limit.                                        |
| [`configs/ci.genxevo.config.json`](configs/ci.genxevo.config.json)           | Unattended use. Execution is **on**, which is a deliberate operator choice.                             |
| [`configs/team.genxevo.config.json`](configs/team.genxevo.config.json)       | A monorepo whose Selenium suite lives in one package.                                                   |
| [`../genxevo.config.example.json`](../genxevo.config.example.json)           | Every setting, annotated. **Every value in it is the built-in default**, and a test asserts that claim. |
| [`../.mcp.json.example`](../.mcp.json.example)                               | Three ways to register the server with an MCP client.                                                   |

## The one thing worth reading twice

`workspace.roots` is empty in every example, and that is not an omission.
**GenXEvo never infers the workspace.** The folder you pass to `--workspace` is
always the first root; anything you add to `workspace.roots` is an _additional_
root, resolved relative to it.

## Credentials in examples

There are none, and there never will be. Every value here is either a default, a
placeholder, or an RFC 2606 reserved name. If you need a credential for your own
setup, it belongs in your `genxevo.config.json` — which is `.gitignore`d — and
never in an example.
