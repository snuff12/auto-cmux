<p align="center">
  <h1 align="center">auto-cmux</h1>
  <p align="center">
    Multi-agent orchestration for AI coding CLIs
    <br />
    Run Claude Code and Codex agents in cmux workspaces. Define roles, coordinate via MCP, recover from common failures.
  </p>
</p>

<p align="center">
  <img src="./docs/assets/demo.gif" alt="auto-cmux demo" width="900" />
</p>

---

## What is auto-cmux?

auto-cmux orchestrates multiple AI coding agents (Claude Code and Codex) as a coordinated team. Agents can run in separate cmux workspaces or split panes, with defined roles, models, and communication channels, all managed through a single YAML config and an MCP server.

```
┌─────────────────────────────────────────────────────┐
│  auto-cmux (MCP Server)                             │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ planner  │─→│developer │─→│ reviewer │          │
│  │ (opus)   │  │ (sonnet) │  │ (haiku)  │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│      ws:plan      ws:dev       ws:review            │
└─────────────────────────────────────────────────────┘
         ▲ cmux socket (workspace management)
```

**Key features:**

- **Multi-agent parallelism** — agents work simultaneously in cmux workspaces or split panes
- **Role-based teams** — developers, reviewers, planners, researchers with different models
- **Two-CLI orchestration** — mix Claude Code and Codex in one team
- **Self-healing reactions** — auto-retry on stalls, rate limits, crashes, low context
- **Task & workflow engine** — task dependencies, delegation, and review cycles
- **Rigs** — declarative team compositions, spin up with one command
- **Cost guardrails** — daily spend limits and warnings
- **Git worktree isolation** — each agent can work on a separate branch

## Quick Start

### Prerequisites

