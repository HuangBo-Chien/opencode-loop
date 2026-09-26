// Bounded model-facing diagnostics. Throwing from the before-hook prevents the
// native task decoder/executor (and therefore child creation) from running.
const WAIT = new Set(['DISPATCH_PENDING', 'WRITER_CAPACITY', 'READER_CAPACITY', 'NESTED_CONSULT_CAPACITY', 'ALREADY_RUNNING', 'RUN_BUSY', 'REPAIR_SETTLEMENT_PENDING']);
const TARGET = new Set(['NODE_ID_REQUIRED', 'INVALID_NODE_ID', 'CONFLICTING_NODE_ID', 'NODE_NOT_FOUND', 'TASK_NODE_MISMATCH', 'TASK_CALLER_MISMATCH', 'FRESH_SESSION_REQUIRED', 'AGENT_REQUIRED', 'INVALID_AGENT']);
const bounded = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;

export function dispatchRejection(decision, args, { callID, source } = {}) {
  const nextAction = TARGET.has(decision.code) ? 'correct-target'
    : WAIT.has(decision.code) ? 'wait-for-completion'
    : decision.code === 'PLAN_REVISION_REQUIRED' ? 'revise-plan'
    : ['AWAITING_DECISION', 'RUN_BLOCKED', 'ATTEMPTS_EXHAUSTED'].includes(decision.code) ? 'user-decision'
    : 'inspect-run';
  const candidates = (decision.candidates ?? []).slice(0, 16);
  const diagnostic = { code: decision.code, detail: bounded(decision.detail, 2000), nextAction,
    callID: bounded(callID, 256), requestedNodeId: bounded(args.nodeId, 128), targetSource: source ?? 'none',
    candidates, candidatesTotal: (decision.candidates ?? []).length,
    hint: nextAction === 'correct-target' ? 'Correct nodeId/subagent_type/task_id, then make a new task call. Do not copy a rejected prompt.'
      : nextAction === 'wait-for-completion' ? 'Wait for the existing work to finish; do not redispatch or poll in a loop.'
      : 'Inspect the run and resolve the blocker before dispatching again; do not retry unchanged.' };
  const error = new Error(`RUNNER_REJECTED(${decision.code}): ${JSON.stringify(diagnostic)}`);
  error.name = 'DispatchRejection';
  error.code = decision.code;
  error.diagnostic = diagnostic;
  return error;
}
