# Installation

## Requirements

- **Node.js 22.13.0 or newer.** `engines` declares it and `.npmrc` sets
  `engine-strict=true`, so npm refuses rather than installing something that will
  fail confusingly later.
- An MCP-capable client.

Why 22.13 and not 24, when 24 is Active LTS? Because the floor is the oldest
runtime a _consumer_ may reasonably still be on, not the newest one available.
Node 20 reached end of life in April 2026; 22 is in maintenance until April 2027.
Setting the floor at 22.13 (the LTS boundary where `import.meta.dirname` and
`path.matchesGlob` are both available) means this package installs on the
runtimes real automation teams have, while still being developed and tested on 24. `.nvmrc` pins the development runtime.

## Install

```bash
git clone https://github.com/GenXEvo/genxevo-ai-automation-agent-javascript-selenium.git
cd genxevo-ai-automation-agent-javascript-selenium
npm install
node src/mcp/main.js --version   # writes to stderr; stdout stays empty on purpose
```

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "genxevo-selenium": {
      "command": "node",
      "args": [
        "C:\\path\\to\\genxevo-ai-automation-agent-javascript-selenium\\src\\mcp\\main.js",
        "--workspace",
        "C:\\path\\to\\your-automation-project"
      ]
    }
  }
}
```

Restart the client after editing. On Windows, backslashes must be escaped in
JSON. Quotes left around a value by a client's own configuration UI are stripped
by the startup parser, because that mistake is common and produces a workspace
path that exists nowhere.

## Claude Code / any MCP client

`.mcp.json` in your project (there is a `.mcp.json.example` in this repository):

```json
{
  "mcpServers": {
    "genxevo-selenium": {
      "command": "node",
      "args": ["/abs/path/to/src/mcp/main.js", "--workspace", "/abs/path/to/your-project"]
    }
  }
}
```

## Verifying the install

Ask the agent to call `genxevo_agent_status`. A healthy answer has
`data.configured: true`, a non-zero `workspace.rootCount`, and
`capabilityCounts.available: 2`.

If `configured` is `false`, the server is running but no workspace was approved —
that is a configuration problem, not a crash, and the result says exactly what to
change.

## Command line

```
--workspace, -w <path>   The automation project root. NEVER inferred.
--config,    -c <path>   A genxevo.config.json to load.
--version,   -v          Print the version to stderr and exit 0.
--help,      -h          Print usage to stderr and exit 0.
```

Exit codes: `0` normal, `2` unusable command line. An unconfigured workspace is
**not** an error code — the server starts anyway and says so on every call.
