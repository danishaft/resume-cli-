# Continues CLI

`continues-cli` is the agent resume broker that lets you choose CURSOR,
CLAUDE, or CODEX, pick a recent session, and resume it without retyping the
context you already built.

## Status

- `active`

## Command name

- Primary: `node continues.mjs`
- Alias: `bridge resume` (legacy script we’re wrapping)

## When agents should use it

- After a rate-limit or crash, to pick up the last session quickly.
- When you want to resume across CLAUDE, CODEX, or CURSOR with context.
- When you need a short summary of a session before resuming.

## Safety and approval notes

- Only reads session logs; it does not modify files unless you pass `--write-local`.
- Cursor sessions reuse Codex files; the tool simply tags them with `CURSOR`.
- Use `--dry-run` for rehearsals before launching a CLI.

## Requirements on this PC

- `claude` and `codex` CLIs are installed and authenticated.
- `.claude/projects` and `.codex/sessions` directories exist with JSONL logs.
- The tool runs in a TTY for nice menus but falls back to prompts otherwise.

## Quick test

1. `node continues.mjs list --agent claude`
2. `node continues.mjs` (pick an agent, then pick a session)
3. `node continues.mjs resume --agent cursor --session <id> --dry-run`

## Known limits

- Cursor sessions are actually Codex logs; the tool only tags them differently.
- The interactive menu relies on a TTY; if you run it remotely the script falls
  back to numbered prompts.
- Session lists show the most recent entries only; use `--recent` to adjust.
