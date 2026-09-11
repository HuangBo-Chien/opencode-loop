export const AGENT_NAMES = Object.freeze([
  'graph-orchestrator', 'graph-explorer', 'graph-planner', 'graph-plan-critic',
  'graph-implementer', 'graph-verifier', 'graph-multimodal',
]);

function record(value, name) {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} options must be a plain object`);
  }
}

// Hosts report the git worktree path; outside a git repository that value
// degrades to the filesystem root, which is never a usable state root.
export function resolveWorktree(context) {
  for (const candidate of [context?.worktree, context?.directory]) {
    if (typeof candidate === 'string' && candidate && candidate !== '/') return candidate;
  }
  return null;
}

const STATE_DIRECTORY_PATTERN = /^(?!\.+$)[A-Za-z0-9.][A-Za-z0-9._-]{0,63}$/;

function validateStateDirectory(value) {
  if (typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f\\]/.test(value)) throw new TypeError('stateDirectory must be forward-slash separated path segments');
  const segments = value.split('/');
  if (segments.length < 1 || segments.length > 4 || segments.some((segment) => !STATE_DIRECTORY_PATTERN.test(segment) || segment === '.' || segment === '..')) {
    throw new TypeError('stateDirectory must be 1-4 forward-slash separated segments matching [A-Za-z0-9][A-Za-z0-9._-]');
  }
  return value;
}

export function parseOptions(input = {}) {
  record(input, 'plugin');
  const defaults = {
    enabled: true, setDefaultAgent: false, models: {},
    maxAttempts: 3, maxParallel: 4, maxImplementerParallel: 1,
    stateDirectory: '.opencode-loop', maxPlanRevisions: undefined, enforcement: 'hooks',
    journal: { enabled: true, includeUserRequest: true, semanticSearch: true, maxUserRequestChars: 8000 },
  };
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !Object.hasOwn(defaults, key)) throw new TypeError(`Unknown plugin option: ${String(key)}`);
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) throw new TypeError('Plugin options must contain values, not getters');
  }
  const options = { ...defaults, ...input };
  for (const name of ['enabled', 'setDefaultAgent']) {
    if (typeof options[name] !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  }
  for (const [name, upper] of [['maxAttempts', 10], ['maxParallel', 16], ['maxImplementerParallel', 4]]) {
    if (!Number.isInteger(options[name]) || options[name] < 1 || options[name] > upper) throw new TypeError(`${name} must be an integer from 1 to ${upper}`);
  }
  if (options.maxPlanRevisions !== undefined && (!Number.isInteger(options.maxPlanRevisions) || options.maxPlanRevisions < 1 || options.maxPlanRevisions > 10)) {
    throw new TypeError('maxPlanRevisions must be an integer from 1 to 10 when provided');
  }
  options.maxPlanRevisions = options.maxPlanRevisions ?? options.maxAttempts;
  validateStateDirectory(options.stateDirectory);
  if (options.enforcement !== 'hooks') throw new TypeError("enforcement must be 'hooks' (the only supported mode)");
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
  record(options.journal, 'journal');
  const journal = { ...defaults.journal };
  for (const name of Reflect.ownKeys(options.journal)) {
    if (typeof name !== 'string' || !Object.hasOwn(journal, name)) throw new TypeError(`Unknown journal option: ${String(name)}`);
    const descriptor = Object.getOwnPropertyDescriptor(options.journal, name);
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('Journal options must contain values, not getters');
    journal[name] = descriptor.value;
  }
  for (const name of ['enabled', 'includeUserRequest', 'semanticSearch']) {
    if (typeof journal[name] !== 'boolean') throw new TypeError(`journal.${name} must be a boolean`);
  }
  if (!Number.isInteger(journal.maxUserRequestChars) || journal.maxUserRequestChars < 1 || journal.maxUserRequestChars > 32000) {
    throw new TypeError('journal.maxUserRequestChars must be an integer from 1 to 32000');
  }
  return Object.freeze({ ...options, models: Object.freeze(models), journal: Object.freeze(journal) });
}
