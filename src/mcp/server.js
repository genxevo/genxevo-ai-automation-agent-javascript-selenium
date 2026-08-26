/**
 * The MCP tool surface.
 *
 * Every handler here is a thin adapter: resolve the capability, invoke it
 * through the `CapabilityInvoker`, return the payload. No branching, no I/O, no
 * policy. That is deliberate - a tool handler cannot be unit tested through an
 * MCP client, so nothing that could be wrong is allowed to live in one.
 *
 * FOUR PROPERTIES OF THIS ADAPTER ARE DECISIONS, NOT ACCIDENTS.
 *
 * THE LOW-LEVEL `Server` IS USED, NOT `McpServer`. See `toolSchemas.js`.
 *
 * TOOL NAMES ARE DECLARED EXPLICITLY, never derived from a function name. An
 * implicit name is a published contract that changes silently when someone
 * renames a function, and the implementation this family learned from shipped
 * two tool descriptions instructing an agent to call tools that did not exist
 * under those names.
 *
 * TOOLS RETURN AN OBJECT, NOT A JSON STRING. Measured against the real SDK: an
 * object comes back as a readable text block AND a real `structuredContent`, and
 * the two are BYTE-IDENTICAL - the Python sibling has to publish an
 * "absent and null mean the same thing" caveat because pydantic materialises its
 * envelope; JavaScript has no such step. Returning a string would produce
 * `{"result": "<json text>"}` and would be strictly worse.
 *
 * ONLY AVAILABLE CAPABILITIES ARE REGISTERED. Planned capabilities are published
 * in `genxevo_agent_status` so an agent can plan around them, but none is
 * callable: a stub that answers "not implemented" consumes a tool slot, invites
 * a call, and teaches the agent something false.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { AVAILABLE_CAPABILITIES, capabilityByName } from '../core/capabilities/catalog.js';
import {
  AgentStatusCapability,
  OPERATION as STATUS_OPERATION,
} from '../core/capabilities/agentStatus.js';
import {
  OPERATION as DISCOVER_OPERATION,
  ProjectDiscoveryCapability,
} from '../core/capabilities/discoverProject.js';
import { ErrorCategory } from '../core/contract/vocabularies.js';
import { ErrorCode } from '../core/contract/errorCodes.js';
import { agentError } from '../core/contract/agentError.js';
import { failed } from '../core/contract/toolResult.js';
import { SERVER_INSTRUCTIONS, toolDescriptors } from './toolSchemas.js';

export const SERVER_NAME = 'genxevo-selenium-agent';

/** Time budgets, in milliseconds. */
export const STATUS_TIMEOUT_MS = 10_000;
export const DISCOVER_TIMEOUT_MS = 120_000;

/**
 * Create the MCP server and register every capability this build actually has.
 *
 * @param {import('../core/capabilities/runtime.js').AgentRuntime} runtime
 * @param {string} productVersion
 */
export function buildServer(runtime, productVersion) {
  const server = new Server(
    {
      name: SERVER_NAME,
      title: 'GenXEvo AI Automation Agent - JavaScript Selenium',
      version: productVersion,
    },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  const statusCapability = new AgentStatusCapability(runtime, productVersion);
  const discoveryCapability = new ProjectDiscoveryCapability(runtime);

  const handlers = new Map([
    [
      'genxevo_agent_status',
      {
        operation: STATUS_OPERATION,
        timeoutMs: STATUS_TIMEOUT_MS,
        run: (signal) => statusCapability.execute(signal),
      },
    ],
    [
      'genxevo_discover_project',
      {
        operation: DISCOVER_OPERATION,
        timeoutMs: DISCOVER_TIMEOUT_MS,
        run: (signal) => discoveryCapability.execute(signal),
      },
    ],
  ]);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDescriptors(AVAILABLE_CAPABILITIES),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name;
    const handler = handlers.get(name);

    if (!handler) {
      // An unregistered name reaches here only if the client invented one. It is
      // answered in the GenXEvo envelope rather than as a protocol error, so an
      // agent can read it with the same parser it uses for everything else.
      const known = capabilityByName(name);
      const payload = failed(
        'agent.unknown_tool',
        agentError({
          code: known ? ErrorCode.NOT_IMPLEMENTED : ErrorCode.ARGUMENT_INVALID,
          category: known ? ErrorCategory.NOT_IMPLEMENTED : ErrorCategory.VALIDATION,
          message: known
            ? `Capability '${name}' is designed but is not implemented in this build.`
            : `'${name}' is not a GenXEvo capability.`,
          remediation: known
            ? `It is scheduled for phase ${known.phase}. Do not retry; call genxevo_agent_status to see what this build has.`
            : 'Call genxevo_agent_status to see the capabilities this build provides.',
        }),
      );
      return toContent(payload);
    }

    // `extra.signal` is a live AbortSignal supplied by the SDK. The invoker
    // composes it with its own deadline; nothing here has to invent a
    // cancellation channel.
    const result = await runtime.invoker.invoke(handler.operation, handler.run, {
      timeoutMs: handler.timeoutMs,
      signal: extra?.signal,
    });

    return toContent(result);
  });

  return server;
}

/**
 * One payload, rendered twice: as the human-readable text block and as the
 * machine-readable structured object. Built from the SAME object, so a test can
 * assert they are byte-identical over the real transport.
 */
function toContent(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
