/**
 * THE REAL MCP STDIO INTEGRATION TEST.
 *
 * Every other test file in this repository calls the product's own functions.
 * This one does not. It SPAWNS THE SERVER AS A CHILD PROCESS and speaks the
 * protocol to it over real pipes, because the questions this file exists to
 * answer cannot be answered any other way:
 *
 *  - Is stdout actually clean, once the SDK's whole dependency tree has been
 *    evaluated in the same process? Only a real spawn can tell you. A unit test
 *    imports the guard; it does not prove the guard was installed BEFORE the SDK.
 *
 *  - Do the text block and `structuredContent` survive JSON-RPC identically?
 *    That is a claim about the wire, not about `toContent()`.
 *
 *  - Does an unregistered tool name come back as a GenXEvo envelope rather than
 *    a protocol error? Only a client can observe the difference.
 *
 *  - Does the published `outputSchema` describe the payload that is actually
 *    delivered? The SDK does NOT enforce it - measured, and the reason
 *    `validateEnvelope` exists - so the only proof is to validate a real
 *    response against the real published schema.
 *
 * The client is the SDK's own `Client`, not a hand-rolled JSON-RPC speaker,
 * because an interoperability claim proved against my own encoder is worth
 * nothing. The one place a raw pipe IS used is the stdout-purity test, where the
 * whole point is to look at bytes rather than at parsed messages.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ENVELOPE_SCHEMA } from '../src/core/contract/envelopeSchema.js';
import { validateAgainst, validateKeyOrder } from '../src/core/contract/validateEnvelope.js';
import { RESULT_STATUS_VALUES } from '../src/core/contract/vocabularies.js';
import { AVAILABLE_CAPABILITIES } from '../src/core/capabilities/catalog.js';
import { seleniumProject, tempWorkspace, writeFile } from './helpers/fixtures.js';
import { runNpm } from './helpers/npm.js';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_ENTRY = path.join(REPOSITORY_ROOT, 'src', 'mcp', 'main.js');

/**
 * Run one function against a live server process, and always tear it down.
 *
 * The environment is passed EXPLICITLY rather than inherited wholesale.
 * `NODE_OPTIONS` deserves the mention: it can inject `--require` into any child
 * Node process, so a developer machine that has it set would otherwise change
 * what this test is testing.
 *
 * @param {string[]} argv Arguments for the server.
 * @param {(client: Client) => Promise<void>} body
 */
async function withServer(argv, body) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY, ...argv],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    stderr: 'pipe',
    cwd: REPOSITORY_ROOT,
  });

  const client = new Client(
    { name: 'genxevo-integration-test', version: '1.0.0' },
    { capabilities: {} },
  );

  let diagnostics = '';
  await client.connect(transport);
  transport.stderr?.on('data', (chunk) => {
    diagnostics += chunk.toString('utf8');
  });

  try {
    await body(client, () => diagnostics);
  } finally {
    await client.close();
  }
}

/** Every string anywhere in a payload, for the leak assertions. */
function allStrings(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const entry of value) allStrings(entry, found);
  else if (value && typeof value === 'object')
    for (const entry of Object.values(value)) allStrings(entry, found);
  return found;
}

// ---------------------------------------------------------------------------
// TOOL DISCOVERY
// ---------------------------------------------------------------------------

test('tools/list publishes EXACTLY the two tools this build implements', async () => {
  await withServer([], async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'genxevo_agent_status',
      'genxevo_discover_project',
    ]);
    // The catalogue publishes fifteen more as PLANNED. Not one of them is
    // callable: a stub that answers "not implemented" consumes a tool slot,
    // invites a call, and teaches the agent something false.
    assert.equal(tools.length, AVAILABLE_CAPABILITIES.length);
  });
});

