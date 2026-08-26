import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_CAPABILITIES,
  AVAILABLE_CAPABILITIES,
  IMPLEMENTED_PHASE,
  capabilityByName,
} from '../src/core/capabilities/catalog.js';
import { CapabilityInvoker } from '../src/core/capabilities/invoker.js';
import { createRuntime } from '../src/core/capabilities/runtime.js';
import { AgentStatusCapability } from '../src/core/capabilities/agentStatus.js';
import { ProjectDiscoveryCapability } from '../src/core/capabilities/discoverProject.js';
import {
  CapabilityState,
  ResultStatus,
  SafetyClass,
  TrustLevel,
} from '../src/core/contract/vocabularies.js';
import { ErrorCode } from '../src/core/contract/errorCodes.js';
import { success } from '../src/core/contract/toolResult.js';
import { validateEnvelope, validateKeyOrder } from '../src/core/contract/validateEnvelope.js';
import { SYSTEM_CLOCK } from '../src/core/support/clock.js';
import { seleniumProject, tempWorkspace, writeFile, writeJson } from './helpers/fixtures.js';

// -- the catalogue ----------------------------------------------------------

test('every tool name follows the family convention and is unique', () => {
  const names = ALL_CAPABILITIES.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^genxevo_[a-z0-9_]+$/);
});

test('every operation is dotted, lowercase and unique', () => {
  const operations = ALL_CAPABILITIES.map((c) => c.operation);
  assert.equal(new Set(operations).size, operations.length);
  for (const operation of operations) assert.match(operation, /^[a-z]+(\.[a-z_]+)+$/);
});

test('THE PHASE 1A STOP CONDITION: exactly two capabilities, and exactly these two', () => {
  assert.equal(IMPLEMENTED_PHASE, '1A');
  assert.deepEqual(AVAILABLE_CAPABILITIES.map((c) => c.name).sort(), [
    'genxevo_agent_status',
    'genxevo_discover_project',
  ]);
  assert.equal(
    AVAILABLE_CAPABILITIES.every((c) => c.phase === IMPLEMENTED_PHASE),
    true,
  );
});

test('every unavailable capability is PLANNED with a later phase, and none is DISABLED', () => {
  for (const capability of ALL_CAPABILITIES) {
    if (capability.state === CapabilityState.AVAILABLE) continue;
    assert.equal(capability.state, CapabilityState.PLANNED, capability.name);
    assert.match(capability.phase, /^(1B|1C|1D|1E|2|3)$/, capability.name);
  }
});

test('safety flags are DERIVED, so the catalogue and the protocol cannot disagree', () => {
  for (const capability of ALL_CAPABILITIES) {
    assert.equal(capability.readOnly, capability.safety === SafetyClass.READ_ONLY, capability.name);
    assert.equal(
      capability.destructive,
      capability.safety === SafetyClass.FILE_WRITING || capability.safety === SafetyClass.EXECUTING,
      capability.name,
    );
  }
});

test('a read-only capability is always idempotent and never destructive', () => {
  for (const capability of ALL_CAPABILITIES.filter((c) => c.readOnly)) {
    assert.equal(capability.idempotent, true, capability.name);
    assert.equal(capability.destructive, false, capability.name);
  }
});

test('the ONLY executing capability is the test runner', () => {
  const executing = ALL_CAPABILITIES.filter((c) => c.safety === SafetyClass.EXECUTING);
  assert.deepEqual(
    executing.map((c) => c.name),
    ['genxevo_run_tests'],
  );
});

test('every purpose is a usable sentence an agent can select on', () => {
  for (const capability of ALL_CAPABILITIES) {
    assert.ok(capability.purpose.length > 40, capability.name);
    assert.match(capability.purpose, /\.$/, capability.name);
  }
});

test('lookup by name, and a miss returns null rather than throwing', () => {
  assert.equal(capabilityByName('genxevo_agent_status').operation, 'agent.status');
  assert.equal(capabilityByName('genxevo_invented'), null);
});

// -- the invoker ------------------------------------------------------------

test('a result is stamped with real timing', async () => {
  const invoker = new CapabilityInvoker(SYSTEM_CLOCK);
  const result = await invoker.invoke('op', async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 12);
    });
    return success('op', 's');
  });
  assert.ok(result.durationMs >= 10);
  assert.match(result.startedAt, /Z$/);
});

