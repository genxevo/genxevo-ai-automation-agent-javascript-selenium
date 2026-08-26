/**
 * Deep-freezing, which in JavaScript is a correctness requirement rather than a
 * stylistic one.
 *
 * `Object.freeze` is shallow. A frozen `ToolResult` whose `warnings` array is
 * not itself frozen can still be mutated after construction, and — because the
 * invoker stamps timing by rebuilding the result — two results could otherwise
 * alias one mutable array. The C# and Python siblings get immutability from
 * `record` and `@dataclass(frozen=True)`; JavaScript has to do it explicitly,
 * so it is done in one place and asserted by a test.
 */

/**
 * Recursively freeze a value and everything reachable from it.
 *
 * @template T
 * @param {T} value
 * @returns {T} the same reference, frozen
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) {
      deepFreeze(descriptor.value);
    }
  }
  return value;
}

/**
 * True when `value` and everything reachable from it is frozen.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDeeplyFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !('value' in descriptor) || isDeeplyFrozen(descriptor.value);
  });
}
