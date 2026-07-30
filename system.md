# System design

continues-cli is a local process. It has no server, database, or background
daemon. The design keeps source-specific parsing separate from command
selection and process launch.

## System context

```mermaid
flowchart TB
    User[Developer] --> CLI[continues CLI]
    CLI --> ClaudeStore[Claude Code session store]
    CLI --> CodexStore[Codex session store]
    CLI --> ClaudeCLI[Claude Code CLI]
    CLI --> CodexCLI[Codex CLI]
    CLI --> Temp[Private temporary artifacts]
```

The user owns every boundary. The CLI only reads local agent stores, writes
handoff files for cross-agent transfers, and starts an installed target CLI.

## Components

```mermaid
flowchart LR
    Entry[continues.mjs<br/>orchestration] --> Args[src/args.mjs<br/>validation]
    Entry --> Terminal[src/terminal.mjs<br/>selection]
    Entry --> Sessions[src/sessions.mjs<br/>discovery and parsing]
    Entry --> Handoff[src/handoff.mjs<br/>state extraction]
    Entry --> Launch[src/launch.mjs<br/>command construction]
    Sessions --> Stores[(Claude and Codex JSONL)]
    Handoff --> Stores
    Handoff --> Files[(Private handoff files)]
    Launch --> Agents[Claude or Codex process]
```

`continues.mjs` owns the workflow but not implementation details. Argument
validation returns explicit command shapes. Session parsing converts each
source format into a common conversation shape. Launch code is the only module
that knows native CLI syntax.

## Same-agent resume

```mermaid
sequenceDiagram
    actor User
    participant CLI as continues
    participant Store as Session store
    participant Agent as Source agent CLI

    User->>CLI: resume [session-id]
    CLI->>Store: resolve or list recent sessions
    Store-->>CLI: selected session and working directory
    CLI->>Agent: native resume command
    Agent-->>User: attached interactive session
```

No handoff is generated. Delegating to native resume preserves the agent's own
session semantics and avoids maintaining a second resume protocol.

## Cross-agent transfer

```mermaid
sequenceDiagram
    actor User
    participant CLI as continues
    participant Store as Source JSONL
    participant Handoff as Handoff builder
    participant Disk as Private temp directory
    participant Target as Target agent CLI

    User->>CLI: resume ID --in other-agent
    CLI->>Store: read bounded recent rows
    Store-->>Handoff: normalized messages
    Handoff->>Handoff: extract state and render context
    Handoff->>Disk: persist state, transcript, and markdown
    CLI->>Target: start with bounded handoff prompt
    Target-->>User: new interactive session
```

The transfer is intentionally a new target session. Session identifiers are
private to their source agent and are not interchangeable.

## Data and privacy

Discovery scans:

- `~/.claude/projects/**/*.jsonl`
- `~/.codex/sessions/**/*.jsonl`

Metadata reads stop after enough head rows are available. Conversation reads
retain only a bounded tail. Cross-agent artifacts are stored under
`$TMPDIR/continues-handoffs` with restrictive Unix permissions.

The CLI does not redact conversation content because reliable generic
redaction would create false confidence. Transfer is an explicit user action,
and the README describes where content is sent and stored.

## Failure behavior

Invalid arguments fail before filesystem access. Missing or ambiguous sessions
produce explicit errors. A source and target process with a non-zero exit code
causes the CLI to fail rather than report success.

Malformed JSONL rows are skipped so one partial write does not hide all other
sessions. A missing session root behaves as an empty source, which supports
machines with only one agent installed.

## Design decisions

- Use native resume commands for same-agent work.
- Parse JSONL as streams instead of loading complete histories.
- Keep source adapters local until a third format proves a reusable interface
  is necessary.
- Bound handoff context and persist complete artifacts separately.
- Avoid a daemon, network protocol, or database because the workflow is a
  single local command.

## Verification boundary

Automated tests protect parsing options and native command construction. A
functional smoke check lists a real local session and inspects the exact dry-run
launch. Live cross-agent behavior still depends on installed third-party CLIs
and their session formats.
