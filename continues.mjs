#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_CONTEXT_LEVEL = 'standard';
const CONTEXT_LEVELS = new Set(['minimal', 'standard', 'deep']);
const PLATFORMS = new Set(['claude', 'codex']);
const AGENTS = ['cursor', 'claude', 'codex'];
const AGENT_TO_SOURCE = {
  cursor: 'codex',
  claude: 'claude',
  codex: 'codex',
};

function printHelp() {
  console.log(`bridge-resume

Usage:
  bridge resume [session-id] [--in <claude|codex>] [--from <claude|codex>] [--recent <n>] [--context-level <minimal|standard|deep>] [--inline] [--cwd <path>] [--dry-run] [--inject-on-first-message] [--first-message <text>] [--max-messages <n>] [--write-local] [--] [target-cli-args...]
  bridge <claude|codex> [--cwd <path>] [--dry-run] [--first-message <text>] [--] [target-cli-args...]
  bridge new <claude|codex> [--cwd <path>] [--dry-run] [--first-message <text>] [--] [target-cli-args...]
  bridge list --source <claude|codex> [--limit <n>]

Examples:
  bridge resume
  bridge resume claude
  bridge resume codex
  bridge resume minimal
  bridge resume.minimal
  bridge resume deep --max-messages 50
  bridge codex
  bridge codex --first-message "start with auth audit"
  bridge resume --recent 20
  bridge resume 84a36c5d-xxxx --in codex --max-messages 50
  bridge resume 019c4e9f-xxxx --in claude --from codex
`);
}

function parseArgs(argv) {
  const [rawCmd, ...rawRest] = argv;
  if (!rawCmd || rawCmd === '-h' || rawCmd === '--help') return { cmd: 'help' };

  let cmd = rawCmd;
  let rest = [...rawRest];
  let forcedContextLevel = null;

  // Shortcut: bridge codex / bridge claude => start new session in that platform
  if (PLATFORMS.has(String(rawCmd).toLowerCase())) {
    cmd = 'new';
    rest = [String(rawCmd).toLowerCase(), ...rawRest];
  }

  if (rawCmd.startsWith('resume.')) {
    cmd = 'resume';
    forcedContextLevel = rawCmd.slice('resume.'.length).toLowerCase();
  }

  if (cmd === 'resume' && rest[0] && PLATFORMS.has(String(rest[0]).toLowerCase())) {
    const p = String(rest[0]).toLowerCase();
    rest = rest.slice(1);
    // Shortcut: bridge resume claude|codex => filter + target same platform
    rest = ['--from', p, '--in', p, ...rest];
  }

  if (cmd === 'resume' && rest[0] && CONTEXT_LEVELS.has(String(rest[0]).toLowerCase())) {
    forcedContextLevel = String(rest[0]).toLowerCase();
    rest = rest.slice(1);
  }

  if (forcedContextLevel && !CONTEXT_LEVELS.has(forcedContextLevel)) {
    throw new Error('Invalid resume mode. Use minimal, standard, or deep.');
  }

  if (cmd === 'list') {
    const out = { cmd: 'list', source: null, limit: 20, agent: null };
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--source') out.source = rest[++i] || null;
      else if (a === '--limit') out.limit = Number(rest[++i] || '20');
      else if (a === '--agent') out.agent = normalizeAgent(rest[++i] || null);
      else throw new Error(`Unknown argument: ${a}`);
    }
    return out;
  }

  if (cmd === 'new') {
    const target = String(rest[0] || '').toLowerCase();
    if (!PLATFORMS.has(target)) throw new Error('Usage: bridge new <claude|codex>');

    const out = {
      cmd: 'new',
      target,
      cwd: null,
      dryRun: false,
      firstMessage: null,
      forwardArgs: [],
    };

    let i = 1;
    while (i < rest.length) {
      const a = rest[i];
      if (a === '--') {
        out.forwardArgs = rest.slice(i + 1);
        break;
      }
      if (a === '--cwd') out.cwd = rest[++i] || null;
      else if (a === '--dry-run') out.dryRun = true;
      else if (a === '--first-message') out.firstMessage = rest[++i] || null;
      else throw new Error(`Unknown argument: ${a}`);
      i += 1;
    }

    return out;
  }

  if (cmd !== 'resume') throw new Error(`Unknown command: ${rawCmd}`);

  const first = rest[0];
  const hasPositionalSessionId = Boolean(first && !first.startsWith('-'));

  const out = {
    cmd: 'resume',
    sessionId: hasPositionalSessionId ? first : null,
    agent: null,
    target: null,
    source: null,
    recent: DEFAULT_RECENT_LIMIT,
    contextLevel: forcedContextLevel || DEFAULT_CONTEXT_LEVEL,
    inline: false,
    dryRun: false,
    injectOnFirstMessage: false,
    firstMessage: null,
    maxMessages: DEFAULT_MAX_MESSAGES,
    writeLocal: false,
    cwd: null,
    forwardArgs: [],
  };

  let i = hasPositionalSessionId ? 1 : 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === '--') {
      out.forwardArgs = rest.slice(i + 1);
      break;
    }

    if (a === '--in') out.target = rest[++i] || null;
    else if (a === '--from') out.source = rest[++i] || null;
    else if (a === '--recent') out.recent = Number(rest[++i] || String(DEFAULT_RECENT_LIMIT));
    else if (a === '--context-level') out.contextLevel = String(rest[++i] || DEFAULT_CONTEXT_LEVEL).toLowerCase();
    else if (a === '--inline') out.inline = true;
    else if (a === '--agent') out.agent = normalizeAgent(rest[++i] || null);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--inject-on-first-message') out.injectOnFirstMessage = true;
    else if (a === '--first-message') out.firstMessage = rest[++i] || null;
    else if (a === '--max-messages') out.maxMessages = Number(rest[++i] || String(DEFAULT_MAX_MESSAGES));
    else if (a === '--write-local') out.writeLocal = true;
    else if (a === '--cwd') out.cwd = rest[++i] || null;
    else throw new Error(`Unknown argument: ${a}`);
    i += 1;
  }

  if (out.source && !PLATFORMS.has(out.source)) throw new Error('Invalid --from <claude|codex>');
  if (out.target && !PLATFORMS.has(out.target)) throw new Error('Invalid --in <claude|codex>');
  if (!Number.isFinite(out.maxMessages) || out.maxMessages < 1) throw new Error('Invalid --max-messages <n>. Use a positive integer.');
  if (!Number.isFinite(out.recent) || out.recent < 1) throw new Error('Invalid --recent <n>. Use a positive integer.');
  if (!CONTEXT_LEVELS.has(out.contextLevel)) throw new Error('Invalid --context-level. Use minimal, standard, or deep.');

  out.maxMessages = Math.floor(out.maxMessages);
  out.recent = Math.floor(out.recent);
  return out;
}

