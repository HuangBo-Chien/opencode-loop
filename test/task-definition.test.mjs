import test from 'node:test';
import assert from 'node:assert/strict';
import * as Schema from 'effect/Schema';
import GraphPlugin from '../src/index.mjs';

// Exact native task fields from v1.18.25 (unchanged in v1.18.31).
const parameters = Schema.Struct({
  description: Schema.String, prompt: Schema.String, subagent_type: Schema.String,
  task_id: Schema.optional(Schema.String), command: Schema.optional(Schema.String),
  background: Schema.optional(Schema.Boolean),
});
const foreground = {
  type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' },
    subagent_type: { type: 'string' }, task_id: { type: 'string' }, command: { type: 'string' } },
  required: ['description', 'prompt', 'subagent_type'], additionalProperties: false,
};
async function harness() {
  const hooks = await GraphPlugin({});
  await hooks.config({});
  assert.equal(typeof hooks['tool.definition'], 'function', 'plugin must expose structured task nodeId');
  return hooks;
}

test('task definition extends only the model-facing schema, preserving native fields and decoder', async () => {
  const hooks = await harness();
  const jsonSchema = structuredClone(foreground);
  const output = { description: 'native task', parameters, jsonSchema };
  await hooks['tool.definition']({ toolID: 'task' }, output);
  assert.equal(output.parameters, parameters);
  assert.deepEqual(jsonSchema, foreground, 'do not mutate shared registry schemas');
  assert.deepEqual(output.jsonSchema.required, foreground.required);
  assert.equal(output.jsonSchema.properties.nodeId.type, 'string');
  assert.equal(output.jsonSchema.properties.nodeId.maxLength, 128);
  assert.equal(new RegExp(output.jsonSchema.properties.nodeId.pattern).test('impl\n'), false);
  assert.equal(output.jsonSchema.properties.background, undefined);
  for (const key of Object.keys(foreground.properties)) assert.deepEqual(output.jsonSchema.properties[key], foreground.properties[key]);
  const once = structuredClone(output.jsonSchema), description = output.description;
  await hooks['tool.definition']({ toolID: 'task' }, output);
  assert.deepEqual(output.jsonSchema, once);
  assert.equal(output.description, description);
  const other = { description: 'read', parameters, jsonSchema };
  await hooks['tool.definition']({ toolID: 'read' }, other);
  assert.equal(other.jsonSchema, jsonSchema);
  assert.equal(other.description, 'read');
});

test('background-capable Effect schema is projected without losing native fields', async () => {
  const hooks = await harness();
  const output = { description: 'native task', parameters, jsonSchema: undefined };
  await hooks['tool.definition']({ toolID: 'task' }, output);
  assert.equal(output.parameters, parameters);
  assert.equal(output.jsonSchema.properties.background.type, 'boolean');
  assert.equal(output.jsonSchema.properties.task_id.type, 'string');
  assert.equal(output.jsonSchema.properties.nodeId.type, 'string');
  assert.deepEqual(output.jsonSchema.required, foreground.required);
  const status = JSON.parse(await hooks.tool.graph_status.execute({}));
  assert.equal(status.dispatch.taskSchema.structuredNodeId, 'available');
});

test('unsupported schemas and conflicting nodeId properties are left unchanged and reported honestly', async () => {
  for (const jsonSchema of [false, { type: 'array' }, { ...foreground, properties: { ...foreground.properties, nodeId: { type: 'number' } } }]) {
    const hooks = await harness();
    const output = { description: 'native task', parameters: {}, jsonSchema };
    await hooks['tool.definition']({ toolID: 'task' }, output);
    assert.equal(output.jsonSchema, jsonSchema);
    assert.equal(output.description, 'native task');
    const status = JSON.parse(await hooks.tool.graph_status.execute({}));
    assert.equal(status.dispatch.taskSchema.structuredNodeId, 'unavailable');
  }
});

test('host-shaped schema → hook → native decode → task execution preserves binding and strips nodeId', async () => {
  const hooks = await harness();
  await hooks['chat.message']({ sessionID: 'root', agent: 'graph-orchestrator' }, { parts: [] });
  // Read-only role can demonstrate native argument transport without publishing a plan.
  const args = { description: 'explore', subagent_type: 'graph-explorer', prompt: 'Explore', background: true };
  const definition = { description: 'task', parameters, jsonSchema: undefined };
  await hooks['tool.definition']({ toolID: 'task' }, definition);
  await hooks['tool.execute.before']({ tool: 'task', sessionID: 'root', callID: 'explore' }, { args });
  const native = Schema.decodeUnknownSync(parameters)(args);
  assert.equal(native.background, true);
  assert.match(native.prompt, /RUNNER_TASK_CALL:/);
  let executions = 0;
  const rejectedArgs = { description: 'invalid', subagent_type: 'graph-verifier', nodeId: 'absent', prompt: 'Verify' };
  const original = structuredClone(rejectedArgs);
  await assert.rejects(async () => {
    await hooks['tool.execute.before']({ tool: 'task', sessionID: 'root', callID: 'invalid' }, { args: rejectedArgs });
    Schema.decodeUnknownSync(parameters)(rejectedArgs);
    executions++;
  }, /RUNNER_REJECTED\(NODE_NOT_FOUND\)/);
  assert.equal(executions, 0);
  assert.deepEqual(rejectedArgs, original);
  const report = JSON.parse(await hooks.tool.graph_inspect.execute({}, { sessionID: 'root', agent: 'graph-orchestrator' }));
  assert.equal(report.dispatches.length, 1, 'only the successful explorer has a reservation');
});

test('a later plugin changing our nodeId schema is treated as a collision, not overwritten', async () => {
  const hooks = await harness();
  const output = { description: 'task', parameters, jsonSchema: structuredClone(foreground) };
  await hooks['tool.definition']({ toolID: 'task' }, output);
  output.jsonSchema.properties.nodeId = { type: 'number' };
  const changed = output.jsonSchema;
  await hooks['tool.definition']({ toolID: 'task' }, output);
  assert.equal(output.jsonSchema, changed);
  assert.equal(output.jsonSchema.properties.nodeId.type, 'number');
  const status = JSON.parse(await hooks.tool.graph_status.execute({}));
  assert.equal(status.dispatch.taskSchema.reason, 'NODE_ID_SCHEMA_COLLISION');
});
