// Exact-version provenance, not a second artifact store. Historical entries
// contain only edges and invalidation status; they cannot satisfy a read.
import { cleanJson } from './json-safe.mjs';
import { canonicalOutput } from './task-spec.mjs';

// Admission reads only the latest valid slot. Lineage is deliberately not a
// historical artifact resolver; it authenticates already-consumed edges only.
export function artifactRef(state, ref) {
  const atIndex = ref.lastIndexOf('@');
  const name = atIndex === -1 ? ref : ref.slice(0, atIndex);
  const version = atIndex === -1 ? null : Number(ref.slice(atIndex + 1));
  const artifact = state.artifacts[name];
  if (!artifact) return { missing: `artifact ${ref} does not exist` };
  if (version !== null && artifact.version !== version) return { missing: `artifact ${ref} is not the current version (v${artifact.version})` };
  if (artifact.status !== 'valid') return { missing: `artifact ${name}@${artifact.version} is ${artifact.status}` };
  return { artifact };
}

// Normalize spelling only: never bind an explicit old/future pin to today's
// slot. Stripping zeroes also avoids rounding distinct large integer pins.
export const canonicalRef = (ref) => ref.replace(/@0*(\d+)$/, '@$1');
export const exactRef = (state, ref) => ref.includes('@') ? canonicalRef(ref)
  : state.artifacts[ref] ? `${ref}@${state.artifacts[ref].version}` : ref;

// Persisted pre-fix lineage may use either spelling as a key or an edge.
// Merge duplicate identities conservatively rather than dropping provenance
// or reviving an invalidated version because another spelling says "valid".
export function lineageIndex(state) {
  const index = new Map();
  for (const [ref, entry] of Object.entries(state.artifactLineage ?? {})) {
    const key = canonicalRef(ref);
    const previous = index.get(key);
    index.set(key, {
      basedOn: [...new Set([...(previous?.basedOn ?? []), ...(entry.basedOn ?? []).map(canonicalRef)])],
      status: previous && previous.status !== entry.status ? 'stale' : entry.status,
    });
  }
  return index;
}

export function repairSettlementPending(state, nodeId = null) {
  const reservations = state.dispatchReservations ?? [];
  const lineage = [...reservations, ...(state.settledDispatches ?? [])];
  return [...reservations, ...(state.pendingEffects ?? [])].some((entry) => {
    if (!entry.repairRevoked) return false;
    if (nodeId === null || entry.nodeId === nodeId) return true;
    if (!entry.nested) return false;
    // A nested free consultation owns no node. Its exact caller generation
    // keeps the affected node fenced even after that parent's host has ended.
    const owners = lineage.filter((owner) => owner.runId === state.runId && !owner.nested
      && owner.dispatchId === entry.callerDispatchId && owner.sessionId === entry.callerSessionId);
    const ids = new Set(owners.map((owner) => owner.nodeId).filter((id) => typeof id === 'string'));
    // Missing/conflicting durable lineage is not evidence of independence.
    return ids.size !== 1 || ids.has(nodeId);
  });
}

export function consumedRefs(state, node) {
  const refs = new Set();
  for (const ref of node.spec.inputs ?? []) {
    const resolution = artifactRef(state, ref);
    if (resolution.missing) throw new TypeError(resolution.missing);
    refs.add(`${ref.split('@')[0]}@${resolution.artifact.version}`);
  }
  for (const id of node.spec.dependsOn ?? []) {
    const dep = state.nodes[id];
    const name = dep && canonicalOutput(dep.spec);
    if (name && state.artifacts[name]) refs.add(exactRef(state, name));
  }
  if (['implement', 'verify'].includes(node.spec.kind)) {
    const approval = state.artifacts.review?.status === 'valid' ? 'review' : 'plan';
    if (state.artifacts[approval]) refs.add(exactRef(state, approval));
  }
  return [...refs];
}

export function validateRepairTargets(state, { nodeId, verdict, repairTargets }) {
  const node = state.nodes[nodeId];
  const direct = (node?.spec.dependsOn ?? []).filter((id) => state.nodes[id]?.spec.kind === 'implement');
  if (repairTargets !== undefined && (verdict !== 'FAIL' || node?.spec.baseline === true
    || !Array.isArray(repairTargets) || !repairTargets.length || repairTargets.length > 64
    || new Set(repairTargets).size !== repairTargets.length
    || repairTargets.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || !direct.includes(id)))) {
    return { ok: false, code: 'INVALID_REPAIR_TARGETS', detail: 'repairTargets requires unique literal DIRECT implement dependency node IDs, a nonempty array, and a nonbaseline FAIL verdict' };
  }
  return { ok: true, targets: repairTargets ?? [...new Set(direct)] };
}

