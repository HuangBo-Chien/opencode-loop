# opencode-loop

`0.1.0-alpha.2` is a usable seven-agent advisory workflow for the official OpenCode `1.18.25` plugin API. It uses native `task` dispatch and native permissions. The package name is provisional; no public npm release is claimed.

The coordinator routes read-only requests through exploration (with optional multimodal analysis), then answers. For changes it requests exploration → planning → plan critique → implementation → independent verification, returning critique failures to planning and verification failures to implementation. A plan-only request stops before implementation. Explicitly authorized implementation does not require a redundant conversational confirmation; native permission prompts still apply.

Workflow order, retry counts, parallelism and single-writer behavior are **prompt guidance**. The strict production run adapter is unavailable. `graph_status` reports `workflowMode: "advisory"`, `runtimeAvailable: true`, `managedRuntimeStatus: "unavailable"`, `enforcementAttested: false` and `limitsEnforced: false`. `GRAPH_MANAGED_SESSIONS` remains a design target, not an enforcement claim. Native tool availability also depends on the host, model and user permission settings.

## Project-local installation

Use Node.js 22 or newer. From this package directory run `npm install --ignore-scripts`, `npm test`, then `npm pack --ignore-scripts`. This produces `opencode-loop-0.1.0-alpha.2.tgz`; these commands do not publish or install globally.

From the project where you want to use the plugin, install that local tarball:

```powershell
npm install --ignore-scripts --save-dev C:\path\to\opencode-loop-0.1.0-alpha.2.tgz
node --input-type=module -e "import {pathToFileURL} from 'node:url'; import path from 'node:path'; console.log(pathToFileURL(path.resolve('node_modules/opencode-loop/src/index.mjs')).href)"
```

Use the printed absolute file URL in the project's `opencode.json` plugin tuple (merge with existing configuration). For example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["file:///C:/path/to/project/node_modules/opencode-loop/src/index.mjs", {
      "maxAttempts": 3,
      "maxParallel": 4
    }]
  ]
}
```

Start OpenCode in that project and select `graph-orchestrator`. Example requests: `請找出登入流程並解釋，目前不要修改。`, `只產出改善登入錯誤處理的計畫。`, or `請實作登入錯誤處理並驗證結果。` Ask it to call `graph_status` to inspect availability. To select this agent by default, add `"setDefaultAgent": true` inside the tuple options. To override a model, add `"models": { "graph-multimodal": "provider/model-id" }`, using an actual configured model with the required input support. With no override, the host chooses the model.

## Roles and permissions

| Agent | Mode | Responsibility | Additional native permission |
| --- | --- | --- | --- |
| `graph-orchestrator` | primary | Route, delegate, track and summarize | `task` only to the six specialists; `question`, `todowrite` allowed |
| `graph-explorer` | subagent | Read source and gather evidence | `webfetch`, `websearch` ask |
| `graph-planner` | subagent | Plan scoped changes and acceptance checks | `webfetch`, `websearch` ask |
| `graph-plan-critic` | subagent | Review plan and request revisions | `webfetch`, `websearch` ask |
| `graph-implementer` | subagent | Sole planned writer | `edit`, `bash` ask |
| `graph-verifier` | subagent | Independently validate results | `bash` ask; no edit |
| `graph-multimodal` | subagent | Analyze supported visual inputs honestly | `webfetch`, `websearch` ask |

All roles default unknown tools (including arbitrary MCP tools) to deny, allow `read`, `glob`, `grep`, `list` and `graph_status`, and ask for `external_directory` and `doom_loop`. Read rules explicitly deny `*.env` and `*.env.*`. Specialists cannot call `task`. Shell tests may write artifacts or execute project code: the verifier is not a read-only sandbox. Read exclusions do not form a complete data isolation boundary; prompts prohibit bypassing them using other tools.

Native agent definitions and the current default remain intact unless `setDefaultAgent` is true. Any existing definition with one of the seven reserved names causes an atomic collision error, leaving configuration unchanged.

## Options

The default plugin function accepts `(context, options)`. Supported options are plain data:

| Key | Default | Accepted values |
| --- | --- | --- |
| `enabled` | `true` | Boolean; false returns no hooks |
| `setDefaultAgent` | `false` | Boolean; true selects `graph-orchestrator` |
| `models` | `{}` | Map of seven full agent names to nonempty model strings, max 256 characters, no surrounding whitespace or control characters |
| `maxAttempts` | `3` | Integer 1–10; prompt-guided maximum attempts per critique or implementation/verification loop, including the first attempt |
| `maxParallel` | `4` | Integer 1–16; prompt-guided maximum independent read-only tasks |

Unknown keys, callbacks and invalid values fail initialization, including when disabled. Options are copied at initialization. These limits are included in the coordinator prompt and status; they are not enforced by a scheduler. The package entry exports only the default plugin function. Internal modules are not supported public APIs, and there are no imports from developer-global scripts or settings.

## Verification limits

Unit tests cover registration, native preservation, collisions, options, native permission definitions, role prompt contracts and truthful status. A relocation test packs and unpacks the real tarball and imports it with the real SDK/tool dependency closure, without workspace links. Prompt assertions verify supplied instructions, not model compliance or host permission behavior. Real-host workflow acceptance is separate evidence.

An isolated official OpenCode 1.18.25 host passed scripted-provider integration: plugin status, six actual child sessions and native reads, an edit held until a native once response, a rejected edit leaving its file unchanged, and an explorer edit attempt blocked because its tool was unavailable. The provider was a local deterministic fixture, not a real language model. This verifies those host/tool integration paths, not real-model reasoning, visual understanding, every shell behavior, or strict graph enforcement. No user API credentials or daily profile were used.

The internal effect boundary is tested separately and remains unused by registered agents/tools. Its permission durability and authorization binding are trusted callback obligations. Preparation and verification failures require cleanup by callbacks or their owning adapter. Replay protection is limited to one instance, and its retained invocation map needs lifecycle/admission management and durable cross-instance protection before production integration. No strict mechanical enforcement is implied by those isolated tests.