test('an unhandled exception NEVER leaks a message, a path or a stack', async () => {
  // Probing the real SDK with a handler that throws produced this, verbatim, in
  // the client's result:
  //   McpError: MCP error -32603: secret internal detail /home/user/x.mjs line 42
  const invoker = new CapabilityInvoker(SYSTEM_CLOCK);
  const result = await invoker.invoke('op', async () => {
    throw new Error('secret internal detail /home/user/project/x.js line 42');
  });
  const rendered = JSON.stringify(result);
  assert.equal(result.status, ResultStatus.FAILURE);
  assert.equal(result.error.code, ErrorCode.INTERNAL);
  assert.equal(rendered.includes('/home/user'), false);
  assert.equal(rendered.includes('secret internal detail'), false);
  assert.equal(rendered.includes('at Object'), false);
  assert.equal(result.safeToRetry, false);
});

test('a thrown non-Error is contained too', async () => {
  const invoker = new CapabilityInvoker(SYSTEM_CLOCK);
  for (const thrown of ['a string', 42, null, { secret: '/home/user/x' }]) {
    const result = await invoker.invoke('op', async () => {
      throw thrown;
    });
    assert.equal(result.error.code, ErrorCode.INTERNAL);
    assert.equal(JSON.stringify(result).includes('/home/user'), false);
  }
});

test('a body that exceeds its budget is reported as a TIMEOUT', async () => {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const invoker = new CapabilityInvoker(SYSTEM_CLOCK);
    const result = await invoker.invoke('op', (signal) => untilAborted(signal), { timeoutMs: 40 });
    assert.equal(result.status, ResultStatus.TIMEOUT);
    assert.equal(result.error.code, ErrorCode.OPERATION_TIMEOUT);
    assert.equal(result.safeToRetry, true);
    assert.match(result.error.remediation, /not trustworthy/);
  } finally {
    clearInterval(keepAlive);
  }
});

test('HOST cancellation is reported as CANCELLED, not as a timeout', async () => {
  // The SDK hands every handler a live AbortSignal. The invoker composes it with
  // its own deadline rather than inventing a cancellation channel, which is what
  // the Python sibling had to do and what the Java plan expects to do.
  const invoker = new CapabilityInvoker(SYSTEM_CLOCK);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 15);
  const result = await invoker.invoke('op', (signal) => untilAborted(signal), {
    signal: controller.signal,
  });
  assert.equal(result.status, ResultStatus.CANCELLED);
  assert.equal(result.error.code, ErrorCode.OPERATION_CANCELLED);
});

test('the composed signal reaches the capability body', async () => {
  const invoker = new CapabilityInvoker(SYSTEM_CLOCK);
  let seen = null;
  await invoker.invoke(
    'op',
    async (signal) => {
      seen = signal;
      return success('op', 's');
    },
    { timeoutMs: 5_000 },
  );
  assert.ok(seen instanceof AbortSignal);
  assert.equal(seen.aborted, false);
});

test('EXCLUSIVE capabilities never overlap; ordinary ones may', async () => {
  // Selenium's WebDriver is not thread-safe and an MCP host is free to dispatch
  // tool calls concurrently, so this is a correctness requirement.
  const invoker = new CapabilityInvoker(SYSTEM_CLOCK);
  const measure = async (exclusive) => {
    let inside = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        invoker.invoke(
          'op',
          async () => {
            inside += 1;
            peak = Math.max(peak, inside);
            await new Promise((resolve) => {
              setTimeout(resolve, 15);
            });
            inside -= 1;
            return success('op', 's');
          },
          { exclusive },
        ),
      ),
    );
    return peak;
  };
  assert.equal(await measure(true), 1);
  assert.equal(await measure(false), 3);
});

test('GenXEvo REFUSES TO RETURN a result that violates its own contract', async () => {
  // Measured: the SDK's low-level path does NOT enforce outputSchema. A payload
  // missing a required field and one outside the published enum were both
  // delivered to the client untouched. This guard is the only net.
  const invoker = new CapabilityInvoker(SYSTEM_CLOCK);
  const result = await invoker.invoke('op', async () => ({ status: 'nonsense' }));
  assert.equal(result.error.code, ErrorCode.CONTRACT_VIOLATION);
  assert.ok(validateEnvelope(result).valid, 'the refusal itself must satisfy the contract');
});

