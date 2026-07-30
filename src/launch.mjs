import { spawn } from "node:child_process";

function appendPrompt(args, prompt) {
	if (prompt) {
		args.push(prompt);
	}
	return args;
}

/**
 * Builds the native resume command for an existing agent session.
 */
export function buildResumeCommand(
	session,
	firstMessage = null,
	forwardArgs = [],
) {
	const args =
		session.source === "claude"
			? ["--resume", session.id]
			: ["resume", session.id];
	appendPrompt(args, firstMessage);
	args.push(...forwardArgs);
	return { bin: session.source, args };
}

/**
 * Builds a command that starts a new target-agent session.
 */
export function buildNewCommand(target, firstMessage = null, forwardArgs = []) {
	const args = [];
	appendPrompt(args, firstMessage);
	args.push(...forwardArgs);
	return { bin: target, args };
}

/**
 * Builds the prompt used to transfer a session between different agents.
 */
export function buildHandoffPrompt(handoff, firstMessage = null) {
	const request = firstMessage
		? `\n\n## Current request\n\n${firstMessage}`
		: "";
	return `Continue this work from the supplied session handoff. Verify the current repository state before editing.\n\n${handoff}${request}`;
}

function shellQuote(value) {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Formats a command for inspection without executing it.
 */
export function formatCommand(command, cwd) {
	const rendered = [command.bin, ...command.args].map(shellQuote).join(" ");
	return cwd ? `cd ${shellQuote(cwd)} && ${rendered}` : rendered;
}

/**
 * Runs a target CLI with terminal input and output attached.
 */
export async function runCommand(command, cwd) {
	await new Promise((resolve, reject) => {
		const child = spawn(command.bin, command.args, {
			cwd,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`${command.bin} exited after signal ${signal}`));
				return;
			}
			if (code !== 0) {
				reject(new Error(`${command.bin} exited with code ${code}`));
				return;
			}
			resolve();
		});
	});
}