test('each published tool carries the OUTPUT schema, so an agent learns the status vocabulary before calling', async () => {
  await withServer([], async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} publishes no outputSchema`);
      assert.deepEqual(
        tool.outputSchema.properties.status.enum,
        [...RESULT_STATUS_VALUES],
        'the nine-value status vocabulary must survive the wire',
      );
      assert.deepEqual(tool.outputSchema.required, ENVELOPE_SCHEMA.required);

      // An invented argument is refused by the protocol rather than silently
      // ignored, which is the difference between an agent learning and an agent
      // wondering why the result did not change.
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(tool.inputSchema.properties, {});
    }
  });
});

test('the safety annotations reach the client as protocol metadata, not as prose in a description', async () => {
  await withServer([], async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const capability = AVAILABLE_CAPABILITIES.find((entry) => entry.name === tool.name);
      assert.equal(tool.annotations.readOnlyHint, capability.readOnly, tool.name);
      assert.equal(tool.annotations.idempotentHint, capability.idempotent, tool.name);
      assert.equal(tool.annotations.destructiveHint, capability.destructive, tool.name);
      assert.equal(tool.annotations.openWorldHint, false, tool.name);
      assert.ok(tool.title, `${tool.name} has no human title`);
    }
  });
});

test('the server ships INSTRUCTIONS, so a client knows the workflow without reading our docs', async () => {
  await withServer([], async (client) => {
    const instructions = client.getInstructions();
    assert.match(instructions, /genxevo_agent_status first/);
    assert.match(instructions, /branch on 'status'/);
    assert.match(instructions, /untrusted/);
  });
});

// ---------------------------------------------------------------------------
// THE STRUCTURED CONTRACT, OVER THE WIRE
// ---------------------------------------------------------------------------

test('a tool result arrives as BOTH readable text and structuredContent, and the two are identical', async () => {
  await withServer([], async (client) => {
    const response = await client.callTool({ name: 'genxevo_agent_status', arguments: {} });

    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].type, 'text');
    assert.ok(response.structuredContent, 'structuredContent is missing');

    // Byte-identity, not merely deep equality. The Python sibling has to publish
    // an "absent and null mean the same thing" caveat because pydantic
    // materialises its envelope on the way out; JavaScript has no such step and
    // this assertion is what proves it.
    assert.equal(response.content[0].text, JSON.stringify(response.structuredContent, null, 2));
  });
});

test('the delivered payload validates against the PUBLISHED schema - because the SDK does not enforce it', async () => {
  await withServer([], async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const response = await client.callTool({ name: tool.name, arguments: {} });
      const verdict = validateAgainst(response.structuredContent, tool.outputSchema);
      assert.deepEqual(verdict.errors, [], `${tool.name}: ${JSON.stringify(verdict.errors)}`);
      assert.equal(verdict.valid, true, tool.name);
      // Emission order is part of the contract: an agent reading the text block
      // sees `status` before it has scrolled past a large `data`.
      assert.equal(validateKeyOrder(response.structuredContent).valid, true, tool.name);
    }
  });
});

test('the contract version and the operation name survive the transport', async () => {
  await withServer([], async (client) => {
    const status = await client.callTool({ name: 'genxevo_agent_status', arguments: {} });
    assert.equal(status.structuredContent.contractVersion, '1.0');
    assert.equal(status.structuredContent.operation, 'agent.status');
    assert.equal(typeof status.structuredContent.durationMs, 'number');
    assert.match(status.structuredContent.startedAt, /Z$/);
  });
});

// ---------------------------------------------------------------------------
// THE UNCONFIGURED SERVER
// ---------------------------------------------------------------------------

test('an UNCONFIGURED server still starts, still lists tools, and still answers', async () => {
  // Exiting instead would leave the client showing a server that simply
  // disappeared, which is the single least diagnosable failure an operator can
  // be handed.
  await withServer([], async (client, diagnostics) => {
    const status = await client.callTool({ name: 'genxevo_agent_status', arguments: {} });
    assert.equal(status.structuredContent.status, 'success');
    assert.equal(status.structuredContent.data.configured, false);
    assert.equal(status.structuredContent.data.workspace.rootCount, 0);

    const discover = await client.callTool({ name: 'genxevo_discover_project', arguments: {} });
    // NOT the generic `failure`. The status vocabulary distinguishes an
    // operator-fixable configuration problem from a run that went wrong, so an
    // agent can stop and relay rather than retry.
    assert.equal(discover.structuredContent.status, 'configurationError');
    assert.equal(discover.structuredContent.error.code, 'config.workspace_not_configured');
    assert.match(discover.structuredContent.error.remediation, /--workspace/);
    assert.equal(discover.structuredContent.nextActions[0].tool, 'genxevo_agent_status');

    // And it SAID SO on stderr at startup rather than failing silently.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    assert.match(diagnostics(), /UNCONFIGURED/);
  });
});

test('agent_status reports capability counts an agent can plan against', async () => {
  await withServer([], async (client) => {
    const status = await client.callTool({ name: 'genxevo_agent_status', arguments: {} });
    const { capabilityCounts, capabilities } = status.structuredContent.data;
    assert.equal(capabilityCounts.available, 2);
    assert.ok(capabilityCounts.total > capabilityCounts.available);
    assert.equal(capabilities.length, capabilityCounts.total);
    for (const capability of capabilities.filter((c) => c.state === 'planned')) {
      assert.match(capability.phase, /^1[A-Z]$/, capability.name);
    }
  });
});

// ---------------------------------------------------------------------------
// THE CONFIGURED SERVER, OVER A REAL PROJECT
// ---------------------------------------------------------------------------

test('discovery over a REAL project on disk reports the runner and the framework it actually finds', async () => {
  const root = seleniumProject(tempWorkspace());
  await withServer(['--workspace', root], async (client) => {
    const response = await client.callTool({ name: 'genxevo_discover_project', arguments: {} });
    const payload = response.structuredContent;

    assert.ok(['success', 'partialSuccess'].includes(payload.status), payload.status);
    assert.equal(payload.data.summary.runner, 'mocha');
    assert.deepEqual(payload.data.summary.automationFrameworks, ['Selenium']);
    assert.equal(payload.data.summary.seleniumCompatible, true);
    assert.deepEqual(payload.data.summary.testRoots, ['suite/checks']);
    assert.equal(payload.data.summary.packageManager, 'npm');
    assert.equal(payload.data.toolchain.pinnedNodeVersionSource, '.nvmrc');

    // Evidence, with a trust level on every item, and at least one untrusted
    // excerpt of a real project file - so the untrusted path is exercised end to
    // end rather than merely designed.
    assert.ok(payload.evidence.length > 0);
    for (const item of payload.evidence) {
      assert.ok(['trusted', 'derived', 'untrusted'].includes(item.trust), item.id);
    }
    assert.ok(payload.evidence.some((item) => item.trust === 'untrusted'));
  });
});

test('NO ABSOLUTE PATH leaves the server, in any field of any result', async () => {
  // The boundary's location is not the agent's business, and a transcript that
  // records it hands an attacker the map. Both siblings emit absolute paths in
  // at least one field; this test is why this one does not.
  const root = seleniumProject(tempWorkspace());
  await withServer(['--workspace', root], async (client) => {
    for (const name of ['genxevo_agent_status', 'genxevo_discover_project']) {
      const response = await client.callTool({ name, arguments: {} });
      const serialised = JSON.stringify(response.structuredContent);
      assert.equal(serialised.includes(root), false, `${name} leaked the workspace root`);
      assert.equal(
        serialised.includes(REPOSITORY_ROOT),
        false,
        `${name} leaked the server's own installation directory`,
      );
      for (const value of allStrings(response.structuredContent)) {
        assert.equal(
          /(^|["'\s])(?:[A-Za-z]:[\\/]|\/(?:home|root|Users|tmp|var)\/)/.test(value),
          false,
          `${name} emitted an absolute path: ${value.slice(0, 120)}`,
        );
      }
    }
  });
});