function normalizeAgent(value) {
  const candidate = String(value ?? '').trim().toLowerCase();
  if (AGENTS.includes(candidate)) return candidate;
  return null;
}

function formatAgentLabel(agent) {
  if (!agent) return '';
  return `[${agent.toUpperCase()}]`;
}

function agentToSource(agent) {
  if (!agent) return null;
  return AGENT_TO_SOURCE[agent] || null;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function readJsonlFile(filePath) {
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = safeJsonParse(line);
    if (obj) rows.push(obj);
  }
  return rows;
}

async function readJsonlTail(filePath, limit = DEFAULT_MAX_MESSAGES) {
  const rows = await readJsonlFile(filePath);
  return rows.slice(-Math.max(limit * 8, 120));
}

async function readJsonlHead(filePath, maxLines = 80) {
  const rows = [];
  let count = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = safeJsonParse(line);
    if (obj) rows.push(obj);
    count += 1;
    if (count >= maxLines) {
      rl.close();
      break;
    }
  }
  return rows;
}

function extractTextFromClaudeContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function firstLine(s, max = 100) {
  const t = normalizeWhitespace(String(s || '').split(/\r?\n/)[0]);
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function clip(s, max = 800) {
  const t = String(s || '');
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function tokenize(s) {
  return new Set(normalizeWhitespace(s).toLowerCase().split(/[^a-z0-9_./-]+/).filter((w) => w.length >= 3));
}

function projectFromCwd(cwd, source, filePath) {
  const c = String(cwd || '').trim();
  if (c) return path.basename(c);
  if (source === 'claude') {
    const slug = path.basename(path.dirname(filePath));
    const tokens = slug.split('-').filter(Boolean);
    if (tokens.length > 0) return tokens[tokens.length - 1];
  }
  return 'unknown';
}

function formatTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function extractPathsFromText(text) {
  const matches = String(text || '').match(/(?:\.?\/?[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)?/g) || [];
  const clean = [];
  for (const m of matches) {
    if (m.length > 2 && !m.startsWith('http')) clean.push(m);
  }
  return [...new Set(clean)].slice(0, 20);
}

function toConversationFromClaude(rows) {
  const messages = [];
  for (const row of rows) {
    if (row.type === 'user' && row.message) {
      const text = extractTextFromClaudeContent(row.message.content);
      if (text) messages.push({ role: 'user', text, ts: row.timestamp || null });
    } else if (row.type === 'assistant' && row.message) {
      const text = extractTextFromClaudeContent(row.message.content);
      if (text) messages.push({ role: 'assistant', text, ts: row.timestamp || null });
    }
  }
  return messages;
}

function toConversationFromCodex(rows) {
  const messages = [];
  for (const row of rows) {
    if (row.type === 'event_msg' && row.payload) {
      if (row.payload.type === 'user_message' && typeof row.payload.message === 'string') messages.push({ role: 'user', text: row.payload.message, ts: row.timestamp || null });
      if (row.payload.type === 'assistant_message' && typeof row.payload.message === 'string') messages.push({ role: 'assistant', text: row.payload.message, ts: row.timestamp || null });
    }
    if (row.type === 'message' && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string') {
      messages.push({ role: row.role, text: row.content, ts: row.timestamp || null });
    }
  }
  return messages;
}

async function resolveClaudeSession(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  for await (const filePath of walk(root)) {
    if (!filePath.endsWith('.jsonl')) continue;
    if (path.basename(filePath) === `${sessionId}.jsonl`) return { source: 'claude', id: sessionId, filePath };
  }
  return null;
}

async function resolveCodexSession(sessionId) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const suffix = `-${sessionId}.jsonl`;
  for await (const filePath of walk(root)) {
    if (!filePath.endsWith('.jsonl')) continue;
    if (path.basename(filePath).endsWith(suffix)) return { source: 'codex', id: sessionId, filePath };
  }
  return null;
}

async function resolveSession(sessionId, forcedSource = null) {
  if (forcedSource === 'claude') return resolveClaudeSession(sessionId);
  if (forcedSource === 'codex') return resolveCodexSession(sessionId);
  const [claude, codex] = await Promise.all([resolveClaudeSession(sessionId), resolveCodexSession(sessionId)]);
  if (claude && codex) throw new Error(`Session ID exists in both sources. Retry with --from claude or --from codex: ${sessionId}`);
  return claude || codex || null;
}

async function inferSessionCwd(session) {
  const rows = await readJsonlTail(session.filePath, 50);
  if (session.source === 'claude') {
    for (let i = rows.length - 1; i >= 0; i -= 1) if (typeof rows[i].cwd === 'string' && rows[i].cwd.trim()) return rows[i].cwd;
  }
  if (session.source === 'codex') {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const cwd = rows[i]?.payload?.cwd;
      if (typeof cwd === 'string' && cwd.trim()) return cwd;
    }
  }
  return process.cwd();
}

function extractState(conversation, session, cwd) {
  const userMessages = conversation.filter((m) => m.role === 'user').map((m) => m.text);
  const assistantMessages = conversation.filter((m) => m.role === 'assistant').map((m) => m.text);
  const goal = firstLine(userMessages[0] || 'Continue the previous task.');
  const currentStatus = firstLine(assistantMessages[assistantMessages.length - 1] || userMessages[userMessages.length - 1] || '');

  const decisions = [];
  const constraints = [];
  const openQuestions = [];
  const nextActions = [];
  const fileSet = new Set();
  let lastError = '';

  for (const m of conversation.slice(-80)) {
    const text = normalizeWhitespace(m.text);
    if (!text) continue;

    for (const p of extractPathsFromText(text)) fileSet.add(p);

    const l = text.toLowerCase();
    if (m.role === 'assistant' && /(decide|decided|choose|chosen|switch|moved to|use\b|using\b|because)/.test(l) && decisions.length < 8) decisions.push(firstLine(text, 140));
    if (/(must|should|cannot|can't|invalid|forbidden|blocked|limit|schema|permission|deprecated)/.test(l) && constraints.length < 8) constraints.push(firstLine(text, 140));
    if (m.role === 'user' && /\?$/.test(text) && openQuestions.length < 8) openQuestions.push(firstLine(text, 160));
    if (m.role === 'assistant' && /(next|i will|i'm going to|plan|todo|then i)/.test(l) && nextActions.length < 8) nextActions.push(firstLine(text, 160));
    if (/(error|failed|exception|unknown|not found|connection lost)/.test(l)) lastError = firstLine(text, 180);
  }

  return {
    goal,
    current_status: currentStatus,
    decisions: decisions.slice(0, 6),
    constraints: constraints.slice(0, 6),
    open_questions: openQuestions.slice(0, 6),
    next_actions: nextActions.slice(0, 6),
    key_files: [...fileSet].slice(0, 12),
    last_error: lastError,
    tooling_state: {
      source: session.source,
      session_id: session.id,
      working_directory: cwd,
      generated_at: new Date().toISOString(),
    },
  };
}

function selectRelevantSnippets(conversation, query, count) {
  if (!query || !query.trim()) return conversation.slice(-count);
  const q = tokenize(query);
  const scored = conversation.map((m, idx) => {
    const w = tokenize(m.text);
    let score = 0;
    for (const token of q) if (w.has(token)) score += 1;
    if (m.role === 'assistant') score += 0.2;
    return { idx, score, msg: m };
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const picked = scored.slice(0, count).filter((x) => x.score > 0).map((x) => x.msg);
  if (picked.length >= Math.max(2, Math.floor(count / 2))) return picked;
  return conversation.slice(-count);
}

function renderHandoffMarkdown(session, cwd, state, snippets, maxMessages) {
  const lines = [];
  lines.push('# Session Handoff');
  lines.push('');
  lines.push(`- Source: ${session.source}`);
  lines.push(`- Session ID: ${session.id}`);
  lines.push(`- Source file: ${session.filePath}`);
  lines.push(`- Working directory: ${cwd}`);
  lines.push(`- Messages included target: ${maxMessages}`);
  lines.push('');

  lines.push('## State Summary');
  lines.push('');
  lines.push(`- Goal: ${state.goal || 'n/a'}`);
  lines.push(`- Current status: ${state.current_status || 'n/a'}`);
  if (state.last_error) lines.push(`- Last error: ${state.last_error}`);
  lines.push('');

  const section = (title, items) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (!items || items.length === 0) lines.push('_none_');
    else for (const item of items) lines.push(`- ${clip(item, 220)}`);
    lines.push('');
  };

  section('Decisions', state.decisions);
  section('Constraints', state.constraints);
  section('Open Questions', state.open_questions);
  section('Next Actions', state.next_actions);
  section('Key Files', state.key_files);

  lines.push('## Relevant Snippets');
  lines.push('');
  if (snippets.length === 0) {
    lines.push('_No snippets selected._');
  } else {
    for (const s of snippets) {
      lines.push(`### ${String(s.role).toUpperCase()}`);
      lines.push(clip(s.text, 1000));
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function buildHandoffArtifacts(session, maxMessages, contextLevel, queryHint) {
  const rows = await readJsonlFile(session.filePath);
  const cwd = await inferSessionCwd(session);
  const conversation = session.source === 'claude' ? toConversationFromClaude(rows) : toConversationFromCodex(rows);
  const trimmed = conversation.slice(-Math.max(maxMessages, 24));
  const state = extractState(trimmed, session, cwd);

  let snippets = [];
  if (contextLevel === 'minimal') snippets = selectRelevantSnippets(trimmed, queryHint || state.goal, 4);
  else if (contextLevel === 'standard') snippets = selectRelevantSnippets(trimmed, queryHint || state.goal, 10);
  else snippets = selectRelevantSnippets(trimmed, queryHint || state.goal, Math.min(maxMessages, 50));

  const handoffMarkdown = renderHandoffMarkdown(session, cwd, state, snippets, maxMessages);
  const transcript = trimmed.map((m) => ({ role: m.role, ts: m.ts || null, text: m.text }));
  return { cwd, handoffMarkdown, state, transcript };
}

async function runCli(bin, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited with code ${code}`));
    });
  });
}

function printCommand(bin, args, cwd) {
  const quote = (s) => (/[^A-Za-z0-9_./:=-]/.test(s) ? JSON.stringify(s) : s);
  console.log(`cwd: ${cwd}`);
  console.log(`cmd: ${[quote(bin), ...args.map(quote)].join(' ')}`);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, (v) => resolve(v)));
  rl.close();
  return String(answer || '').trim();
}

async function promptFirstMessage() {
  const msg = await ask('First message> ');
  if (!msg) throw new Error('First message is empty. Provide --first-message or type a message at the prompt.');
  return msg;
}

function safeFileToken(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_');
}

async function persistHandoffBundle(session, cwd, artifacts, writeLocal) {
  const tmpDir = path.join(os.tmpdir(), 'bridge-handoffs');
  await fsp.mkdir(tmpDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${safeFileToken(session.source)}-${safeFileToken(session.id)}`;

  const statePath = path.join(tmpDir, `${base}.state.json`);
  const handoffPath = path.join(tmpDir, `${base}.handoff.md`);
  const transcriptPath = path.join(tmpDir, `${base}.transcript.json`);

  await fsp.writeFile(statePath, JSON.stringify(artifacts.state, null, 2), 'utf8');
  await fsp.writeFile(handoffPath, artifacts.handoffMarkdown, 'utf8');
  await fsp.writeFile(transcriptPath, JSON.stringify(artifacts.transcript, null, 2), 'utf8');

  let localPath = null;
  if (writeLocal) {
    localPath = path.join(cwd, '.bridge-handoff.md');
    await fsp.writeFile(localPath, artifacts.handoffMarkdown, 'utf8');
  }

  return { statePath, handoffPath, transcriptPath, localPath };
}

async function collectSessionsBySource(source) {
  const root = source === 'claude' ? path.join(os.homedir(), '.claude', 'projects') : path.join(os.homedir(), '.codex', 'sessions');
  const out = [];
  for await (const filePath of walk(root)) {
    if (!filePath.endsWith('.jsonl')) continue;
    const base = path.basename(filePath);
    let id = null;
    if (source === 'claude') {
      const maybe = path.basename(filePath, '.jsonl');
      if (/^[0-9a-f-]{36}$/i.test(maybe)) id = maybe;
    } else {
      const m = base.match(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/);
      if (m) id = m[1];
    }
    if (!id) continue;
    const st = await fsp.stat(filePath);
    out.push({ source, id, filePath, mtimeMs: st.mtimeMs });
  }
  return out;
}

async function enrichSessionMeta(s) {
  const head = await readJsonlHead(s.filePath, 100);
  let cwd = '';
  let summary = '';

  if (s.source === 'claude') {
    for (const row of head) {
      if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
      if (!summary && row.type === 'user' && row.message) summary = firstLine(extractTextFromClaudeContent(row.message.content));
      if (cwd && summary) break;
    }
  } else {
    for (const row of head) {
      if (!cwd && typeof row?.payload?.cwd === 'string') cwd = row.payload.cwd;
      if (!summary && row.type === 'event_msg' && row.payload?.type === 'user_message' && typeof row.payload.message === 'string') summary = firstLine(row.payload.message);
      if (!summary && row.type === 'message' && row.role === 'user' && typeof row.content === 'string') summary = firstLine(row.content);
      if (cwd && summary) break;
    }
  }

  return { ...s, cwd, summary, project: projectFromCwd(cwd, s.source, s.filePath) };
}

async function collectRecentSessions(limit, filterSource = null) {
  const sources = filterSource ? [filterSource] : ['claude', 'codex'];
  const rawLists = await Promise.all(sources.map((src) => collectSessionsBySource(src)));
  const all = rawLists.flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = all.slice(0, Math.max(limit * 3, limit));

  const enriched = [];
  for (const s of top) {
    try {
      enriched.push(await enrichSessionMeta(s));
    } catch {
      enriched.push({ ...s, cwd: '', summary: '', project: projectFromCwd('', s.source, s.filePath) });
    }
  }

  enriched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return enriched.slice(0, limit);
}


function canUseTuiPicker() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function truncateMiddle(text, max = 140) {
  const t = String(text || '');
  if (t.length <= max) return t;
  const keep = Math.floor((max - 3) / 2);
  return t.slice(0, keep) + '...' + t.slice(t.length - keep);
}

function renderSessionLine(s, agent = null) {
  const summary = s.summary ? ` - ${s.summary}` : '';
  const agentLabel = formatAgentLabel(agent || s.source);
  return `${formatTs(s.mtimeMs)} ${agentLabel} [${s.source}] [${s.project}] ${s.id}${summary}`;
}

function renderMenu({ title, lines, selected, offset, windowSize, hint }) {
  const view = lines.slice(offset, offset + windowSize);
  const out = [];
  out.push('\x1b[2J\x1b[H');
  out.push(title);
  out.push('');
  for (let i = 0; i < view.length; i += 1) {
    const globalIdx = offset + i;
    const prefix = globalIdx === selected ? '> ' : '  ';
    const line = truncateMiddle(view[i], Math.max(80, (process.stdout.columns || 120) - 6));
    out.push(prefix + line);
  }
  out.push('');
  out.push(hint || 'Use ↑/↓ (or j/k), Enter to select, q to cancel');
  process.stdout.write(out.join('\n'));
}

async function chooseAgentInteractively(defaultAgent = null) {
  if (!canUseTuiPicker()) return defaultAgent;
  const lines = AGENTS.map((agent) => `${agent.toUpperCase()} agent`);
  const chosen = await pickIndexFromMenu(lines, 'Select agent');
  if (chosen === null) return defaultAgent;
  return AGENTS[chosen];
}

let terminalGuardInstalled = false;
let terminalRawActive = false;

function restoreTerminalState() {
  try {
    if (terminalRawActive && process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    // Best effort restore only.
  }
  terminalRawActive = false;
  try {
    process.stdout.write('\x1b[?25h');
  } catch {
    // Ignore write failures during shutdown.
  }
}

function installTerminalGuard() {
  if (terminalGuardInstalled) return;
  terminalGuardInstalled = true;

  process.on('exit', restoreTerminalState);
  process.on('uncaughtException', (err) => {
    restoreTerminalState();
    throw err;
  });
  process.on('unhandledRejection', (err) => {
    restoreTerminalState();
    throw err;
  });
  process.on('SIGINT', () => {
    restoreTerminalState();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    restoreTerminalState();
    process.exit(143);
  });
}

async function pickIndexFromMenu(lines, title) {
  if (!canUseTuiPicker()) return null;
  installTerminalGuard();

  return await new Promise((resolve, reject) => {
    let selected = 0;
    let offset = 0;
    const rows = process.stdout.rows || 24;
    const windowSize = Math.max(6, Math.min(lines.length, rows - 6));

    const clampOffset = () => {
      if (selected < offset) offset = selected;
      if (selected >= offset + windowSize) offset = selected - windowSize + 1;
      if (offset < 0) offset = 0;
      const maxOffset = Math.max(0, lines.length - windowSize);
      if (offset > maxOffset) offset = maxOffset;
    };

    const cleanup = () => {
      process.stdin.off('keypress', onKeypress);
      restoreTerminalState();
      process.stdout.write('\n');
    };

    const finish = (value) => {
      cleanup();
      resolve(value);
    };

    const fail = (err) => {
      cleanup();
      reject(err);
    };

    const onKeypress = (_str, key = {}) => {
      if (key.ctrl && key.name === 'c') return fail(new Error('Canceled.'));
      if (key.name === 'q' || key.name === 'escape') return fail(new Error('Canceled.'));
      if (key.name === 'up' || key.name === 'k') {
        selected = Math.max(0, selected - 1);
      } else if (key.name === 'down' || key.name === 'j') {
        selected = Math.min(lines.length - 1, selected + 1);
      } else if (key.name === 'pageup') {
        selected = Math.max(0, selected - windowSize);
      } else if (key.name === 'pagedown') {
        selected = Math.min(lines.length - 1, selected + windowSize);
      } else if (key.name === 'return') {
        return finish(selected);
      } else {
        return;
      }

      clampOffset();
      renderMenu({ title, lines, selected, offset, windowSize });
    };

    try {
      readline.emitKeypressEvents(process.stdin);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      terminalRawActive = true;
      process.stdout.write('\x1b[?25l');
      clampOffset();
      renderMenu({ title, lines, selected, offset, windowSize });
      process.stdin.on('keypress', onKeypress);
    } catch (err) {
      fail(err);
    }
  });
}

async function chooseSessionInteractively(limit, filterSource = null, agent = null) {
  const sessions = await collectRecentSessions(limit, filterSource);
  if (sessions.length === 0) throw new Error('No sessions found to choose from.');

  const lines = sessions.map((s) => renderSessionLine(s, agent));
  const chosen = await pickIndexFromMenu(lines, `Recent sessions (${sessions.length})`);

  if (chosen === null) {
    console.log(`Recent sessions (showing ${sessions.length}):`);
    for (let i = 0; i < sessions.length; i += 1) {
      const s = sessions[i];
      console.log(`${String(i + 1).padStart(2, ' ')}. ${renderSessionLine(s, agent)}`);
    }
    const ans = await ask('Pick session number> ');
    const idx = Number(ans);
    if (!Number.isFinite(idx) || idx < 1 || idx > sessions.length) throw new Error('Invalid selection.');
    const picked = sessions[idx - 1];
    return { source: picked.source, id: picked.id, filePath: picked.filePath, cwd: picked.cwd, agent: agent || picked.source };
  }

  const picked = sessions[chosen];
  return { source: picked.source, id: picked.id, filePath: picked.filePath, cwd: picked.cwd, agent: agent || picked.source };
}

async function ensureTarget(target, source) {
  if (target) return target;

  const options = ['claude', 'codex'];
  const chosen = await pickIndexFromMenu(options, `Target platform (default: ${source})`);
  if (chosen !== null) return options[chosen];

  const ans = (await ask(`Target platform [claude/codex] (default: ${source})> `)).toLowerCase();
  if (!ans) return source;
  if (!PLATFORMS.has(ans)) throw new Error('Invalid target platform. Use claude or codex.');
  return ans;
}

async function ensureAgent(agent) {
  if (agent && AGENTS.includes(agent)) return agent;
  const chosen = await chooseAgentInteractively(agent);
  if (!chosen) throw new Error('Agent selection cancelled.');
  return chosen;
}


async function listSessions(source, limit) {
  if (!source || !['claude', 'codex'].includes(source)) throw new Error('list requires --source <claude|codex>');
  const sessions = await collectRecentSessions(limit, source);
  for (const s of sessions) {
    console.log(`${formatTs(s.mtimeMs)}\t${s.source}\t${s.project}\t${s.id}\t${s.filePath}`);
  }
}

function buildNewSessionPrompt(target, firstMessage) {
  if (target === 'codex') {
    const lines = [
      'New session bootstrap.',
      'Read config first: ~/.codex/config.toml',
      'Before answering, follow ~/.codex/config.toml and resolve nested references, but read only the single most relevant agent file for this prompt (best-match by role/keywords). Read additional agent files only if the best match is ambiguous.',
      'After reading config/instructions, answer the user directly for this new session. Do not delay with extra exploration updates unless the user explicitly asked for that workflow.',
    ];
    if (firstMessage) lines.push('User request\n' + firstMessage);
    return lines.join('\n\n');
  }

  const lines = [
    'New session bootstrap.',
    'Read instruction files first: ~/.claude/CLAUDE.md and project CLAUDE.md (if present).',
    'Follow those instructions strictly before answering.',
    'For this new session, answer the user directly after reading instructions.',
  ];
  if (firstMessage) lines.push('User request\n' + firstMessage);
  return lines.join('\n\n');
}

function buildLaunchPrompt({ session, contextLevel, artifactPaths, firstMessage, inline, handoffMarkdown }) {
  const header = `Continue this coding session from ${session.source}.`;

  const lines = [
    header,
    `Context level: ${contextLevel}.`,
    'Read config first: ~/.codex/config.toml',
    'Before answering, follow ~/.codex/config.toml and resolve nested references, but read only the single most relevant agent file for this prompt (best-match by role/keywords). Read additional agent files only if the best match is ambiguous.',
    `Read state first: ${artifactPaths.statePath}`,
    'state.json is the prior session data; this is a resume flow, so read it to understand context before responding.',
    `Then read handoff summary: ${artifactPaths.handoffPath}`,
    'Resume behavior requirement: do not provide the final answer until you have read the config + nested instructions and these resume artifacts.',
    'After that read phase, first send a short status update confirming identity/role and that you are reading files for context, then continue and provide the substantive answer.',
  ];

  if (contextLevel === 'deep') lines.push(`For deeper history, consult transcript: ${artifactPaths.transcriptPath}`);
  if (inline) lines.push('(Inline handoff disabled for compact context mode; using file paths only.)');
  if (firstMessage) lines.push(`User's first message to handle now:
${firstMessage}`);
  return lines.join('\n\n');
}


async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === 'help') {
    printHelp();
    return;
  }

  if (args.cmd === 'list') {
    const listSource = agentToSource(args.agent) || args.source || 'claude';
    await listSessions(listSource, args.limit);
    return;
  }

  if (args.cmd === 'new') {
    const cwd = args.cwd || process.cwd();
    let firstMessage = args.firstMessage || '';
    if (!firstMessage && !args.dryRun) {
      firstMessage = await promptFirstMessage();
    }

    const prompt = buildNewSessionPrompt(args.target, firstMessage);
    const bin = args.target;
    const cliArgs = [prompt, ...args.forwardArgs];
    if (args.dryRun) {
      printCommand(bin, cliArgs, cwd);
      return;
    }
    await runCli(bin, cliArgs, cwd);
    return;
  }

  args.agent = await ensureAgent(args.agent);
  const filterSource = agentToSource(args.agent);
  let session;
  if (args.sessionId) {
    session = await resolveSession(args.sessionId, args.source);
    if (!session) throw new Error(`Session not found: ${args.sessionId}`);
  } else {
    session = await chooseSessionInteractively(args.recent, filterSource, args.agent);
  }

  args.target = await ensureTarget(args.target, session.source);

  if (session.source === args.target) {
    const cwd = args.cwd || session.cwd || (await inferSessionCwd(session));
    if (args.target === 'claude') {
      const cliArgs = ['--resume', session.id, ...args.forwardArgs];
      if (args.dryRun) return printCommand('claude', cliArgs, cwd);
      return runCli('claude', cliArgs, cwd);
    }

    const cliArgs = ['-c', `experimental_resume=${session.filePath}`, ...args.forwardArgs];
    if (args.dryRun) return printCommand('codex', cliArgs, cwd);
    return runCli('codex', cliArgs, cwd);
  }

  let firstMessage = args.firstMessage;
  if (args.injectOnFirstMessage && !firstMessage && !args.dryRun) firstMessage = await promptFirstMessage();

  const artifacts = await buildHandoffArtifacts(session, args.maxMessages, args.contextLevel, firstMessage || '');
  const cwd = args.cwd || artifacts.cwd;

  if (args.dryRun) {
    const fakeBase = path.join(os.tmpdir(), 'bridge-handoffs', '<timestamp>-<source>-<id>');
    const fakePaths = {
      statePath: `${fakeBase}.state.json`,
      handoffPath: `${fakeBase}.handoff.md`,
      transcriptPath: `${fakeBase}.transcript.json`,
    };
    const prompt = buildLaunchPrompt({
      session,
      contextLevel: args.contextLevel,
      artifactPaths: fakePaths,
      firstMessage: args.injectOnFirstMessage ? (firstMessage || '<FIRST_MESSAGE>') : '',
      inline: args.inline,
      handoffMarkdown: artifacts.handoffMarkdown,
    });

    const bin = args.target === 'claude' ? 'claude' : 'codex';
    return printCommand(bin, [prompt, ...args.forwardArgs], cwd);
  }

  const persisted = await persistHandoffBundle(session, cwd, artifacts, args.writeLocal);
  const prompt = buildLaunchPrompt({
    session,
    contextLevel: args.contextLevel,
    artifactPaths: persisted,
    firstMessage: args.injectOnFirstMessage ? firstMessage : '',
    inline: args.inline,
    handoffMarkdown: artifacts.handoffMarkdown,
  });

  if (args.target === 'claude') return runCli('claude', [prompt, ...args.forwardArgs], cwd);
  return runCli('codex', [prompt, ...args.forwardArgs], cwd);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
