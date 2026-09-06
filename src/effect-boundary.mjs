import { types } from 'node:util';

// Internal trusted-code adapter, deliberately not exported by the plugin entry.
// operation: a plain JSON object with id /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.
// All JSON snapshots: <=32 nesting levels, <=10,000 values, <=1 MiB encoded.
// Callbacks receive a frozen context containing operation and, as available,
// permission, authorization, execution, result. Contracts (all awaited):
// preflight(context) -> { decision: 'ALLOW' | 'DENY' }
// ask(context) -> any fulfilled value (native Ask commonly returns undefined).
// capturePermission(context) -> { durable: true, evidenceId: nonempty string }
//   Only this trusted callback attests durable native permission; Ask's return
//   value is NOT permission evidence. Production must bind it to this invocation.
// prepare(context) -> { decision: 'ALLOW', authorizationId: nonempty string }
// verify(context) -> { decision: 'ALLOW', operationId: operation.id, payload: JSON }
//   The trusted verifier must bind payload to current durable authorization.
// effect(execution.payload, context) -> JSON result (null allowed, not undefined)
// commit(context) -> { committed: true }
// recover({ ...context, stage: 'effect' | 'commit', error })
//   -> { recoveryRequired: true }; recovery NEVER retries or reports success.
// Additional JSON callback fields are preserved for the production adapter.
// Callbacks must not come from plugin options or model tool arguments.
// The retained promise map protects ONE instance for its lifetime. It is NOT
// durable replay protection, cross-instance locking or a real-host acceptance.

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function snapshot(input) {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set();
  const charge = (text) => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 1_048_576) throw new TypeError('JSON snapshot exceeds byte limit');
  };
  function visit(value, depth) {
    if (++nodes > 10_000 || depth > 32) throw new TypeError('JSON snapshot exceeds structural limits');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      charge(JSON.stringify(value));
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
    if (keys.length > 10_001) throw new TypeError('JSON snapshot exceeds property limit');
    const result = array ? [] : {};
    const fields = array ? keys.filter((key) => key !== 'length') : keys.sort();
    if (array && (value.length > 10_000 || fields.length !== value.length || fields.some((key, index) => key !== String(index)))) throw new TypeError('Expected dense JSON array without extra properties');
    charge(array ? '[]' : '{}');
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

function requireResult(raw, stage, predicate) {
  const value = snapshot(raw);
  if (!value || Array.isArray(value) || typeof value !== 'object' || !predicate(value)) throw new Error(`Invalid or denied ${stage} result`);
  return value;
}
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

export function createEffectBoundary({ preflight, ask, capturePermission, prepare, verify, effect, commit, recover }) {
  for (const callback of [preflight, ask, capturePermission, prepare, verify, effect, commit, recover]) {
    if (typeof callback !== 'function') throw new TypeError('All effect boundary callbacks are required');
  }
  const executions = new Map();
  async function run(operation) {
    let context = Object.freeze({ operation });
    requireResult(await preflight(context), 'preflight', (value) => value.decision === 'ALLOW');
    await ask(context);
    const permission = requireResult(await capturePermission(context), 'permission capture', (value) => value.durable === true && nonempty(value.evidenceId));
    context = Object.freeze({ ...context, permission });
    const authorization = requireResult(await prepare(context), 'authorization', (value) => value.decision === 'ALLOW' && nonempty(value.authorizationId));
    context = Object.freeze({ ...context, authorization });
    const execution = requireResult(await verify(context), 'verification', (value) => value.decision === 'ALLOW' && value.operationId === operation.id && Object.hasOwn(value, 'payload'));
    context = Object.freeze({ ...context, execution });
    let stage = 'effect';
    try {
      const result = snapshot(await effect(execution.payload, context));
      context = Object.freeze({ ...context, result });
      stage = 'commit';
      requireResult(await commit(context), 'commit', (value) => value.committed === true);
      return Object.freeze({ status: 'COMMITTED', operationId: operation.id, result });
    } catch (error) {
      const uncertain = new Error(`Operation ${operation.id} requires recovery after ${stage}`, { cause: error });
      uncertain.code = 'RECOVERY_REQUIRED';
      try {
        requireResult(await recover(Object.freeze({ ...context, stage, error })), 'recovery', (value) => value.recoveryRequired === true);
      } catch (recoveryError) {
        uncertain.recoveryError = recoveryError;
      }
      throw uncertain;
    }
  }
  function execute(input) {
    try {
      const operation = snapshot(input);
      if (!operation || Array.isArray(operation) || typeof operation !== 'object' || !idPattern.test(operation.id ?? '') || typeof operation.id !== 'string') throw new TypeError('Invalid operation id');
      const key = JSON.stringify(operation);
      const previous = executions.get(operation.id);
      if (previous) {
        if (previous.key !== key) throw new Error('Operation id already belongs to a different invocation');
        return previous.promise;
      }
      // Defer callbacks until the map entry exists, including reentrant calls.
      const promise = Promise.resolve().then(() => run(operation));
      executions.set(operation.id, { key, promise });
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return Object.freeze({ execute });
}
