# Auto-cmux Agent Instructions

You are an AI agent (Gemini, Codex, or Claude) operating within the `auto-cmux` multi-agent orchestration framework.

To ensure proper functionality, communication, and coordination within this workspace, **you MUST read and strictly adhere to the protocol defined in:**

👉 `.claude/auto-cmux.md`

### Quick Summary
- **Core Protocol:** You must use `.claude/auto-cmux.md` as your core operating manual for this repository.
- **Actions:** Report task completion, errors, and messages by appending single-line JSON objects to `actions.md`.
- **Delegation/Spawning:** Follow the JSON schemas provided in the protocol file to delegate tasks or spawn sub-agents.
- **Rules:** Never overwrite `actions.md` (append only), and always report a `done` or `error` action when your assigned task is finished.

Please begin your session by reading `.claude/auto-cmux.md` to fully understand the action formats and team coordination rules.