- [cmux](https://github.com/anthropics/cmux) installed and running
- At least one AI CLI: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [Codex](https://github.com/openai/codex)
- Node.js >= 18

### Install & Initialize

```bash
npm install
npm run build
npm link

cd your-project
auto-cmux init    # interactive setup wizard
```

The wizard generates `auto-cmux.yml` and scaffolds instruction files for Claude Code and Codex.

### Run

```bash
auto-cmux            # start the MCP server (stdio)
auto-cmux doctor     # validate environment & config
auto-cmux clean      # remove runtime artifacts
auto-cmux remove     # remove scaffolded files
```

## Configuration

All config lives in `auto-cmux.yml`:

```yaml
version: "0.1"
project:
  name: my-app
  clis: [claude, codex]

agents:
  assignment:
    mode: manual            # manual | auto | orchestrator
    stallTimeoutSec: 120
  roles:
    - id: developer
      cli: claude
      model: sonnet
      description: "Implements features and fixes bugs"
      skills: [commit, code-review]
      workspace: dev
    - id: reviewer
      cli: claude
      model: haiku
      description: "Code review and quality checks"
      skills: [code-review, security-review]
      workspace: review

reactions:
  - event: stall
    action: diagnose
    auto: true
    retries: 2
  - event: rate-limited
    action: resume
    auto: true
  - event: agent-crashed
    action: retry
    auto: true

git:
  worktreeEnabled: true
  branchPrefix: "agent/"

costs:
  dailyLimitCents: 2500
  warnAt: 0.8
```

<details>
<summary><strong>Roles reference</strong></summary>

| Field | Description |
|---|---|
| `id` | Unique identifier |
| `cli` | `claude` · `codex` |
| `model` | e.g. `opus`, `sonnet`, `haiku`, `gpt-5.5` |
| `description` | What this role does |
| `instructions` | Path to role-specific instruction markdown |
| `skills` | Skills the agent can use |
| `workspace` | Default workspace name |

</details>

<details>
<summary><strong>Reactions reference</strong></summary>

Events:

| Event | Trigger |
|---|---|
| `stall` | No output for `stallTimeoutSec` |
| `rate-limited` | API rate limit hit |
| `agent-crashed` | Process died unexpectedly |
| `hitl` | Needs human intervention |
| `low-context` | Context window running low |
| `ci-failed` | CI pipeline failed |

Actions: `retry` · `diagnose` · `alert` · `resume` · `compact` · `escalate` · `kill`

</details>

<details>
<summary><strong>Workflows</strong></summary>

Role-based workflows with optional review cycles:

```yaml
workflows:
  feature:
    steps:
      - role: developer
        review:
          role: reviewer
          max_iterations: 3
          retry_on: changes_requested
          pass_on: LGTM
```

</details>

<details>
<summary><strong>Rigs</strong></summary>

Declarative team compositions:

```yaml
rigs:
  dev-team:
    agents:
      - role: planner
      - role: developer
      - role: reviewer
    edges:
      - from: planner
        to: developer
      - from: developer
        to: reviewer
```

Spin up with `rig_up`, tear down with `rig_down`.

</details>

## MCP Tools

auto-cmux exposes 30+ tools via MCP:

<details>
<summary><strong>Agent Management</strong></summary>

| Tool | Description |
|---|---|
| `spawn_agent` | Create a new agent with a role and prompt |
| `kill_agent` | Terminate an agent |
| `list_agents` | List all active agents |
| `agent_status` | Get detailed agent status |
| `get_agent_output` | Read an agent's terminal output |
| `get_agent_tree` | View parent/child hierarchy |
| `get_agent_children` | List child agents |
| `wait_for_children` | Block until children complete |
| `wait_for_result` | Block until agent completes |
| `get_result` | Get completion result |

</details>

<details>
<summary><strong>Workspaces</strong></summary>

| Tool | Description |
|---|---|
| `create_workspace` | Create a cmux workspace |
| `close_workspace` | Close a workspace |
| `create_agent_workspace` | Create a managed workspace for agents |
| `spawn_in_workspace` | Spawn agent in existing workspace |
| `list_workspaces` | List all workspaces |
| `list_managed_workspaces` | List managed workspaces |
| `rename_workspace` | Rename a workspace |

</details>

<details>
<summary><strong>Communication</strong></summary>

| Tool | Description |
|---|---|
| `send_message` | Message a specific agent |
| `broadcast` | Message all agents |
| `read_messages` | Read actions and messages from agents |
| `read_surface` | Read terminal output from a cmux surface |

</details>

<details>
<summary><strong>Tasks</strong></summary>

| Tool | Description |
|---|---|
| `create_task` | Create a task |
| `delete_task` | Delete a task |
| `assign_task` | Assign task to an agent |
| `update_task` | Update task title, description, priority, or result |
| `complete_task` | Mark task as done |
| `list_tasks` | List all tasks |

</details>

<details>
<summary><strong>Team, Monitoring & Rigs</strong></summary>

| Tool | Description |
|---|---|
| `get_team_status` | Overview of all agents |
| `get_telemetry` | Token usage, costs, tool calls |
| `list_reactions` | View reaction alerts |
| `resolve_alert` | Resolve an alert |
| `rig_up` | Spin up a team rig |
| `rig_down` | Tear down a rig |
| `list_rigs` | List available rigs |
| `read_shared` | Read shared context from agent `share` actions |
| `save_memory` / `get_memory` | Store and retrieve learned role memories or conventions |

</details>

## Action Protocol

Agents coordinate by appending JSON lines to an `actions.md` file:

```jsonl
{"action":"done","summary":"Completed the feature implementation"}
{"action":"error","message":"Build failed: missing dependency"}
{"action":"message","to":"reviewer","content":"Ready for review"}
{"action":"spawn","name":"sub-task","cli":"claude","prompt":"Fix the tests"}
{"action":"delegate_to","role":"reviewer","task":"Review PR #42"}
{"action":"share","key":"findings","content":"...research results..."}
{"action":"status","text":"Running tests..."}
```

## Examples

The [`examples/`](./examples) directory contains starter configs:

| Example | Description |
|---|---|
| [parallel-research.yml](./examples/parallel-research.yml) | Multiple agents research concurrently, then synthesize |
| [code-review-team.yml](./examples/code-review-team.yml) | Developer + reviewer with automated review cycles |
| [bug-triage.yml](./examples/bug-triage.yml) | Analyzer, fixer, and verifier roles for bug-fix workflows |

## Supported CLIs

| CLI | Models |
|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | opus, sonnet, haiku |
| [Codex](https://github.com/openai/codex) | gpt-5.5 |

## Development

```bash
git clone <repo-url>
cd auto-cmux
npm install
npm run build
npm test
```

## Contributing

Contributions are welcome! Please open an issue to discuss your idea before submitting a PR.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Open a pull request

## License

MIT
