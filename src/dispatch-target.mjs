const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const TARGET_REQUIRED_AGENTS = new Set(['graph-implementer', 'graph-verifier']);

// A structured nodeId is authoritative. Legacy routing reads only a leading
// first-line marker, never examples later in prose. Preserve recognizable
// conflicts even when the coordinator supplies the new field.
export function parseNodeIdHint(args, { strict = false } = {}) {
  const source = args && typeof args === 'object' ? args : {};
  const hasArgument = Object.hasOwn(source, 'nodeId');
  if (hasArgument && (typeof source.nodeId !== 'string' || !NODE_ID_PATTERN.test(source.nodeId))) {
    return { allowed: false, code: 'INVALID_NODE_ID', detail: 'nodeId must be a 1-128 character node identifier using letters, digits, dot, underscore, colon or hyphen, starting with a letter or digit' };
  }
  const prompt = typeof source.prompt === 'string' ? source.prompt : '';
  const firstLine = prompt.split('\n', 1)[0] ?? '';
  const markers = [];
  let rest = firstLine, malformed = false;
  // Only an adjacent leading marker sequence carries routing intent. Once
  // ordinary prose starts, examples (even on this same line) remain prose.
  while (/^\s*\[\s*nodeId\b/i.test(rest)) {
    const marker = rest.match(/^\s*\[\s*nodeId:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]/i);
    if (!marker) { malformed = true; break; }
    markers.push(marker[1]);
    rest = rest.slice(marker[0].length);
  }
  if (hasArgument) {
    const conflict = markers.find(marker => marker !== source.nodeId);
    if (conflict) return { allowed: false, code: 'CONFLICTING_NODE_ID', detail: `nodeId argument ${source.nodeId} conflicts with leading marker ${conflict}; remove the contradictory marker or correct nodeId` };
    return { allowed: true, nodeId: source.nodeId, source: 'argument' };
  }
  if (strict && (malformed || markers.length > 1)) {
    return { allowed: false, code: 'INVALID_NODE_ID', detail: 'set nodeId to one valid node ID, or use exactly one leading [nodeId:target-node] marker; same-line task text is allowed' };
  }
  return { allowed: true, nodeId: markers[0] ?? null, source: markers.length ? 'marker' : 'none' };
}

export function resolveNodeIdHint(args, desiredNodeId = null, { strict = false } = {}) {
  const parsed = parseNodeIdHint(args, { strict });
  if (!parsed.allowed) return parsed;

  const desired = desiredNodeId === undefined ? null : desiredNodeId;
  if (desired !== null && (typeof desired !== 'string' || !NODE_ID_PATTERN.test(desired))) {
    return { allowed: false, code: 'INVALID_NODE_ID', detail: 'dispatch target must be a valid node identifier' };
  }
  if (desired !== null && parsed.nodeId !== null && desired !== parsed.nodeId) {
    return { allowed: false, code: 'CONFLICTING_NODE_ID', detail: `dispatch target ${desired} conflicts with supplied nodeId ${parsed.nodeId}; both must name the same node` };
  }
  return { allowed: true, nodeId: desired ?? parsed.nodeId, source: parsed.source === 'none' && desired !== null ? 'argument' : parsed.source };
}