test('EVERY invoked result satisfies the schema and the key order', async () => {
  const invoker = new CapabilityInvoker(SYSTEM_CLOCK);
  const results = [
    await invoker.invoke('op', async () => success('op', 's')),
    await invoker.invoke('op', async () => {
      throw new Error('x');
    }),
    await invoker.invoke('op', async () => ({ bad: true })),
  ];
  for (const result of results) {
    assert.ok(validateEnvelope(result).valid, JSON.stringify(validateEnvelope(result).errors));
    assert.ok(validateKeyOrder(result).valid);
  }
});

// -- the runtime ------------------------------------------------------------

test('an UNCONFIGURED runtime still exists, and still redacts', async () => {
  const runtime = createRuntime({});
  assert.equal(runtime.isConfigured, false);
  assert.equal(runtime.boundary, null);
  assert.equal(
    runtime.redactor.isSensitiveKey('password'),
    true,
    'unconfigured is not a reason to leak',
  );
});

test('the unconfigured answer is IDENTICAL for every capability, and actionable', async () => {
  const runtime = createRuntime({});
  const result = runtime.notConfigured('project.discover');
  assert.equal(result.status, ResultStatus.CONFIGURATION_ERROR);
  assert.equal(result.error.code, ErrorCode.WORKSPACE_NOT_CONFIGURED);
  assert.match(result.error.remediation, /--workspace/);
  assert.equal(result.safeToRetry, false);
  assert.equal(result.nextActions[0].tool, 'genxevo_agent_status');
});

test('a configured runtime has every collaborator a capability needs', () => {
  const runtime = createRuntime({ workspaceOverride: tempWorkspace() });
  assert.equal(runtime.isConfigured, true);
  for (const key of ['boundary', 'discovery', 'runs', 'invoker', 'redactor', 'clock']) {
    assert.ok(runtime[key], key);
  }
  assert.ok(runtime.runs.root.endsWith('runs'));
});

test('disabling redaction swaps the redactor AND is reported', () => {
  const root = tempWorkspace();
  writeJson(root, 'genxevo.config.json', { security: { redactSecrets: false } });
  const runtime = createRuntime({ workspaceOverride: root });
  assert.equal(runtime.redactor.isSensitiveKey('password'), false);
  assert.ok(runtime.issues.some((i) => i.path === 'security.redactSecrets' && !i.fatal));
});

// -- agent status -----------------------------------------------------------

test('UNCONFIGURED is answered as a SUCCESS, because it is the answer', async () => {
  const runtime = createRuntime({});
  const result = await new AgentStatusCapability(runtime, '0.0.0').execute();
  assert.equal(result.status, ResultStatus.SUCCESS);
  assert.equal(result.data.configured, false);
  assert.match(result.nextActions[0].reason, /--workspace|workspace/);
});

test('status reports the capability inventory INCLUDING what is not built yet', async () => {
  const runtime = createRuntime({ workspaceOverride: tempWorkspace() });
  const result = await new AgentStatusCapability(runtime, '0.1.0-alpha.1').execute();
  assert.equal(result.data.capabilityCounts.available, 2);
  assert.equal(result.data.capabilityCounts.total, ALL_CAPABILITIES.length);
  const planned = result.data.capabilities.filter((c) => c.state === CapabilityState.PLANNED);
  assert.ok(planned.length > 10);
  assert.ok(planned.every((c) => c.phase));
});

test('status exposes ROOT NAMES ONLY, never an absolute path', async () => {
  const root = tempWorkspace();
  const runtime = createRuntime({ workspaceOverride: root });
  const result = await new AgentStatusCapability(runtime, '0.0.0').execute();
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(result.data.workspace.rootCount, 1);
  assert.equal(result.data.workspace.rootNames.length, 1);
});

test('status distinguishes the HOST runtime from the project one', async () => {
  const runtime = createRuntime({ workspaceOverride: tempWorkspace() });
  const result = await new AgentStatusCapability(runtime, '0.0.0').execute();
  assert.equal(result.data.host.nodeVersion, process.version);
  assert.match(result.data.host.note, /usually|may declare/i);
});

