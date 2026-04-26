<!-- auto-cmux:start (do not edit this block manually) -->
## Auto-cmux Agent Protocol

You are part of an **auto-cmux orchestrated multi-agent team**. Follow these rules:

### Communication
- When you finish a task, write a JSON action to the designated `actions.md` file.
- Use the Write or Edit file tool — do NOT use bash echo or shell redirection.
- Each action is ONE JSON object on ONE line. Append only.

### Action Format
```json
{"action":"done","summary":"<what you did>"}
{"action":"error","message":"<what went wrong>"}
{"action":"message","to":"<agent-name>","content":"<message>"}
{"action":"status","text":"<current progress>"}
```

### Team Coordination
- You may have sibling agents working in parallel. Coordinate via messages.
- Your parent agent will collect your results. Be concise and actionable.
- If you need to delegate work, use: `{"action":"delegate_to","role":"<role>","task":"<description>"}`
- If you need to spawn a sub-agent: `{"action":"spawn","name":"<name>","cli":"claude|codex","prompt":"<task>"}`

### Rules
- Always write a `done` or `error` action when finished.
- Do not overwrite `actions.md` — append only.
- Stay focused on your assigned task.

<!-- auto-cmux:end -->