// Compute retention against the proposed slots before publishing anything.
// Only lineage reachable from current artifacts, pins or consumed refs survives.
export function retainedLineage(state, artifacts = state.artifacts, nodes = state.nodes) {
  const available = lineageIndex(state);
  for (const [name, artifact] of Object.entries(state.artifacts)) available.set(`${name}@${artifact.version}`, {
    basedOn: [...new Set(artifact.basedOn ?? [])], status: artifact.status,
  });
  const current = new Map(Object.entries(artifacts).map(([name, artifact]) => [`${name}@${artifact.version}`, artifact]));
  const work = [...current.keys()];
  for (const node of Object.values(nodes)) work.push(...(node.consumedRefs ?? []), ...(node.spec.inputs ?? []).map((ref) => exactRef({ artifacts }, ref)));
  const seen = new Set();
  const retained = {};
  let edges = 0;
  for (let i = 0; i < work.length; i++) {
    const ref = canonicalRef(work[i]);
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (seen.size > 1024) throw new TypeError('Provenance capacity exceeded; revise the plan to release historical references');
    const entry = current.get(ref) ?? available.get(ref);
    if (!entry) continue; // Legacy gaps are diagnosed by repairClosure.
    const sources = (entry.basedOn ?? []).map(canonicalRef);
    edges += sources.length;
    if (edges > 4096) throw new TypeError('Provenance capacity exceeded; revise the plan to release historical references');
    if (!current.has(ref)) retained[ref] = { basedOn: [...sources], status: entry.status };
    work.push(...sources);
  }
  cleanJson(retained, { maxBytes: 131072, maxValues: 6000, maxDepth: 8 });
  return retained;
}

export function publishArtifact(state, name, artifact) {
  artifact = { ...artifact, basedOn: [...new Set((artifact.basedOn ?? []).map(canonicalRef))] };
  const artifacts = { ...state.artifacts, [name]: artifact };
  const artifactLineage = retainedLineage(state, artifacts);
  // Keep settlement headroom, including pure-runner publications.
  cleanJson({ ...state, artifacts, artifactLineage }, { maxBytes: 524288, maxValues: 12000, maxDepth: 32 });
  state.artifactLineage = artifactLineage;
  state.artifacts[name] = artifact;
}

// Snapshot every still-available consumed surface, including artifact-only and
// verify→verify dependencies. Historical lineage has edges, never file payloads.
export function verificationFiles(state, node) {
  const work = [...(node.consumedRefs ?? consumedRefs(state, node))];
  const history = lineageIndex(state);
  const seen = new Set();
  const files = new Set();
  for (let i = 0; i < work.length; i++) {
    const ref = canonicalRef(work[i]);
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (seen.size > 1024 || work.length > 8192) throw new TypeError('Provenance snapshot capacity exceeded; revise the plan to release references');
    const [name, pin] = ref.split('@');
    const current = state.artifacts[name];
    const artifact = current && (pin === undefined || current.version === Number(pin)) ? current : history.get(ref);
    if (!artifact) continue;
    for (const file of [...Object.keys(artifact.snapshot ?? {}), ...(artifact.kind === 'change' ? artifact.payload?.filesTouched ?? [] : [])]) files.add(file);
    work.push(...(artifact.basedOn ?? []).map((source) => exactRef(state, source)));
  }
  return [...files];
}

