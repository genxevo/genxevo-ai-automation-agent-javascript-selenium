/**
 * GenXEvo's own validation of GenXEvo's own contract.
 *
 * WHY THIS EXISTS. The MCP SDK's low-level `Server` does not validate
 * `structuredContent` against a tool's published `outputSchema`. That was
 * measured, not assumed: a payload missing a required field and a payload with a
 * value outside the published enum were both delivered to the client unchanged,
 * with no error. The `McpServer` high-level API does validate — but only by
 * demanding a Zod schema, which is the dependency this product deliberately does
 * not take on for its contract.
 *
 * So the choice was: a validator we did not write, or a contract we own. This
 * module is the price of owning the contract, and paying it in about 120 lines
 * with zero dependencies is a good trade.
 *
 * WHAT IT IS. A deliberately small interpreter for exactly the JSON Schema
 * subset `envelopeSchema.js` uses: `type`, `properties`, `required`,
 * `additionalProperties: false`, `enum`, `items`, `minLength`, `minimum` and
 * `pattern`. Nothing else is supported, and an unsupported keyword is a loud
 * error rather than a silent pass — a validator that quietly ignores a
 * constraint is worse than no validator.
 *
 * It reads the SAME schema object that is published to `tools/list`, so the
 * thing an agent is promised and the thing the server checks cannot drift.
 * `test/contract.test.js` additionally cross-checks every verdict against `ajv`,
 * so this interpreter's faithfulness is measured rather than asserted.
 */

import { ENVELOPE_SCHEMA } from './envelopeSchema.js';
import { ENVELOPE_KEY_ORDER } from './vocabularies.js';

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'items',
  'minLength',
  'minimum',
  'pattern',
]);

/**
 * @typedef {{ valid: boolean, errors: string[] }} ValidationVerdict
 */

/**
 * Validate a payload against the published envelope schema.
 *
 * @param {unknown} payload
 * @returns {ValidationVerdict}
 */
export function validateEnvelope(payload) {
  return validateAgainst(payload, ENVELOPE_SCHEMA);
}

/**
 * Validate a value against any schema in the supported subset.
 *
 * Exported so a test can prove the "unsupported keyword throws" rule with a
 * schema of its own. A rule that cannot be exercised is a rule nobody can trust.
 *
 * @param {unknown} value
 * @param {Record<string, unknown>} schema
 * @returns {ValidationVerdict}
 */
export function validateAgainst(value, schema) {
  const errors = [];
  check(value, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate that the payload's keys are emitted in the published order.
 *
 * Separate from schema validation because JSON Schema has no notion of key
 * order — but in JavaScript the order IS the contract, since `JSON.stringify`
 * follows insertion order. A key assigned in the wrong place is the failure mode
 * this catches.
 *
 * @param {Record<string, unknown>} payload
 * @returns {ValidationVerdict}
 */
export function validateKeyOrder(payload) {
  const keys = Object.keys(payload);
  let cursor = -1;
  for (const key of keys) {
    const position = ENVELOPE_KEY_ORDER.indexOf(key);
    if (position === -1) {
      return { valid: false, errors: [`'${key}' is not part of the published envelope`] };
    }
    if (position <= cursor) {
      return {
        valid: false,
        errors: [`'${key}' is emitted out of the published order`],
      };
    }
    cursor = position;
  }
  return { valid: true, errors: [] };
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} schema
 * @param {string} path
 * @param {string[]} errors
 */
function check(value, schema, path, errors) {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(
        `validateEnvelope: unsupported JSON Schema keyword '${keyword}' at ${path || '/'}. ` +
          'Silently ignoring it would make this validator lie about the contract.',
      );
    }
  }

  const where = path || '(root)';

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${where}: expected ${schema.type}, got ${describe(value)}`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${where}: '${String(value)}' is not one of the published values`);
    return;
  }
  if (
    schema.minLength !== undefined &&
    typeof value === 'string' &&
    value.length < schema.minLength
  ) {
    errors.push(`${where}: shorter than the required ${schema.minLength} characters`);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${where}: below the minimum of ${schema.minimum}`);
  }
  if (schema.pattern !== undefined && typeof value === 'string') {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push(`${where}: does not match the required format`);
    }
  }

  if (schema.type === 'object' && isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${where}: missing required property '${key}'`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) {
          errors.push(`${where}: unexpected property '${key}'`);
        }
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        check(value[key], subSchema, path ? `${path}.${key}` : key, errors);
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => check(item, schema.items, `${path}[${index}]`, errors));
  }
}

function matchesType(value, type) {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      throw new Error(`validateEnvelope: unsupported type '${type}'`);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
