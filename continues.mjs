#!/usr/bin/env node
import process from "node:process";

import { getHelpText, parseArgs } from "./src/args.mjs";
import { buildHandoffArtifacts, persistHandoff } from "./src/handoff.mjs";
import {
	buildHandoffPrompt,
	buildNewCommand,
	buildResumeCommand,
	formatCommand,
	runCommand,
} from "./src/launch.mjs";
import {
	collectRecentSessions,
	formatTimestamp,
	inferSessionCwd,
	resolveSession,
} from "./src/sessions.mjs";
import { selectSession } from "./src/terminal.mjs";

function printSessions(sessions) {
	for (const session of sessions) {
		const summary = session.summary ? ` - ${session.summary}` : "";
		process.stdout.write(
			`${formatTimestamp(session.modifiedAt)} [${session.source}] ${session.id} ${session.project}${summary}\n`,
		);
	}
}

async function runOrPrint(command, cwd, dryRun) {
	if (dryRun) {
		process.stdout.write(`${formatCommand(command, cwd)}\n`);
		return;
	}
	await runCommand(command, cwd);
}

async function selectRequestedSession(options) {
	if (options.sessionId) {
		const session = await resolveSession(options.sessionId, options.source);
		if (!session) {
			throw new Error(`Session not found: ${options.sessionId}`);
		}
		return session;
	}

	const sessions = await collectRecentSessions(options.recent, options.source);
	if (sessions.length === 0) {
		throw new Error("No local Claude Code or Codex sessions found");
	}
	return selectSession(sessions);
}

async function resume(options) {
	const session = await selectRequestedSession(options);
	const target = options.target ?? session.source;
	const inferredCwd = await inferSessionCwd(session);
	const cwd = options.cwd ?? inferredCwd;

	if (target === session.source) {
		const command = buildResumeCommand(
			session,
			options.firstMessage,
			options.forwardArgs,
		);
		await runOrPrint(command, cwd, options.dryRun);
		return;
	}

	const artifacts = await buildHandoffArtifacts(
		session,
		options.maxMessages,
		options.contextLevel,
	);
	const prompt = buildHandoffPrompt(artifacts.handoff, options.firstMessage);
	const command = buildNewCommand(target, prompt, options.forwardArgs);

	if (!options.dryRun) {
		const paths = await persistHandoff(
			session,
			cwd,
			artifacts,
			options.writeLocal,
		);
		process.stdout.write(`Handoff saved: ${paths.handoffPath}\n`);
	}
	await runOrPrint(command, cwd, options.dryRun);
}

async function main(argv) {
	const command = parseArgs(argv);
	if (command.command === "help") {
		process.stdout.write(`${getHelpText()}\n`);
		return;
	}
	if (command.command === "list") {
		printSessions(await collectRecentSessions(command.limit, command.source));
		return;
	}
	if (command.command === "new") {
		await runOrPrint(
			buildNewCommand(
				command.target,
				command.firstMessage,
				command.forwardArgs,
			),
			command.cwd ?? process.cwd(),
			command.dryRun,
		);
		return;
	}
	await resume(command);
}

main(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`continues: ${error.message}\n`);
	process.exitCode = 1;
});
