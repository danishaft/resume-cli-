import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SESSION_ROOTS = {
	claude: path.join(os.homedir(), ".claude", "projects"),
	codex: path.join(os.homedir(), ".codex", "sessions"),
};

async function* walk(directory) {
	let entries;
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

function parseJson(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

async function readJsonl(filePath, maxRows, keepTail = false) {
	const rows = [];
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

function extractClaudeText(content) {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function firstLine(value, maxLength = 100) {
	const line = String(value ?? "")
		.split(/\r?\n/, 1)[0]
		.replace(/\s+/g, " ")
		.trim();
	return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line;
}

function toConversation(source, rows) {
	const messages = [];
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
					timestamp: row.timestamp ?? null,
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
					timestamp: row.timestamp ?? null,
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
				timestamp: row.timestamp ?? null,
			});
		}
	}
	return messages;
}

function sessionIdFromPath(source, filePath) {
	const baseName = path.basename(filePath, ".jsonl");
	if (source === "claude") {
		return /^[0-9a-f-]{36}$/i.test(baseName) ? baseName : null;
	}
	const match = baseName.match(
		/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/,
	);
	return match?.[1] ?? null;
}

async function collectSourceSessions(source) {
	const sessions = [];
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

async function readSessionMetadata(session) {
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
export async function collectRecentSessions(limit, source = null) {
	const sources = source ? [source] : ["claude", "codex"];
	const lists = await Promise.all(sources.map(collectSourceSessions));
	const recent = lists
		.flat()
		.sort((left, right) => right.modifiedAt - left.modifiedAt)
		.slice(0, limit);

	return Promise.all(recent.map(readSessionMetadata));
}

export async function resolveSession(id, source = null) {
	const sources = source ? [source] : ["claude", "codex"];
	const matches = [];
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

export async function inferSessionCwd(session) {
	const rows = await readJsonl(session.filePath, 400, true);
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const cwd =
			session.source === "claude" ? rows[index].cwd : rows[index].payload?.cwd;
		if (typeof cwd === "string" && cwd.trim()) {
			return cwd;
		}
	}
	return process.cwd();
}

export async function readSessionConversation(session, maxMessages) {
	const maxRows = Math.max(maxMessages * 12, 200);
	const rows = await readJsonl(session.filePath, maxRows, true);
	return toConversation(session.source, rows).slice(-maxMessages);
}

export function formatTimestamp(milliseconds) {
	return new Date(milliseconds).toISOString().replace("T", " ").slice(0, 19);
}