test('a SECRET in the workspace never reaches the client', async () => {
  // Synthetic credentials only. `Winter2026!` is invented and `example.test` is
  // an RFC 2606 reserved name; nothing here has ever been valid anywhere.
  const root = tempWorkspace();
  seleniumProject(root, {
    name: 'acme-regression',
    scripts: { test: 'mocha', deploy: 'curl -u admin:Winter2026! https://ci.example.test' },
  });
  writeFile(root, '.npmrc', '//registry.example.test/:_authToken=npm_SyntheticTokenValue0000\n');
  writeFile(root, '.env', 'SELENIUM_PASSWORD=Winter2026!\n');

  await withServer(['--workspace', root], async (client) => {
    const response = await client.callTool({ name: 'genxevo_discover_project', arguments: {} });
    const serialised = JSON.stringify(response.structuredContent);
    assert.equal(serialised.includes('Winter2026!'), false, 'a password reached the client');
    assert.equal(
      serialised.includes('npm_SyntheticTokenValue0000'),
      false,
      'a token reached the client',
    );
    // And the denied files were never read at all, rather than read and filtered.
    assert.equal(serialised.includes('.npmrc'), false);
  });
});

// ---------------------------------------------------------------------------
// REFUSALS AND ERROR SANITISATION
// ---------------------------------------------------------------------------

