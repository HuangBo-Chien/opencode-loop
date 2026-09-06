export const AGENT_NAMES = Object.freeze([
  'graph-orchestrator', 'graph-explorer', 'graph-planner', 'graph-plan-critic',
  'graph-implementer', 'graph-verifier', 'graph-multimodal',
]);

function record(value, name) {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} options must be a plain object`);
  }
}

export function parseOptions(input = {}) {
  record(input, 'plugin');
  const defaults = { enabled: true, setDefaultAgent: false, models: {}, maxAttempts: 3, maxParallel: 4 };
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !Object.hasOwn(defaults, key)) throw new TypeError(`Unknown plugin option: ${String(key)}`);
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) throw new TypeError('Plugin options must contain values, not getters');
  }
  const options = { ...defaults, ...input };
  for (const name of ['enabled', 'setDefaultAgent']) {
    if (typeof options[name] !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  }
  for (const [name, upper] of [['maxAttempts', 10], ['maxParallel', 16]]) {
    if (!Number.isInteger(options[name]) || options[name] < 1 || options[name] > upper) throw new TypeError(`${name} must be an integer from 1 to ${upper}`);
  }
  record(options.models, 'models');
  const models = {};
  for (const name of Reflect.ownKeys(options.models)) {
    if (!AGENT_NAMES.includes(name)) throw new TypeError(`Unknown model agent option: ${String(name)}`);
    const descriptor = Object.getOwnPropertyDescriptor(options.models, name);
    const value = descriptor.value;
    if (!Object.hasOwn(descriptor, 'value') || typeof value !== 'string' || !value.length || value.length > 256 || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
      throw new TypeError(`Invalid model option for ${name}`);
    }
    models[name] = value;
  }
  return Object.freeze({ ...options, models: Object.freeze(models) });
}