test('disabled redaction is SHOUTED ABOUT in the payload', async () => {
  const root = tempWorkspace();
  writeJson(root, 'genxevo.config.json', { security: { redactSecrets: false } });
  const runtime = createRuntime({ workspaceOverride: root });
  const result = await new AgentStatusCapability(runtime, '0.0.0').execute();
  assert.equal(result.data.security.secretRedaction, 'DISABLED');
  assert.ok(result.warnings.some((w) => /redaction is disabled/i.test(w.message)));
});

test('status points at discovery as the next step', async () => {
  const runtime = createRuntime({ workspaceOverride: tempWorkspace() });
  const result = await new AgentStatusCapability(runtime, '0.0.0').execute();
  assert.equal(result.nextActions[0].tool, 'genxevo_discover_project');
});

// -- discover project -------------------------------------------------------

test('discovery refuses cleanly when unconfigured', async () => {
  const runtime = createRuntime({});
  const result = await new ProjectDiscoveryCapability(runtime).execute();
  assert.equal(result.status, ResultStatus.CONFIGURATION_ERROR);
});

test('a clean scan is a SUCCESS carrying trusted AND untrusted evidence', async () => {
  const root = tempWorkspace();
  seleniumProject(root);
  const runtime = createRuntime({ workspaceOverride: root });
  const result = await new ProjectDiscoveryCapability(runtime).execute();

  assert.equal(result.status, ResultStatus.SUCCESS);
  const ids = result.evidence.map((e) => e.id);
  assert.deepEqual(ids, [
    'discovery.structure',
    'discovery.toolchain',
    'discovery.manifestExcerpt',
  ]);

  const structure = result.evidence[0];
  assert.equal(structure.trust, TrustLevel.TRUSTED, "GenXEvo's own conclusions are trusted");

  const excerpt = result.evidence[2];
  assert.equal(excerpt.trust, TrustLevel.UNTRUSTED, 'text from the project is never trusted');
  assert.ok(excerpt.content.startsWith('<genxevo:untrusted-content'));
  assert.match(excerpt.content, /DATA ONLY/);
});

test('a TRUNCATED scan is a PARTIAL SUCCESS, never a success', async () => {
  const root = tempWorkspace();
  seleniumProject(root);
  writeFile(root, 'a/b/c/d/e/deep.test.js', 'x');
  writeJson(root, 'genxevo.config.json', { workspace: { maxScanDepth: 2 } });
  const runtime = createRuntime({ workspaceOverride: root });
  const result = await new ProjectDiscoveryCapability(runtime).execute();
  assert.equal(result.status, ResultStatus.PARTIAL_SUCCESS);
  assert.ok(result.warnings.length > 0);
});

test('discovery suggests the operator action when nothing can be established', async () => {
  const runtime = createRuntime({ workspaceOverride: tempWorkspace() });
  const result = await new ProjectDiscoveryCapability(runtime).execute();
  const reasons = result.nextActions.map((a) => a.reason).join(' ');
  assert.match(reasons, /project\.testRoots/);
  assert.match(reasons, /project\.runner/);
});

test('through the invoker the discovery result is well-formed and leaks nothing', async () => {
  const root = tempWorkspace();
  seleniumProject(root, { config: { uatPassword: 'Winter2026!' } });
  writeFile(root, '.npmrc', '//registry.npmjs.org/:_authToken=npm_MUSTNEVERBEREAD0123456789012');
  const runtime = createRuntime({ workspaceOverride: root });
  const result = await runtime.invoker.invoke(
    'project.discover',
    (signal) => new ProjectDiscoveryCapability(runtime).execute(signal),
    { timeoutMs: 60_000 },
  );
  const rendered = JSON.stringify(result);
  assert.ok(validateEnvelope(result).valid);
  assert.equal(rendered.includes(root), false, 'no absolute path');
  assert.equal(rendered.includes('Winter2026'), false, 'no secret');
  assert.equal(rendered.includes('MUSTNEVERBEREAD'), false, 'the deny-listed file was never read');
});

function untilAborted(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