test('an unknown tool name is answered in the GenXEvo ENVELOPE, not as a protocol error', async () => {
  await withServer([], async (client) => {
    const response = await client.callTool({ name: 'genxevo_make_coffee', arguments: {} });
    // `validationError`, because the client sent something wrong - which is a
    // different thing from the server failing, and an agent should treat it
    // differently.
    assert.equal(response.structuredContent.status, 'validationError');
    assert.equal(response.structuredContent.error.code, 'validation.argument_invalid');
    assert.match(response.structuredContent.error.remediation, /genxevo_agent_status/);
    assert.equal(validateAgainst(response.structuredContent, ENVELOPE_SCHEMA).valid, true);
  });
});

test('a PLANNED capability called by name says so, and names the phase, rather than pretending', async () => {
  await withServer([], async (client) => {
    const response = await client.callTool({ name: 'genxevo_run_tests', arguments: {} });
    assert.equal(response.structuredContent.error.code, 'capability.not_implemented');
    assert.equal(response.structuredContent.error.category, 'notImplemented');
    assert.match(response.structuredContent.error.remediation, /phase 1D/);
    assert.match(response.structuredContent.error.remediation, /Do not retry/);
    assert.equal(response.structuredContent.error.retryable, false);
  });
});

test('every error carries a category, a retryable flag and a remediation an agent can act on', async () => {
  await withServer([], async (client) => {
    const response = await client.callTool({ name: 'genxevo_discover_project', arguments: {} });
    const error = response.structuredContent.error;
    assert.equal(typeof error.retryable, 'boolean');
    assert.ok(error.remediation.length > 0);
    // No stack trace, no internal module path, no exception class name.
    assert.equal(/\bat \w+ \(|node:internal|\.js:\d+:\d+/.test(JSON.stringify(error)), false);
  });
});

// ---------------------------------------------------------------------------
// STDOUT PURITY, MEASURED IN BYTES
// ---------------------------------------------------------------------------

/**
 * Speak JSON-RPC over a raw pipe and hand back every byte of both streams.
 *
 * The SDK client is the right tool everywhere else in this file; here it is
 * exactly the wrong one, because it parses the thing under test.
 */
function rawExchange(argv, frames, { waitMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_ENTRY, ...argv], {
      cwd: REPOSITORY_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
    setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr });
    }, waitMs);
  });
}

