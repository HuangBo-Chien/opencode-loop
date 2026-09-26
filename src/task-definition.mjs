// Native task keeps its own decoder. This hook only extends the schema advertised
// to the model; the graph before-hook consumes nodeId before native execution.
const TARGET = Object.freeze({ type: 'string', minLength: 1, maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
  description: 'Graph task node ID. Prefer this field for graph-implementer/graph-verifier; no prompt marker is needed. Omit for non-graph tasks and nested image consultations. Authenticated task_id continuations may reuse their original node.' });
const GUIDANCE = 'Graph dispatch: use the optional nodeId field to select the planned node; keep prompt for supplementary context. RUNNER_REJECTED is a tool error before child creation: follow its nextAction, do not retry unchanged.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createTaskDefinitionHook() {
  let capability = { structuredNodeId: 'unobserved', reason: null };
  async function onToolDefinition({ toolID }, output) {
    if (toolID !== 'task') return;
    try {
      let schema = output.jsonSchema;
      if (schema === undefined) {
        // The SDK's native background task uses Effect, not Zod. Project the
        // actual schema rather than rebuilding (and losing) host parameters.
        const { toJsonSchemaDocument } = await import('effect/Schema');
        const document = toJsonSchemaDocument(output.parameters, { additionalProperties: true });
        schema = { ...document.schema, ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}) };
        // Match native projection of optional nullable properties. The actual
        // runtime decoder does not accept null for optional task fields.
        const required = new Set(schema.required ?? []);
        schema.properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, property]) => {
          if (required.has(name) || !Array.isArray(property.anyOf)) return [name, property];
          const choices = property.anyOf.filter(choice => choice.type !== 'null');
          if (choices.length !== 1) return [name, property];
          const { anyOf, ...rest } = property;
          return [name, { ...rest, ...choices[0] }];
        }));
        if (schema.additionalProperties === true) delete schema.additionalProperties;
      }
      if (!object(schema) || schema.type !== 'object' || !object(schema.properties)
        || !['description', 'prompt', 'subagent_type'].every(name => Object.hasOwn(schema.properties, name))) {
        capability = { structuredNodeId: 'unavailable', reason: 'TASK_SCHEMA_UNSUPPORTED' };
        return;
      }
      if (Object.hasOwn(schema.properties, 'nodeId')
        && JSON.stringify(schema.properties.nodeId) !== JSON.stringify(TARGET)) {
        capability = { structuredNodeId: 'unavailable', reason: 'NODE_ID_SCHEMA_COLLISION' };
        return;
      }
      const extended = { ...schema, properties: { ...schema.properties, nodeId: { ...TARGET } } };
      // Do not change output.parameters: the native decoder was compiled before
      // this hook, and other native tools must retain their original semantics.
      const description = output.description.includes(GUIDANCE) ? output.description : `${output.description}\n\n${GUIDANCE}`;
      output.jsonSchema = extended;
      output.description = description;
      capability = { structuredNodeId: 'available', reason: null };
    } catch {
      capability = { structuredNodeId: 'unavailable', reason: 'TASK_SCHEMA_UNSUPPORTED' };
    }
  }
  return { onToolDefinition, status: () => ({ ...capability }) };
}
