#!/usr/bin/env node
/**
 * Process entry point for the GenXEvo MCP server.
 *
 * CRITICAL: stdout belongs exclusively to the MCP JSON-RPC transport. A single
 * stray byte there corrupts the protocol stream, and the failure mode is the
 * confusing one - the client's tool-discovery handshake fails with an error that
 * points nowhere near the real cause.
 *
 * THREE LAYERS KEEP IT CLEAN, AND THE ORDER OF TRUST IS THE OPPOSITE OF THE
 * PYTHON SIBLING'S.
 *
 *  1. THE RUNTIME GUARD BELOW, which is PRIMARY here. The real stdout is
 *     captured into its own stream before anything else runs and handed only to
 *     the transport; `process.stdout.write` is then pointed at stderr for the
 *     life of the process. A stray `console.log` ANYWHERE - including inside a
 *     third-party package - lands harmlessly on stderr.
 *
 *     This has to be primary in JavaScript, and that is not a stylistic
 *     preference. The MCP SDK brings THIRTY-FOUR transitive packages into this
 *     process (measured with `npm ls --omit=dev --all` against the pinned
 *     version, and asserted by a test so a bump is a review event), including a
 *     full HTTP stack this stdio server never speaks. Lint rules and source
 *     scans cannot see into `node_modules`; this guard can.
 *
 *  2. Discipline: ESLint's `no-console`, plus a source-scan test that fails on
 *     any `process.stdout` reference outside the one permitted line below.
 *
 *  3. A CI assertion that `--version` and `--help` write ZERO BYTES to stdout,
 *     using the `2>&1 >/dev/null` form so it proves the banner IS on stderr
 *     rather than merely absent from stdout.
 *
 * The guard runs before the SDK is even loaded. Static ESM imports are hoisted
 * and evaluated before any statement in this module, so the modules that touch
 * the SDK are DYNAMICALLY imported below - after the guard is in place. That
 * ordering is the whole point and a test asserts the guard still holds when a
 * tool handler writes to stdout deliberately.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseStartupOptions, usageText } from '../core/support/startup.js';
import { readKnownEnvironment } from '../core/config/load.js';

// ---------------------------------------------------------------------------
// THE STDOUT GUARD. Nothing above this line may write to stdout, and nothing
// below it can.
// ---------------------------------------------------------------------------
const protocolOut = fs.createWriteStream('', { fd: 1 });
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = realStderrWrite;
// ---------------------------------------------------------------------------

const PRODUCT_NAME = 'GenXEvo AI Automation Agent - JavaScript Selenium';

/** Everything diagnostic goes here. There is no other logger and no other sink. */
function log(message) {
  realStderrWrite(`genxevo: ${message}\n`);
}

function readVersion() {
  try {
    const manifest = path.join(import.meta.dirname, '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Run the server.
 *
 * Exit codes: `0` normal, `2` unusable command line. An unconfigured workspace
 * is NOT an error code - the server starts anyway and says so on every tool
 * call.
 *
 * @param {ReadonlyArray<string>} argv
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseStartupOptions(argv);
  const version = readVersion();

  if (options.showHelp) {
    realStderrWrite(usageText());
    return 0;
  }
  if (options.showVersion) {
    realStderrWrite(`${PRODUCT_NAME} ${version}\n`);
    return 0;
  }
  if (options.errors.length > 0) {
    for (const error of options.errors) log(error);
    realStderrWrite(usageText());
    return 2;
  }

  // Imported dynamically so the guard above is already in place when the SDK and
  // its transitive packages are evaluated.
  const { createRuntime } = await import('../core/capabilities/runtime.js');
  const { buildServer } = await import('./server.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  const runtime = createRuntime({
    workspaceOverride: options.workspace,
    configPathOverride: options.configPath,
    environment: readKnownEnvironment(),
  });

  // The server starts even when unconfigured. Every capability then returns the
  // same actionable configurationError, which the agent can read and relay to
  // the operator. Exiting instead would leave the client showing a server that
  // simply disappeared.
  if (!runtime.isConfigured && runtime.configurationError !== null) {
    log(
      `starting UNCONFIGURED - ${runtime.configurationError.message} ${runtime.configurationError.remediation ?? ''}`,
    );
  }
  for (const issue of runtime.issues) {
    log(`configuration ${issue.fatal ? 'error' : 'advisory'}: ${issue.path} - ${issue.message}`);
  }

  const server = buildServer(runtime, version);
  await server.connect(new StdioServerTransport(process.stdin, protocolOut));
  return 0;
}

// `import.meta.main` is not available on the supported floor, so the entry point
// is detected by comparing resolved paths.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (invokedDirectly) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