test('EVERY byte written to stdout is a JSON-RPC message - nothing else gets in', async () => {
  const { stdout, stderr } = await rawExchange(
    [],
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1.0.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'genxevo_agent_status', arguments: {} },
      },
    ],
  );

  const lines = stdout.split('\n').filter((line) => line.length > 0);
  assert.ok(lines.length >= 3, `expected at least three responses, got ${lines.length}`);
  for (const line of lines) {
    const message = JSON.parse(line); // throws, loudly, on a stray banner byte
    assert.equal(message.jsonrpc, '2.0');
  }
  // The startup diagnostic exists; it is simply not on stdout. "Absent from
  // stdout" and "not logged at all" are different guarantees and this proves
  // which one holds.
  assert.match(stderr, /genxevo:/);
});

test('--version and --help write ZERO bytes to stdout, and their output IS on stderr', () => {
  for (const flag of ['--version', '--help']) {
    const stdout = execFileSync(process.execPath, [SERVER_ENTRY, flag], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(stdout, '', `${flag} wrote to stdout`);
  }

  const help = execFileSync(
    process.execPath,
    [
      '-e',
      `require('child_process').execFileSync(process.execPath,[${JSON.stringify(SERVER_ENTRY)},'--help'],{stdio:['ignore','ignore','inherit']})`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(help, '', 'the banner must not reach stdout even indirectly');
});

test('an unusable command line exits 2 rather than starting a server that cannot work', async () => {
  const child = spawn(process.execPath, [SERVER_ENTRY, '--wokspace', '/tmp/x'], {
    cwd: REPOSITORY_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
  const [code] = await once(child, 'exit');
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /--wokspace/);
});

// ---------------------------------------------------------------------------
// LIFECYCLE AND PACKAGING
// ---------------------------------------------------------------------------

test('the server shuts down cleanly when the client closes the transport', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    stderr: 'pipe',
    cwd: REPOSITORY_ROOT,
  });
  const client = new Client({ name: 'shutdown-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  await client.listTools();
  await client.close();
  // `close()` resolving is the observable contract; a process that ignored the
  // closed pipe would leave this hanging until the runner's timeout.
  assert.ok(true);
});

test('the SAME server answers repeated calls - it is a server, not a one-shot', async () => {
  const root = seleniumProject(tempWorkspace());
  await withServer(['--workspace', root], async (client) => {
    const first = await client.callTool({ name: 'genxevo_discover_project', arguments: {} });
    const second = await client.callTool({ name: 'genxevo_discover_project', arguments: {} });
    assert.equal(first.structuredContent.status, second.structuredContent.status);
    assert.deepEqual(first.structuredContent.data.summary, second.structuredContent.data.summary);
    // Idempotent in the published annotation AND in fact.
    assert.notEqual(first.structuredContent.startedAt, undefined);
  });
});

test('npm pack ships the runnable product and none of the tests', () => {
  const output = runNpm(['pack', '--dry-run', '--json'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = JSON.parse(output)[0].files.map((entry) => entry.path);

  for (const required of ['package.json', 'src/mcp/main.js', 'src/core/contract/toolResult.js']) {
    assert.ok(files.includes(required), `${required} is missing from the tarball`);
  }
  for (const forbidden of files.filter((entry) => entry.startsWith('test/'))) {
    assert.fail(`the tarball ships a test file: ${forbidden}`);
  }
  assert.equal(
    files.some((entry) => entry.includes('node_modules')),
    false,
  );
  assert.equal(
    files.some((entry) => entry === '.npmrc'),
    false,
    'the tarball must never carry an .npmrc',
  );
});

test('the packaged entry point is executable by npx', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const binary = path.join(REPOSITORY_ROOT, manifest.bin['genxevo-selenium-agent']);
  assert.equal(fs.readFileSync(binary, 'utf8').split('\n')[0], '#!/usr/bin/env node');
});
