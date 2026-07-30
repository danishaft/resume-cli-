import readline, { type Key } from "node:readline";

import { formatTimestamp } from "./sessions.js";
import type { Session } from "./types.js";

export async function ask(question: string): Promise<string> {
	const reader = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		return await new Promise<string>((resolve) => {
			reader.question(question, (answer) => resolve(answer.trim()));
		});
	} finally {
		reader.close();
	}
}

function truncateMiddle(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	const sideLength = Math.floor((maxLength - 3) / 2);
	return `${value.slice(0, sideLength)}...${value.slice(-sideLength)}`;
}

function renderMenu(
	title: string,
	lines: string[],
	selected: number,
	offset: number,
	windowSize: number,
): void {
	const output = ["\x1b[2J\x1b[H", title, ""];
	for (let index = offset; index < offset + windowSize; index += 1) {
		const line = lines[index];
		if (!line) {
			break;
		}
		const prefix = index === selected ? "> " : "  ";
		const width = Math.max(60, (process.stdout.columns ?? 100) - 6);
		output.push(`${prefix}${truncateMiddle(line, width)}`);
	}
	output.push("", "Use arrows or j/k, Enter to select, q to cancel");
	process.stdout.write(output.join("\n"));
}

async function selectWithTty(lines: string[], title: string): Promise<number> {
	readline.emitKeypressEvents(process.stdin);
	let selected = 0;
	let offset = 0;
	const windowSize = Math.max(
		1,
		Math.min(lines.length, (process.stdout.rows ?? 24) - 6),
	);

	const restore = (): void => {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
		}
		process.stdout.write("\x1b[?25h\n");
	};

	return new Promise<number>((resolve, reject) => {
		const cleanup = (): void => {
			process.stdin.off("keypress", onKeypress);
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			restore();
		};
		const onSignal = (): void => {
			cleanup();
			reject(new Error("Selection cancelled"));
		};
		const refresh = (): void => {
			if (selected < offset) {
				offset = selected;
			}
			if (selected >= offset + windowSize) {
				offset = selected - windowSize + 1;
			}
			renderMenu(title, lines, selected, offset, windowSize);
		};
		const onKeypress = (_input: string, key: Key = {}): void => {
			if (
				key.name === "q" ||
				key.name === "escape" ||
				(key.ctrl && key.name === "c")
			) {
				onSignal();
				return;
			}
			if (key.name === "up" || key.name === "k") {
				selected = Math.max(0, selected - 1);
			} else if (key.name === "down" || key.name === "j") {
				selected = Math.min(lines.length - 1, selected + 1);
			} else if (key.name === "return") {
				cleanup();
				resolve(selected);
				return;
			}
			refresh();
		};

		process.stdin.setRawMode(true);
		process.stdout.write("\x1b[?25l");
		process.stdin.on("keypress", onKeypress);
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		refresh();
	});
}

async function selectWithPrompt(
	lines: string[],
	title: string,
): Promise<number> {
	process.stdout.write(`${title}\n`);
	for (const [index, line] of lines.entries()) {
		process.stdout.write(`${String(index + 1).padStart(2, " ")}. ${line}\n`);
	}
	const answer = Number(await ask("Select number> "));
	if (!Number.isInteger(answer) || answer < 1 || answer > lines.length) {
		throw new Error("Invalid selection");
	}
	return answer - 1;
}

export async function selectOption(
	options: string[],
	title: string,
): Promise<string> {
	if (options.length === 0) {
		throw new Error(`No options available for ${title}`);
	}
	const index =
		process.stdin.isTTY && process.stdout.isTTY
			? await selectWithTty(options, title)
			: await selectWithPrompt(options, title);
	const selected = options[index];
	if (selected === undefined) {
		throw new Error(`No option selected for ${title}`);
	}
	return selected;
}

export async function selectSession(sessions: Session[]): Promise<Session> {
	const lines = sessions.map((session) => {
		const summary = session.summary ? ` - ${session.summary}` : "";
		return `${formatTimestamp(session.modifiedAt)} [${session.source}] [${session.project}] ${session.id}${summary}`;
	});
	const index =
		process.stdin.isTTY && process.stdout.isTTY
			? await selectWithTty(lines, "Recent sessions")
			: await selectWithPrompt(lines, "Recent sessions");
	const selected = sessions[index];
	if (!selected) {
		throw new Error("No session selected");
	}
	return selected;
}
