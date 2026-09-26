import { validateFileClaim, matchScopePath } from './task-spec.mjs';
import { publishArtifact } from './artifact-dependencies.mjs';
import { unresolvedEffects } from './effect-resolution.mjs';
import { workspaceChanges } from './direct-workspace.mjs';

export const directPending = state => (state?.pendingEffects ?? []).some(effect => effect.tool === 'graph_direct_check');
export const directSettled = state => !(state.dispatchReservations?.length || state.dispatchRecoveryIssues?.length || state.pendingEffects?.length || unresolvedEffects(state).length);
const permissions = new WeakMap();
export function registerDirectPermission(store, identity) {
  const entries = permissions.get(store) ?? new Map();
  permissions.set(store, entries); entries.set(identity.nonce, identity);
  return () => entries.delete(identity.nonce);
}
export function authenticDirectPermission(store, input, binding, state) {
  const entry = permissions.get(store)?.get(input.metadata?.directPermissionNonce);
  return !!entry && input.type === 'bash' && state?.mode === 'direct' && state.status === 'RUNNING'
    && entry.runId === state.runId && entry.sessionId === input.sessionID && entry.dispatchId === binding?.dispatchId
    && state.nodes.direct?.state === 'RUNNING' && entry.contractVersion === state.artifacts['direct-contract']?.version
    && entry.command === input.metadata.command && entry.checkId === input.metadata.directCheckId;
}
export function directPath(path, stateDirectory = '.opencode-loop', { cwd = false } = {}) {
  if (cwd && path === '.') return true;
  const checked = validateFileClaim(path);
  if (!checked.ok || checked.path !== path || path.includes('\\')) return false;
  const comparable = process.platform === 'win32' ? path.toLowerCase() : path;
  const excluded = process.platform === 'win32' ? stateDirectory.toLowerCase() : stateDirectory;
  return !comparable.split('/').some(part => ['.git', 'node_modules'].includes(part))
    && comparable !== excluded && !comparable.startsWith(`${excluded}/`);
}
export function validateDirectContract(contract, settings = {}) {
  const list = (value, max) => Array.isArray(value) && value.length > 0 && value.length <= max && value.every(v => typeof v === 'string' && v.trim() && v.length <= 2000);
  if (!contract || typeof contract.requirement !== 'string' || !contract.requirement.trim() || contract.requirement.length > 8000
    || typeof contract.rationale !== 'string' || !contract.rationale.trim() || contract.rationale.length > 2000
    || !list(contract.acceptance, 16) || !list(contract.writeScope, 32) || !list(contract.deliverables, 32)) return 'Requirement, rationale, acceptance, literal writeScope and deliverables must be bounded and nonempty';
  if (contract.acceptance.some(value => /[\x00-\x1f\x7f]|\[RUNNER/i.test(value))) return 'Acceptance criteria must be single-line plain text without RUNNER markers';
  // Direct uses literal file scope. Broader directory/glob work belongs in Graph.
  if (![...contract.writeScope, ...contract.deliverables].every(path => directPath(path, settings.stateDirectory))) return 'Direct paths must be literal files outside excluded infrastructure';
  if (!contract.deliverables.every(path => contract.writeScope.includes(path))) return 'Deliverables must lie inside writeScope';
  if (!Array.isArray(contract.checks) || !contract.checks.length || contract.checks.length > 8 || new Set(contract.checks.map(c => c.id)).size !== contract.checks.length) return 'Declare 1-8 unique mandatory checks';
  for (const check of contract.checks) {
    if (!check || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(check.id) || typeof check.command !== 'string' || !check.command.trim() || check.command.length > 2000
      || !directPath(check.cwd, settings.stateDirectory, { cwd: true }) || !Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 300000) return 'Invalid check id, command, workspace cwd or timeout';
    if (/(?:^|[\s;&|])(?:nohup|start-process|start-job)\b|\.unref\s*\(|detached\s*:\s*true|&\s*$|(?:^|\s)start\s+"/i.test(check.command)) return 'Checks must run in the foreground and must not detach background processes';
  }
  return null;
}
export function installDirect(state, contract, baseline, now) {
  const version = (state.artifacts['direct-contract']?.version ?? 0) + 1;
  state.direct = { baseline: state.direct?.baseline ?? baseline, evidence: state.direct?.evidence ?? [], failures: state.direct?.failures ?? 0,
    revisions: version, stateDirectory: state.direct?.stateDirectory ?? '.opencode-loop' };
  state.mode = 'direct';
  state.nodes = { direct: { spec: { id: 'direct', kind: 'implement', agent: 'graph-implementer', dependsOn: [], inputs: [`direct-contract@${version}`],
    outputs: ['change:direct'], writeScope: contract.writeScope, deliverables: contract.deliverables, acceptance: contract.acceptance, allowShell: false },
    state: 'PENDING', attempt: state.nodes.direct?.attempt ?? 0, sessionId: null, dispatchId: null } };
  publishArtifact(state, 'direct-contract', { kind: 'direct-contract', version, basedOn: [], payload: contract, status: 'valid', createdAt: now });
  for (const name of ['change:direct', 'direct-acceptance']) if (state.artifacts[name]) state.artifacts[name].status = 'stale';
  state.updatedAt = now;
  return version;
}
export function validateDirectChange(state, binding, args, inventory) {
  const reject = (code, detail) => ({ ok: false, code, detail });
  if (state.pendingEffects?.length || unresolvedEffects(state).length) return reject('DIRECT_EFFECT_PENDING', 'Pending or uncertain effects must settle; do not replay checks');
  if ((args.unresolved ?? []).length) return reject('DIRECT_UNRESOLVED', 'Direct acceptance requires no unresolved items');
  const contract = state.artifacts['direct-contract'];
  const node = state.nodes.direct;
  const current = evidence => evidence.runId === state.runId && evidence.sessionId === binding.sessionId && evidence.dispatchId === binding.dispatchId
    && evidence.attempt === node.attempt && evidence.contractVersion === contract.version;
  for (const check of contract.payload.checks) {
    const evidence = state.direct.evidence.filter(e => e.checkId === check.id && current(e)).at(-1);
    if (!evidence || evidence.status !== 'passed' || evidence.exitCode !== 0 || evidence.uncertain || evidence.beforeRevision !== inventory.revision || evidence.revision !== inventory.revision) return reject('DIRECT_CHECK_REQUIRED', `${check.id} needs current runner-owned successful evidence on this workspace revision`);
  }
  const claimed = new Set(args.filesTouched);
  const deleted = new Set(args.filesDeleted ?? []);
  const changed = workspaceChanges(state.direct.baseline, inventory);
  for (const path of changed) {
    if (!node.spec.writeScope.some(scope => matchScopePath(scope, path))) return reject('OUT_OF_SCOPE', `${path} changed outside the contract`);
    if (!claimed.has(path)) return reject('LEDGER_MISMATCH', `${path} changed without a file claim`);
    if (!Object.hasOwn(inventory.files, path) && !deleted.has(path)) return reject('INVALID_FILE_CLAIM', `${path} must be reported as deleted`);
  }
  for (const path of node.spec.deliverables) if (!Object.hasOwn(inventory.files, path)) return reject('DELIVERABLE_MISSING', `${path} is absent`);
  const snapshot = Object.fromEntries([...claimed].map(path => [path, inventory.files[path] ?? 'MISSING']));
  return { ok: true, snapshot, revision: inventory.revision, checks: contract.payload.checks.map(c => c.command) };
}
export function acceptDirect(state, result, now) {
  const version = (state.artifacts['direct-acceptance']?.version ?? 0) + 1;
  publishArtifact(state, 'direct-acceptance', { kind: 'direct-acceptance', version, basedOn: [state.nodes.direct.producedRef, `direct-contract@${state.artifacts['direct-contract'].version}`],
    payload: { verdict: 'PASS', revision: result.revision, checks: result.checks }, snapshot: {}, status: 'valid', createdAt: now });
  state.direct.acceptedRevision = result.revision;
  state.status = 'SETTLING'; state.lifecycleVersion = 1; state.updatedAt = now;
}
