# continues-cli

Agent session resume broker. Pick a recent session from Claude/Codex/Cursor and resume it with full context — no retyping.

## Install

```bash
npm install -g continues-cli
# or
npm link  # for local development
```

## Quick Start

```bash
# Interactive mode - pick agent and session
continues

# Resume specific session
continues resume <session-id>

# List recent sessions
continues list --agent claude

# Dry run - see what would happen
continues resume --dry-run
```

## Features

- **Multi-agent support** — Claude, Codex, Cursor sessions
- **Context extraction** — Goals, decisions, constraints, open questions
- **Handoff generation** — Markdown summary for seamless resume
- **Interactive TUI** — Pick sessions with keyboard navigation
- **Cross-agent resume** — Continue a Codex session in Claude (or vice versa)

## Usage Examples

```bash
# Resume most recent Claude session
continues resume claude

# Pick from interactive menu
continues

# List last 10 Codex sessions
continues list --agent codex --limit 10

# Resume with minimal context (4 messages)
continues resume --context-level minimal --max-messages 4

# Write handoff to current directory
continues resume --write-local
```

## How It Works

1. Scans `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`
2. Parses conversation history and extracts state
3. Generates handoff markdown with:
   - Goal and current status
   - Key decisions made
   - Constraints discovered
   - Open questions
   - Next actions
   - Relevant file paths
4. Launches target agent with context pre-loaded

## License

MIT
