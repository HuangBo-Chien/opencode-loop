// TaskSpec validation: turn planner work packages into a verifiable task graph.
// Pure functions; invalid model input returns structured errors instead of throwing.

import { AGENT_NAMES } from './config.mjs';

export const TASK_KINDS = Object.freeze(['explore', 'analyze', 'plan', 'review', 'implement', 'verify']);
export const WRITE_KINDS = Object.freeze(['implement']);
export const KIND_AGENTS = Object.freeze({
  explore: Object.freeze(['graph-explorer']),
  analyze: Object.freeze(['graph-multimodal']),
  plan: Object.freeze(['graph-planner']),
  review: Object.freeze(['graph-plan-critic']),
  implement: Object.freeze(['graph-implementer']),
  verify: Object.freeze(['graph-verifier']),
});
const ID_SOURCE = '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}';
// Canonical prefixes are outside the node-id budget. Arbitrary names keep
// their original bound; graph validation still enforces runner-owned names.
const ARTIFACT_NAME_SOURCE = `(?:${ID_SOURCE}|(?:change|verification|baseline):${ID_SOURCE})`;
export const ARTIFACT_REF_PATTERN = new RegExp(`^${ARTIFACT_NAME_SOURCE}(@[0-9]+)?$`);
const ID_PATTERN = new RegExp(`^${ID_SOURCE}$`);
const NAME_PATTERN = new RegExp(`^${ARTIFACT_NAME_SOURCE}$`);
const MAX_TEXT = 2000;
const MAX_SPECS = 64;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
const nonemptyText = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

