// Deep plain-JSON sanitizer with structural and size caps.
// Returns a frozen deep copy with object keys sorted, so JSON.stringify of the
// result is a stable canonical form suitable for hashing.
// Rejects: proxies, non-plain prototypes, accessors, symbol keys, cycles,
// sparse/non-dense arrays, non-finite numbers, oversized payloads.

import { createHash } from 'node:crypto';
import { types } from 'node:util';

const MAX_DEPTH_DEFAULT = 24;
const MAX_VALUES_DEFAULT = 4000;
const MAX_BYTES_DEFAULT = 262_144;

export function cleanJson(input, { maxDepth = MAX_DEPTH_DEFAULT, maxValues = MAX_VALUES_DEFAULT, maxBytes = MAX_BYTES_DEFAULT } = {}) {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set();
  const charge = (text) => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) throw new TypeError('JSON payload exceeds byte limit');
  };
  function visit(value, depth) {
    if (++nodes > maxValues || depth > maxDepth) throw new TypeError('JSON payload exceeds structural limits');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      charge(JSON.stringify(value));
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers are unsupported');
      charge(String(value));
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object' || types.isProxy(value)) throw new TypeError('Expected plain JSON data');
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (proto !== (array ? Array.prototype : Object.prototype) && !(proto === null && !array)) throw new TypeError('Expected plain JSON prototype');
    if (ancestors.has(value)) throw new TypeError('Cyclic JSON data');
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) throw new TypeError('JSON symbol keys are unsupported');
    if (keys.length > 1001) throw new TypeError('JSON payload exceeds property limit');
    const fields = array ? keys.filter((key) => key !== 'length') : [...keys].sort();
    if (array && (value.length > maxValues || fields.length !== value.length || fields.some((key, index) => key !== String(index)))) {
      throw new TypeError('Expected dense JSON array without extra properties');
    }
    charge(array ? '[]' : '{}');
    const result = array ? [] : {};
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON accessors and hidden properties are unsupported');
      charge(array ? ',' : `${JSON.stringify(key)}:,`);
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  return visit(input, 0);
}

export function stableHash(value) {
  const canonical = JSON.stringify(cleanJson(value));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
