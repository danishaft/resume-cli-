import fs, { type Dirent } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import type {
	ConversationMessage,
	Platform,
	Session,
	SessionCandidate,
	SessionReference,
} from "./types.js";

type SessionRow = {
	type?: unknown;
	role?: unknown;
	content?: unknown;
	cwd?: unknown;
	timestamp?: unknown;
	message?: {
		content?: unknown;
	};
	payload?: {
		type?: unknown;
		message?: unknown;
		cwd?: unknown;
	};
};

const SESSION_ROOTS: Record<Platform, string> = {
	claude: path.join(os.homedir(), ".claude", "projects"),
	codex: path.join(os.homedir(), ".codex", "sessions"),
};

async function* walk(directory: string): AsyncGenerator<string> {
	let entries: Dirent[];
	try {
		entries = await fsp.readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const filePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			yield* walk(filePath);
		} else {
			yield filePath;
		}
	}
}

function parseJson(line: string): SessionRow | null {
	try {
		const value: unknown = JSON.parse(line);
		return value !== null && typeof value === "object"
			? (value as SessionRow)
			: null;
	} catch {
		return null;
	}
}

async function readJsonl(
	filePath: string,
	maxRows: number,
	keepTail = false,
): Promise<SessionRow[]> {
	const rows: SessionRow[] = [];
	const input = fs.createReadStream(filePath, { encoding: "utf8" });
	const reader = readline.createInterface({ input, crlfDelay: Infinity });

	for await (const line of reader) {
		if (!line.trim()) {
			continue;
		}
		const row = parseJson(line);
		if (row) {
			rows.push(row);
			if (keepTail && rows.length > maxRows) {
				rows.shift();
			}
		}
		if (!keepTail && rows.length >= maxRows) {
			break;
		}
	}
	reader.close();
	return rows;
}

function extractClaudeText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block !== null &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function firstLine(value: unknown, maxLength = 100): string {
	const line = (String(value ?? "").split(/\r?\n/, 1)[0] ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line;
}

function timestampOf(row: SessionRow): string | null {
	return typeof row.timestamp === "string" ? row.timestamp : null;
}

function toConversation(
	source: Platform,
	rows: SessionRow[],
): ConversationMessage[] {
	const messages: ConversationMessage[] = [];
	for (const row of rows) {
		if (source === "claude" && row.message) {
			if (row.type !== "user" && row.type !== "assistant") {
				continue;
			}
			const text = extractClaudeText(row.message.content);
			if (text) {
				messages.push({
					role: row.type,
					text,
					timestamp: timestampOf(row),
				});
			}
			continue;
		}

		if (source === "codex" && row.type === "event_msg" && row.payload) {
			const role =
				row.payload.type === "user_message"
					? "user"
					: row.payload.type === "assistant_message"
						? "assistant"
						: null;
			if (role && typeof row.payload.message === "string") {
				messages.push({
					role,
					text: row.payload.message,
					timestamp: timestampOf(row),
				});
			}
		} else if (
			source === "codex" &&
			row.type === "message" &&
			(row.role === "user" || row.role === "assistant") &&
			typeof row.content === "string"
		) {
			messages.push({
				role: row.role,
				text: row.content,
				timestamp: timestampOf(row),
			});
		}
	}
	return messages;
}

function sessionIdFromPath(source: Platform, filePath: string): string | null {
	const baseName = path.basename(filePath, ".jsonl");
	if (source === "claude") {
		return /^[0-9a-f-]{36}$/i.test(baseName) ? baseName : null;
	}
	const match = baseName.match(
		/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/,
	);
	return match?.[1] ?? null;
}

async function collectSourceSessions(
	source: Platform,
): Promise<SessionCandidate[]> {
	const sessions: SessionCandidate[] = [];
	for await (const filePath of walk(SESSION_ROOTS[source])) {
		if (!filePath.endsWith(".jsonl")) {
			continue;
		}
		const id = sessionIdFromPath(source, filePath);
		if (!id) {
			continue;
		}
		const stats = await fsp.stat(filePath);
		sessions.push({ source, id, filePath, modifiedAt: stats.mtimeMs });
	}
	return sessions;
}

async function readSessionMetadata(
	session: SessionCandidate,
): Promise<Session> {
	const rows = await readJsonl(session.filePath, 100);
	let cwd = "";
	let summary = "";

	for (const row of rows) {
		if (session.source === "claude") {
			if (!cwd && typeof row.cwd === "string") {
				cwd = row.cwd;
			}
			if (!summary && row.type === "user" && row.message) {
				summary = firstLine(extractClaudeText(row.message.content));
			}
		} else {
			if (!cwd && typeof row.payload?.cwd === "string") {
				cwd = row.payload.cwd;
			}
			if (
				!summary &&
				row.type === "event_msg" &&
				row.payload?.type === "user_message"
			) {
				summary = firstLine(row.payload.message);
			}
		}
		if (cwd && summary) {
			break;
		}
	}

	return {
		...session,
		cwd,
		project: cwd ? path.basename(cwd) : "unknown",
		summary,
	};
}

/**
 * Returns recent local sessions, enriched only after modification-time sorting.
 */
export async function collectRecentSessions(
	limit: number,
	source: Platform | null = null,
): Promise<Session[]> {
	const sources: Platform[] = source ? [source] : ["claude", "codex"];
	const lists = await Promise.all(sources.map(collectSourceSessions));
	const recent = lists
		.flat()
		.sort((left, right) => right.modifiedAt - left.modifiedAt)
		.slice(0, limit);

	return Promise.all(recent.map(readSessionMetadata));
}

export async function resolveSession(
	id: string,
	source: Platform | null = null,
): Promise<SessionReference | null> {
	const sources: Platform[] = source ? [source] : ["claude", "codex"];
	const matches: SessionReference[] = [];
	for (const candidateSource of sources) {
		for await (const filePath of walk(SESSION_ROOTS[candidateSource])) {
			if (
				filePath.endsWith(".jsonl") &&
				sessionIdFromPath(candidateSource, filePath) === id
			) {
				matches.push({ source: candidateSource, id, filePath });
			}
		}
	}

	if (matches.length > 1) {
		throw new Error(`Session ${id} exists in both sources; use --from`);
	}
	return matches[0] ?? null;
}

export async function inferSessionCwd(
	session: SessionReference,
): Promise<string> {
	const rows = await readJsonl(session.filePath, 400, true);
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const row = rows[index];
		if (!row) {
			continue;
		}
		const cwd = session.source === "claude" ? row.cwd : row.payload?.cwd;
		if (typeof cwd === "string" && cwd.trim()) {
			return cwd;
		}
	}
	return process.cwd();
}

export async function readSessionConversation(
	session: SessionReference,
	maxMessages: number,
): Promise<ConversationMessage[]> {
	const maxRows = Math.max(maxMessages * 12, 200);
	const rows = await readJsonl(session.filePath, maxRows, true);
	return toConversation(session.source, rows).slice(-maxMessages);
}

export function formatTimestamp(milliseconds: number): string {
	return new Date(milliseconds).toISOString().replace("T", " ").slice(0, 19);
}
