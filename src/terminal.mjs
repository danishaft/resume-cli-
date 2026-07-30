import readline from "node:readline";

import { formatTimestamp } from "./sessions.mjs";

export async function ask(question) {
	const reader = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		return await new Promise((resolve) => {
			reader.question(question, (answer) => resolve(answer.trim()));
		});
	} finally {
		reader.close();
	}
}

function truncateMiddle(value, maxLength) {
	if (value.length <= maxLength) {
		return value;
	}
	const sideLength = Math.floor((maxLength - 3) / 2);
	return `${value.slice(0, sideLength)}...${value.slice(-sideLength)}`;
}

function renderMenu(title, lines, selected, offset, windowSize) {
	const output = ["\x1b[2J\x1b[H", title, ""];
	for (let index = offset; index < offset + windowSize; index += 1) {
		if (!lines[index]) {
			break;
		}
		const prefix = index === selected ? "> " : "  ";
		const width = Math.max(60, (process.stdout.columns ?? 100) - 6);
		output.push(`${prefix}${truncateMiddle(lines[index], width)}`);
	}
	output.push("", "Use arrows or j/k, Enter to select, q to cancel");
	process.stdout.write(output.join("\n"));
}

async function selectWithTty(lines, title) {
	readline.emitKeypressEvents(process.stdin);
	let selected = 0;
	let offset = 0;
	const windowSize = Math.max(
		1,
		Math.min(lines.length, (process.stdout.rows ?? 24) - 6),
	);

	const restore = () => {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
		}
		process.stdout.write("\x1b[?25h\n");
	};

	return new Promise((resolve, reject) => {
		const onSignal = () => {
			cleanup();
			reject(new Error("Selection cancelled"));
		};
		const cleanup = () => {
			process.stdin.off("keypress", onKeypress);
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			restore();
		};
		const refresh = () => {
			if (selected < offset) {
				offset = selected;
			}
			if (selected >= offset + windowSize) {
				offset = selected - windowSize + 1;
			}
			renderMenu(title, lines, selected, offset, windowSize);
		};
		const onKeypress = (_input, key = {}) => {
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

async function selectWithPrompt(lines, title) {
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

export async function selectOption(options, title) {
	if (options.length === 0) {
		throw new Error(`No options available for ${title}`);
	}
	const index =
		process.stdin.isTTY && process.stdout.isTTY
			? await selectWithTty(options, title)
			: await selectWithPrompt(options, title);
	return options[index];
}

export async function selectSession(sessions) {
	const lines = sessions.map((session) => {
		const summary = session.summary ? ` - ${session.summary}` : "";
		return `${formatTimestamp(session.modifiedAt)} [${session.source}] [${session.project}] ${session.id}${summary}`;
	});
	const index =
		process.stdin.isTTY && process.stdout.isTTY
			? await selectWithTty(lines, "Recent sessions")
			: await selectWithPrompt(lines, "Recent sessions");
	return sessions[index];
}
