const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const TARGET_REQUIRED_AGENTS = new Set(['graph-implementer', 'graph-verifier']);

// Only strict target roles reject malformed marker-like text. Other roles may
// mention nodeId syntax in ordinary prose without turning it into metadata.
export function parseNodeIdHint(args, { strict = false } = {}) {
  const source = args && typeof args === 'object' ? args : {};
  const hasArgument = Object.hasOwn(source, 'nodeId');
  if (hasArgument && (typeof source.nodeId !== 'string' || !NODE_ID_PATTERN.test(source.nodeId))) {
    return { allowed: false, code: 'INVALID_NODE_ID', detail: 'nodeId must be a 1-128 character node identifier using letters, digits, dot, underscore, colon or hyphen, starting with a letter or digit' };
  }
  const prompt = typeof source.prompt === 'string' ? source.prompt : '';
  const firstLine = prompt.split('\n', 1)[0] ?? '';
  const match = firstLine.match(/^\s*\[nodeId:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]\s*$/);
  if (!match && strict && /\[\s*nodeId\b/i.test(firstLine)) {
    return { allowed: false, code: 'INVALID_NODE_ID', detail: 'put exactly one [nodeId:target-node] marker alone on the first prompt line, then put the task description on the next line' };
  }
  if (hasArgument && match && source.nodeId !== match[1]) {
    return { allowed: false, code: 'CONFLICTING_NODE_ID', detail: `nodeId argument ${source.nodeId} conflicts with first-line marker ${match[1]}; both must name the same node` };
  }
  return { allowed: true, nodeId: hasArgument ? source.nodeId : match?.[1] ?? null };
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
  return { allowed: true, nodeId: desired ?? parsed.nodeId };
}