// One adjacency construction and one worklist, including historical edges.
// No backwards traversal to prerequisites of an affected combined verifier.
export function repairClosure(state, targets, verifierId) {
  const edges = new Map();
  let edgeCount = 0;
  const link = (source, consumer) => {
    if (++edgeCount > 8192) throw new TypeError('Provenance closure capacity exceeded; revise the plan to release references');
    if (!edges.has(source)) edges.set(source, new Set());
    edges.get(source).add(consumer);
  };
  const entries = lineageIndex(state);
  if (entries.size + Object.keys(state.artifacts).length > 1024) throw new TypeError('Provenance closure capacity exceeded; revise the plan to release historical references');
  for (const [name, artifact] of Object.entries(state.artifacts)) {
    const ref = `${name}@${artifact.version}`;
    entries.set(ref, artifact);
  }
  const missing = new Set();
  const sourceRef = (ref) => {
    // Legacy unpinned provenance cannot prove which version was consumed.
    if (!ref.includes('@')) missing.add(ref);
    const exact = exactRef(state, ref);
    if (!entries.has(exact)) missing.add(ref);
    return exact;
  };
  for (const [ref, artifact] of entries) for (const source of artifact.basedOn ?? []) link(`ref:${sourceRef(source)}`, `ref:${ref}`);
  for (const node of Object.values(state.nodes)) {
    const id = node.spec.id;
    const started = Array.isArray(node.consumedRefs);
    if (!started && (node.attempt > 0 || node.state === 'SUCCEEDED') && !['plan', 'explore', 'analyze'].includes(node.spec.kind)) {
      // Executed legacy nodes lack admission provenance. An explicit pin is
      // usable only if its exact lineage still exists and is valid; today's
      // replacement slot cannot establish the old version's independence.
      // Never-started future inputs are scheduling requirements, not reads.
      for (const ref of node.spec.inputs ?? []) {
        const source = sourceRef(ref);
        if (entries.get(source)?.status !== 'valid') missing.add(ref);
      }
    }
    const refs = started ? node.consumedRefs : (node.spec.inputs ?? []).map((ref) => exactRef(state, ref));
    for (const ref of refs) link(`ref:${started ? sourceRef(ref) : ref}`, `node:${id}`);
    for (const dep of node.spec.dependsOn ?? []) {
      const name = state.nodes[dep] && canonicalOutput(state.nodes[dep].spec);
      // Exact consumed outputs carry execution dependencies when available.
      if (!started || !refs.some((ref) => ref.split('@')[0] === name)) link(`node:${dep}`, `node:${id}`);
    }
    const name = canonicalOutput(node.spec);
    const artifact = state.artifacts[name];
    if (artifact && (node.producedRef && canonicalRef(node.producedRef) === `${name}@${artifact.version}` || !started && node.state === 'SUCCEEDED')) {
      link(`node:${id}`, `ref:${name}@${artifact.version}`);
      link(`ref:${name}@${artifact.version}`, `node:${id}`);
    }
  }
  const work = targets.flatMap((id) => [`node:${id}`, `ref:${sourceRef(exactRef(state, `change:${id}`))}`]);
  // The failed verifier itself is new work, even when it has no implement deps.
  work.push(`node:${verifierId}`);
  const seen = new Set(work);
  for (let i = 0; i < work.length; i++) for (const next of edges.get(work[i]) ?? []) {
    if (!seen.has(next)) { seen.add(next); work.push(next); }
  }
  return { nodeIds: work.filter((key) => key.startsWith('node:')).map((key) => key.slice(5)),
    refs: work.filter((key) => key.startsWith('ref:')).map((key) => key.slice(4)), missing: [...missing] };
}

export function applyRepair(state, closure, targets, verifierId, now) {
  const invalid = new Set(closure.refs);
  for (const [name, artifact] of Object.entries(state.artifacts)) if (invalid.has(`${name}@${artifact.version}`)) {
    artifact.status = targets.includes(artifact.nodeId) && artifact.kind === 'change' ? 'superseded' : 'stale';
  }
  for (const [ref, entry] of Object.entries(state.artifactLineage ?? {})) if (invalid.has(canonicalRef(ref))) entry.status = 'stale';
  for (const id of closure.nodeIds) {
    const node = state.nodes[id];
    if (!node) continue;
    if (targets.includes(id) || id === verifierId) { node.state = 'PENDING'; node.finishedAt = now; }
    else if (node.state !== 'PENDING' || node.attempt > 0) { node.state = 'STALE'; node.finishedAt = now; }
    if (node.spec.kind === 'verify') { node.attempt = 0; node.lastFailure = null; }
  }
  const offendingRefs = new Set(closure.missing);
  const producers = new Map(Object.values(state.nodes).filter((node) => !['plan', 'explore', 'analyze'].includes(node.spec.kind))
    .map((node) => [canonicalOutput(node.spec), node.spec.id]));
  for (const node of Object.values(state.nodes)) {
    if (node.state === 'SUCCEEDED' || node.state === 'SKIPPED') continue;
    for (const ref of node.spec.inputs ?? []) {
      const [name, pin] = ref.split('@');
      const artifact = state.artifacts[name];
      if (pin !== undefined) {
        if (invalid.has(canonicalRef(ref)) || artifact && Number(pin) <= artifact.version && (Number(pin) !== artifact.version || artifact.status !== 'valid')) offendingRefs.add(ref);
      } else if ((!artifact || artifact.status !== 'valid') && (!producers.has(name) || producers.get(name) === node.spec.id)) offendingRefs.add(ref);
    }
  }
  for (const name of ['plan', 'review']) if (state.artifacts[name] && invalid.has(`${name}@${state.artifacts[name].version}`)) offendingRefs.add(`${name}@${state.artifacts[name].version}`);
  state.repairPlanRevision = offendingRefs.size ? { needsPlanRevision: true, offendingRefs: [...offendingRefs],
    detail: 'Repair invalidated approval or requires unavailable pinned/legacy evidence; submit a revised plan with satisfiable inputs (pins were not rewritten)' } : null;
  return state.repairPlanRevision ?? { needsPlanRevision: false, offendingRefs: [] };
}
