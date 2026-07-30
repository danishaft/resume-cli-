import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { inferSessionCwd, readSessionConversation } from "./sessions.mjs";

function normalizeWhitespace(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function clip(value, maxLength) {
	const text = String(value ?? "");
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function firstLine(value, maxLength = 120) {
	return clip(
		normalizeWhitespace(String(value ?? "").split(/\r?\n/, 1)[0]),
		maxLength,
	);
}

function extractPaths(text) {
	const matches =
		String(text).match(
			/(?:\.?\/?[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)?/g,
		) ?? [];
	return matches.filter((value) => !value.startsWith("http"));
}

function unique(values, limit) {
	return [...new Set(values)].slice(0, limit);
}

function extractState(conversation, session, cwd) {
	const userMessages = conversation
		.filter((message) => message.role === "user")
		.map((message) => message.text);
	const assistantMessages = conversation
		.filter((message) => message.role === "assistant")
		.map((message) => message.text);
	const decisions = [];
	const constraints = [];
	const openQuestions = [];
	const nextActions = [];
	const paths = [];
	let lastError = "";

	for (const message of conversation) {
		const text = normalizeWhitespace(message.text);
		const lower = text.toLowerCase();
		paths.push(...extractPaths(text));

		if (
			message.role === "assistant" &&
			/\b(decided|choose|chosen|because|using)\b/.test(lower)
		) {
			decisions.push(firstLine(text, 160));
		}
		if (
			/\b(must|cannot|blocked|constraint|deprecated|permission)\b/.test(lower)
		) {
			constraints.push(firstLine(text, 160));
		}
		if (message.role === "user" && text.endsWith("?")) {
			openQuestions.push(firstLine(text, 160));
		}
		if (
			message.role === "assistant" &&
			/\b(next|todo|plan|will)\b/.test(lower)
		) {
			nextActions.push(firstLine(text, 160));
		}
		if (/\b(error|failed|exception|not found)\b/.test(lower)) {
			lastError = firstLine(text, 180);
		}
	}

	return {
		goal: firstLine(userMessages[0] ?? "Continue the previous task."),
		currentStatus: firstLine(
			assistantMessages.at(-1) ?? userMessages.at(-1) ?? "",
		),
		decisions: unique(decisions, 6),
		constraints: unique(constraints, 6),
		openQuestions: unique(openQuestions, 6),
		nextActions: unique(nextActions, 6),
		keyFiles: unique(paths, 12),
		lastError,
		source: session.source,
		sessionId: session.id,
		workingDirectory: cwd,
		generatedAt: new Date().toISOString(),
	};
}

function selectSnippets(conversation, contextLevel) {
	const count =
		contextLevel === "minimal"
			? 4
			: contextLevel === "standard"
				? 10
				: conversation.length;
	return conversation.slice(-count);
}

function renderList(lines, heading, items) {
	lines.push(`## ${heading}`, "");
	if (items.length === 0) {
		lines.push("_None._", "");
		return;
	}
	for (const item of items) {
		lines.push(`- ${clip(item, 240)}`);
	}
	lines.push("");
}

function renderHandoff(session, cwd, state, snippets) {
	const lines = [
		"# Session handoff",
		"",
		`- Source: ${session.source}`,
		`- Session ID: ${session.id}`,
		`- Working directory: ${cwd}`,
		"",
		"## Current state",
		"",
		`- Goal: ${state.goal || "Unknown"}`,
		`- Status: ${state.currentStatus || "Unknown"}`,
	];
	if (state.lastError) {
		lines.push(`- Last error: ${state.lastError}`);
	}
	lines.push("");

	renderList(lines, "Decisions", state.decisions);
	renderList(lines, "Constraints", state.constraints);
	renderList(lines, "Open questions", state.openQuestions);
	renderList(lines, "Next actions", state.nextActions);
	renderList(lines, "Key files", state.keyFiles);
	lines.push("## Recent context", "");
	for (const snippet of snippets) {
		lines.push(`### ${snippet.role}`, "", clip(snippet.text, 1_200), "");
	}
	return lines.join("\n");
}

export async function buildHandoffArtifacts(
	session,
	maxMessages,
	contextLevel,
) {
	const cwd = await inferSessionCwd(session);
	const conversation = await readSessionConversation(session, maxMessages);
	const state = extractState(conversation, session, cwd);
	const handoff = renderHandoff(
		session,
		cwd,
		state,
		selectSnippets(conversation, contextLevel),
	);
	return { cwd, state, handoff, transcript: conversation };
}

function safeFileToken(value) {
	return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function persistHandoff(session, cwd, artifacts, writeLocal) {
	const directory = path.join(os.tmpdir(), "continues-handoffs");
	await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const base = `${timestamp}-${safeFileToken(session.source)}-${safeFileToken(session.id)}`;
	const paths = {
		statePath: path.join(directory, `${base}.state.json`),
		handoffPath: path.join(directory, `${base}.handoff.md`),
		transcriptPath: path.join(directory, `${base}.transcript.json`),
	};

	await Promise.all([
		fsp.writeFile(paths.statePath, JSON.stringify(artifacts.state, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		}),
		fsp.writeFile(paths.handoffPath, artifacts.handoff, {
			encoding: "utf8",
			mode: 0o600,
		}),
		fsp.writeFile(
			paths.transcriptPath,
			JSON.stringify(artifacts.transcript, null, 2),
			{ encoding: "utf8", mode: 0o600 },
		),
	]);

	if (writeLocal) {
		const localPath = path.join(cwd, ".continues-handoff.md");
		await fsp.writeFile(localPath, artifacts.handoff, "utf8");
	}
	return paths;
}