// Normalizes a workspace-relative path/glob: forward slashes, no leading './',
// no absolute paths, no '..' segments, no empty or '.' segments.
export function normalizeScopePath(input) {
  if (typeof input !== 'string' || !input.length || input.length > 512 || /[\x00-\x1f\x7f]/.test(input)) return null;
  if (input.includes('\\') || input.includes('\0')) return null;
  if (/^[a-zA-Z]:/.test(input) || input.startsWith('/')) return null;
  const segments = input.split('/');
  if (segments.some((segment) => !segment.length || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

// File claims are literals, unlike writeScope patterns. Escape attempts remain
// strict scope failures; ordinary formatting errors may be corrected in-place.
export function validateFileClaim(input) {
  if (typeof input === 'string' && (/^(?:[a-zA-Z]:|[/\\])/.test(input)
    || input.split(/[/\\]/).includes('..'))) {
    return { ok: false, code: 'OUT_OF_SCOPE', detail: `${input} escapes workspace-relative paths` };
  }
  const path = normalizeScopePath(input);
  if (!path || /[*?[\]{}!]/.test(path)) {
    return { ok: false, code: 'INVALID_FILE_CLAIM', detail: `${input} must be a literal workspace-relative file path (no directory slash or glob)` };
  }
  return { ok: true, path };
}

const GLOB_CHARS = /[*?[\]{}!]/;

// Minimal glob matcher: '**' spans separators, '*' within one segment.
export function matchScopePath(pattern, candidate) {
  const normalizedPattern = normalizeScopePath(pattern);
  const normalizedCandidate = normalizeScopePath(candidate);
  if (!normalizedPattern || !normalizedCandidate) return false;
  const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const segmentToRegex = (segment) => {
    if (segment.includes('**')) return '.*';
    return segment.split('*').map(escapeRegex).join('[^/]*');
  };
  const source = normalizedPattern.split('/').map(segmentToRegex).join('/');
  return new RegExp(`^${source}$`).test(normalizedCandidate);
}

// The run's unique path token: runId with path-hostile separators replaced.
// Planners reference it as {{run}} in writeScope/deliverables entries; the
// runner expands it before validation so run-unique lanes never depend on
// the planner guessing the run id.
export function runToken(runId) {
  return String(runId).replaceAll(':', '-');
}

// Expands {{run}} in the enforced path fields (writeScope, deliverables) of
// raw TaskSpec objects before validation. Prose fields are left untouched:
// the submit response echoes the expanded paths for the planner to quote.
export function expandRunTokens(specs, runId) {
  const token = runToken(runId);
  const expand = (entry) => (typeof entry === 'string' ? entry.replaceAll('{{run}}', token) : entry);
  return specs.map((spec) => {
    if (!spec || typeof spec !== 'object') return spec;
    const next = { ...spec };
    if (Array.isArray(next.writeScope)) next.writeScope = next.writeScope.map(expand);
    if (Array.isArray(next.deliverables)) next.deliverables = next.deliverables.map(expand);
    return next;
  });
}

// Conservative overlap test for two write-scope patterns: compares the literal
// directory prefix (segments before the first glob-bearing segment). Overlap is
// assumed whenever one prefix contains the other.
function scopePathsOverlap(patternA, patternB) {
  const a = normalizeScopePath(patternA);
  const b = normalizeScopePath(patternB);
  if (!a || !b) return true;
  const literalPrefix = (pattern) => {
    const segments = pattern.split('/');
    const cut = segments.findIndex((segment) => GLOB_CHARS.test(segment));
    return (cut === -1 ? segments : segments.slice(0, cut)).join('/');
  };
  const prefixA = literalPrefix(a);
  const prefixB = literalPrefix(b);
  if (prefixA === prefixB) return true;
  const shorter = prefixA.length < prefixB.length ? prefixA : prefixB;
  const longer = prefixA.length < prefixB.length ? prefixB : prefixA;
  return shorter.length > 0 && (longer === shorter || longer.startsWith(`${shorter}/`));
}

export function validateTaskSpec(spec, { maxAttemptsCeiling = 20 } = {}) {
  const errors = [];
  const fail = (detail) => errors.push(detail);
  if (!isPlainObject(spec)) return { ok: false, errors: ['task spec must be a plain object'], spec: null };
  const id = spec.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail(`${JSON.stringify(id)}: id must match ${ID_PATTERN.source}`);
  const agent = spec.agent;
  if (typeof agent !== 'string' || !AGENT_NAMES.includes(agent) || agent === 'graph-orchestrator') fail(`${JSON.stringify(agent)}: agent must be a dispatchable graph specialist`);
  const kind = spec.kind;
  if (typeof kind !== 'string' || !TASK_KINDS.includes(kind)) fail(`${JSON.stringify(kind)}: kind must be one of ${TASK_KINDS.join(', ')}`);
  if (typeof agent === 'string' && typeof kind === 'string' && TASK_KINDS.includes(kind) && !KIND_AGENTS[kind].includes(agent)) {
    fail(`kind ${kind} cannot be assigned to ${agent}`);
  }
  for (const [field, optional] of [['dependsOn', false], ['inputs', true], ['outputs', true], ['writeScope', true], ['acceptance', true]]) {
    const value = spec[field];
    if (value === undefined) {
      if (!optional) fail(`${field} is required`);
      continue;
    }
    if (!Array.isArray(value) || value.length > 32 || value.some((entry) => typeof entry !== 'string')) {
      fail(`${field} must be an array of strings (max 32)`);
      continue;
    }
    for (const entry of value) {
      if (field === 'dependsOn' && (!ID_PATTERN.test(entry) || entry === id)) fail(`${entry}: invalid dependsOn entry`);
      if (field === 'inputs' && !ARTIFACT_REF_PATTERN.test(entry)) fail(`${entry}: invalid artifact reference (expected name or name@version)`);
      if (field === 'outputs' && !NAME_PATTERN.test(entry)) fail(`${entry}: invalid artifact name`);
      if ((field === 'writeScope' || field === 'acceptance') && !nonemptyText(entry)) fail(`${field} entries must be nonempty text`);
      // Dispatch injects acceptance verbatim as runner-owned lines; embedded
      // newlines could forge column-0 [RUNNER] directives, so one line only.
      if (field === 'acceptance' && /[\n\r]/.test(entry)) fail('acceptance entries must be single-line criteria');
      if (field === 'writeScope' && nonemptyText(entry) && !normalizeScopePath(entry)) fail(`${entry}: writeScope entries must be relative workspace paths or globs`);
      if (field === 'writeScope' && nonemptyText(entry) && /[<>{}]/.test(entry)) fail(`${entry}: unsubstituted template placeholder; use the {{run}} token (expanded by the runner before validation) or a literal path`);
    }
  }
  if (kind === 'implement') {
    if (!Array.isArray(spec.writeScope) || spec.writeScope.length < 1) fail('implement nodes require a non-empty writeScope');
    if (!Array.isArray(spec.acceptance) || spec.acceptance.length < 1) fail('implement nodes require acceptance criteria');
  } else if (Array.isArray(spec.writeScope) && spec.writeScope.length > 0) {
    fail('only implement nodes may declare a writeScope');
  }
  // Optional concrete deliverable list (implement nodes only): literal
  // workspace-relative files inside the node's writeScope. graph_inspect
  // uses it as the denominator for mechanical progress reporting.
  if (spec.deliverables !== undefined) {
    if (kind !== 'implement') {
      fail('only implement nodes may declare deliverables');
    } else if (!Array.isArray(spec.deliverables) || spec.deliverables.length > 32 || spec.deliverables.some((entry) => typeof entry !== 'string')) {
      fail('deliverables must be an array of strings (max 32)');
    } else if (Array.isArray(spec.writeScope) && spec.writeScope.length > 0) {
      for (const entry of spec.deliverables) {
        const checked = validateFileClaim(entry);
        if (!checked.ok) fail(`deliverables: ${checked.detail}`);
        else if (/[<>{}]/.test(entry)) fail(`deliverables: ${entry}: unsubstituted template placeholder; use the {{run}} token (expanded by the runner before validation) or a literal path`);
        else if (!spec.writeScope.some((pattern) => matchScopePath(pattern, checked.path))) {
          fail(`deliverables: ${checked.path} is outside this node's writeScope`);
        }
      }
    }
  }
  const maxAttempts = spec.maxAttempts === undefined ? undefined : spec.maxAttempts;
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > maxAttemptsCeiling)) {
    fail(`maxAttempts must be an integer from 1 to ${maxAttemptsCeiling}`);
  }
  const allowShell = spec.allowShell === undefined ? undefined : spec.allowShell;
  if (allowShell !== undefined && typeof allowShell !== 'boolean') fail('allowShell must be a boolean');
  // Baseline verify nodes capture pre-change suite evidence (which commands
  // already fail before any implement node writes); only verify nodes may
  // declare the flag.
  if (spec.baseline !== undefined) {
    if (kind !== 'verify') fail('only verify nodes may declare baseline');
    else if (typeof spec.baseline !== 'boolean') fail('baseline must be a boolean');
  }
  if (typeof spec.title === 'string' && !nonemptyText(spec.title)) fail('title must be nonempty text');
  return { ok: errors.length === 0, errors, spec: { ...spec } };
}

export const canonicalOutput = (spec) => spec.kind === 'implement' ? `change:${spec.id}`
  : spec.kind === 'verify' ? (spec.baseline === true ? `baseline:${spec.id}` : `verification:${spec.id}`)
  : spec.kind === 'plan' ? 'plan' : spec.kind === 'review' ? 'review' : 'findings';

// Structural and state-aware callers share the same labeled dependency walk.
// getDeps must describe prerequisites the scheduler actually waits for; an
// available historical input is not automatically an edge to its old producer.
export function validateDependencies(nodes, getDeps = (spec) => spec.dependsOn.map((id) => ({ id, via: 'dependsOn' }))) {
  const edges = new Map([...nodes].map(([id, spec]) => [id, getDeps(spec)]));
  const visited = new Set();
  const active = new Set();
  const path = [];
  function visit(id) {
    if (visited.has(id)) return null;
    active.add(id);
    for (const edge of edges.get(id)) {
      const step = `${id} --${edge.via}--> ${edge.id}`;
      if (!nodes.has(edge.id)) return `${step}: unknown dependency`;
      if (active.has(edge.id)) return `task graph contains a dependency cycle: ${[...path, step].join('; ')}; remove or correct the problematic input/dependency`;
      path.push(step);
      const error = visit(edge.id);
      path.pop();
      if (error) return error;
    }
    active.delete(id);
    visited.add(id);
    return null;
  }
  for (const id of nodes.keys()) {
    const error = visit(id);
    if (error) return { ok: false, errors: [error], order: null };
  }
  const order = [];
  const pending = new Set(nodes.keys());
  while (pending.size) {
    const id = [...pending].sort().find((id) => edges.get(id).every((edge) => !pending.has(edge.id)));
    pending.delete(id);
    order.push(id);
  }
  return { ok: true, errors: [], order };
}

// This layer knows shapes, names and explicit dependencies, not run evidence
// or runner-assigned versions. submitPlan performs effective liveness next.
export function validateTaskGraph(specs, { planOnly = false, light = false, maxAttemptsCeiling = 20 } = {}) {
  const errors = [];
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > MAX_SPECS) {
    return { ok: false, errors: [`specs must be a non-empty array (max ${MAX_SPECS})`], order: null, nodes: null };
  }
  const byId = new Map();
  for (const spec of specs) {
    const result = validateTaskSpec(spec, { maxAttemptsCeiling });
    errors.push(...result.errors.map((detail) => `${spec && spec.id !== undefined ? JSON.stringify(spec.id) : '(missing id)'}: ${detail}`));
    if (result.ok) {
      if (byId.has(spec.id)) errors.push(`${spec.id}: duplicate node id`);
      else byId.set(spec.id, result.spec);
    }
  }
  if (errors.length) return { ok: false, errors, order: null, nodes: null };

  for (const [id, spec] of byId) {
    for (const dep of spec.dependsOn) {
      if (!byId.has(dep)) errors.push(`${id}: dependsOn references unknown node ${dep}`);
    }
  }
  if (errors.length) return { ok: false, errors, order: null, nodes: null };

  // Artifact naming contract. The runner always stores evidence under fixed
  // names (findings, plan, review, change:<id>, verification:<id>,
  // baseline:<id>); declared `outputs` must match them and `inputs` may only
  // reference them, so an input can never chase a name that nothing produces
  // and strand a node.
  for (const [id, spec] of byId) {
    const canonical = canonicalOutput(spec);
    for (const entry of spec.outputs ?? []) {
      if (entry !== canonical) {
        errors.push(`${id}: outputs must be [${canonical}] (the runner-assigned artifact name for ${spec.kind} nodes) or omitted; custom artifact names are never produced`);
      }
    }
    for (const ref of spec.inputs ?? []) {
      const name = ref.split('@', 1)[0];
      const changeTarget = name.startsWith('change:') ? byId.get(name.slice('change:'.length)) : null;
      const verificationTarget = name.startsWith('verification:') ? byId.get(name.slice('verification:'.length)) : null;
      const baselineTarget = name.startsWith('baseline:') ? byId.get(name.slice('baseline:'.length)) : null;
      const producible = name === 'findings' || name === 'plan' || name === 'review'
        || (name.startsWith('change:') && name.length > 7 && (!changeTarget || canonicalOutput(changeTarget) === name))
        || (name.startsWith('verification:') && name.length > 13 && (!verificationTarget || canonicalOutput(verificationTarget) === name))
        || (name.startsWith('baseline:') && name.length > 9 && (!baselineTarget || canonicalOutput(baselineTarget) === name));
      if (!producible) {
        errors.push(`${id}: inputs reference ${ref}, which no runner-managed artifact can satisfy; allowed names are findings, plan, review, change:<implement node id>, verification:<verify node id>, baseline:<baseline verify node id> (optional @version)`);
      }
    }
  }
  if (errors.length) return { ok: false, errors, order: null, nodes: null };

  const dependencies = validateDependencies(byId);
  if (!dependencies.ok) return { ...dependencies, nodes: null };
  const { order } = dependencies;

  const kindCount = (kind) => [...byId.values()].filter((spec) => spec.kind === kind);
  const planNodes = kindCount('plan');
  if (planNodes.length !== 1) errors.push(`graph requires exactly one plan node, found ${planNodes.length}`);
  const reviewNodes = kindCount('review');
  if (reviewNodes.length > 1) errors.push(`at most one review node is allowed, found ${reviewNodes.length}`);
  for (const spec of kindCount('review')) {
    if (!spec.dependsOn.some((dep) => byId.get(dep)?.kind === 'plan')) errors.push(`${spec.id}: review nodes must depend on the plan node`);
  }
  for (const spec of kindCount('implement')) {
    if (!light) {
      if (!spec.dependsOn.some((dep) => byId.get(dep)?.kind === 'review')) errors.push(`${spec.id}: implement nodes must depend on a review node (review gate is mandatory; use intent "light" for a critic-free small change)`);
    } else if (!spec.dependsOn.some((dep) => ['plan', 'review'].includes(byId.get(dep)?.kind))) {
      errors.push(`${spec.id}: implement nodes must depend on the plan node in light graphs`);
    }
  }
  if (light && kindCount('implement').length > 1) errors.push('light graphs allow at most one implement node');
  const baselineNodes = kindCount('verify').filter((spec) => spec.baseline === true);
  for (const spec of kindCount('verify')) {
    if (spec.baseline === true) {
      // Baseline verify nodes capture pre-change suite evidence, so they must
      // never wait on implement output and must sit behind the review gate
      // (full flow) or the plan node (light flow).
      if (spec.dependsOn.some((dep) => byId.get(dep)?.kind === 'implement')) errors.push(`${spec.id}: baseline verify nodes must not depend on implement nodes (they capture pre-change evidence)`);
      if (!light) {
        if (!spec.dependsOn.some((dep) => byId.get(dep)?.kind === 'review')) errors.push(`${spec.id}: baseline verify nodes must depend on the review node`);
      } else if (!spec.dependsOn.some((dep) => byId.get(dep)?.kind === 'plan')) {
        errors.push(`${spec.id}: baseline verify nodes must depend on the plan node in light graphs`);
      }
    } else if (!spec.dependsOn.some((dep) => byId.get(dep)?.kind === 'implement')) {
      errors.push(`${spec.id}: verify nodes must depend on at least one implement node`);
    }
  }
  // When a baseline is declared, every implement node depends on it so the
  // capture is mechanically ordered before any change lands.
  if (baselineNodes.length) {
    for (const spec of kindCount('implement')) {
      if (!spec.dependsOn.some((dep) => byId.get(dep)?.baseline === true)) errors.push(`${spec.id}: implement nodes must depend on a baseline verify node when one is declared (baseline evidence must be captured before any change)`);
    }
  }
  if (planOnly && (kindCount('implement').length || kindCount('verify').length)) {
    errors.push('plan-only graphs must not contain implement or verify nodes');
  }

  const implementNodes = kindCount('implement');
  for (let index = 0; index < implementNodes.length; index += 1) {
    for (let other = index + 1; other < implementNodes.length; other += 1) {
      const left = implementNodes[index];
      const right = implementNodes[other];
      for (const pathLeft of left.writeScope) {
        for (const pathRight of right.writeScope) {
          if (scopePathsOverlap(pathLeft, pathRight)) {
            errors.push(`${left.id} and ${right.id}: write scopes overlap on ${pathLeft} / ${pathRight}`);
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, order, nodes: byId };
}
