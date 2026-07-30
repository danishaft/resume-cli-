import type {
	CliCommand,
	ContextLevel,
	ListCommand,
	NewCommand,
	Platform,
	ResumeCommand,
} from "./types.js";

export const DEFAULT_CONTEXT_LEVEL: ContextLevel = "standard";
export const DEFAULT_MAX_MESSAGES = 12;
export const DEFAULT_RECENT_LIMIT = 20;

const CONTEXT_LEVELS = new Set<ContextLevel>(["minimal", "standard", "deep"]);
const PLATFORMS = new Set<Platform>(["claude", "codex"]);

function readValue(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

function parsePositiveInteger(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${option} must be a positive integer`);
	}
	return parsed;
}

function isPlatform(value: string): value is Platform {
	return PLATFORMS.has(value as Platform);
}

function parsePlatform(value: string | undefined, option: string): Platform {
	const normalized = String(value).toLowerCase();
	if (!isPlatform(normalized)) {
		throw new Error(`${option} must be claude or codex`);
	}
	return normalized;
}

function isContextLevel(value: string): value is ContextLevel {
	return CONTEXT_LEVELS.has(value as ContextLevel);
}

function parseList(args: string[]): ListCommand {
	let source: Platform | null = null;
	let limit = DEFAULT_RECENT_LIMIT;

	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (option === "--source") {
			source = parsePlatform(readValue(args, index, option), option);
			index += 1;
		} else if (option === "--limit") {
			limit = parsePositiveInteger(readValue(args, index, option), option);
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${option}`);
		}
	}

	if (!source) {
		throw new Error("list requires --source <claude|codex>");
	}
	return { command: "list", source, limit };
}

function parseNew(args: string[]): NewCommand {
	const target = parsePlatform(args[0], "new target");
	const result: NewCommand = {
		command: "new",
		target,
		cwd: null,
		dryRun: false,
		firstMessage: null,
		forwardArgs: [],
	};

	for (let index = 1; index < args.length; index += 1) {
		const option = args[index];
		if (option === "--") {
			result.forwardArgs = args.slice(index + 1);
			break;
		}
		if (option === "--cwd") {
			result.cwd = readValue(args, index, option);
			index += 1;
		} else if (option === "--first-message") {
			result.firstMessage = readValue(args, index, option);
			index += 1;
		} else if (option === "--dry-run") {
			result.dryRun = true;
		} else {
			throw new Error(`Unknown argument: ${option}`);
		}
	}
	return result;
}

function parseResume(
	args: string[],
	forcedContextLevel: string | null = null,
): ResumeCommand {
	const first = args[0];
	const hasSessionId = Boolean(first && !first.startsWith("-"));
	let contextLevel = forcedContextLevel ?? DEFAULT_CONTEXT_LEVEL;
	const result: Omit<ResumeCommand, "contextLevel"> = {
		command: "resume",
		sessionId: hasSessionId && first ? first : null,
		source: null,
		target: null,
		recent: DEFAULT_RECENT_LIMIT,
		maxMessages: DEFAULT_MAX_MESSAGES,
		dryRun: false,
		firstMessage: null,
		writeLocal: false,
		cwd: null,
		forwardArgs: [],
	};

	for (let index = hasSessionId ? 1 : 0; index < args.length; index += 1) {
		const option = args[index];
		if (option === "--") {
			result.forwardArgs = args.slice(index + 1);
			break;
		}

		if (option === "--from") {
			result.source = parsePlatform(readValue(args, index, option), option);
			index += 1;
		} else if (option === "--in") {
			result.target = parsePlatform(readValue(args, index, option), option);
			index += 1;
		} else if (option === "--recent") {
			result.recent = parsePositiveInteger(
				readValue(args, index, option),
				option,
			);
			index += 1;
		} else if (option === "--max-messages") {
			result.maxMessages = parsePositiveInteger(
				readValue(args, index, option),
				option,
			);
			index += 1;
		} else if (option === "--context-level") {
			contextLevel = readValue(args, index, option).toLowerCase();
			index += 1;
		} else if (option === "--first-message") {
			result.firstMessage = readValue(args, index, option);
			index += 1;
		} else if (option === "--cwd") {
			result.cwd = readValue(args, index, option);
			index += 1;
		} else if (option === "--dry-run") {
			result.dryRun = true;
		} else if (option === "--write-local") {
			result.writeLocal = true;
		} else {
			throw new Error(`Unknown argument: ${option}`);
		}
	}

	if (!isContextLevel(contextLevel)) {
		throw new Error("--context-level must be minimal, standard, or deep");
	}
	return { ...result, contextLevel };
}

/**
 * Parses CLI arguments into one validated command shape.
 */
export function parseArgs(argv: string[]): CliCommand {
	if (argv.length === 0) {
		return parseResume([]);
	}

	const [rawCommand, ...rest] = argv;
	if (!rawCommand) {
		return parseResume([]);
	}
	if (rawCommand === "-h" || rawCommand === "--help" || rawCommand === "help") {
		return { command: "help" };
	}
	if (rawCommand === "list") {
		return parseList(rest);
	}
	if (rawCommand === "new") {
		return parseNew(rest);
	}
	if (isPlatform(rawCommand)) {
		return parseNew([rawCommand, ...rest]);
	}
	if (rawCommand === "resume") {
		return parseResume(rest);
	}
	if (rawCommand.startsWith("resume.")) {
		return parseResume(rest, rawCommand.slice("resume.".length));
	}

	throw new Error(`Unknown command: ${rawCommand}`);
}

export function getHelpText(): string {
	return `continues

Resume local Claude Code and Codex sessions.

Usage:
  continues
  continues resume [session-id] [options]
  continues new <claude|codex> [options]
  continues list --source <claude|codex> [--limit <n>]

Resume options:
  --from <claude|codex>       Limit session lookup to one source
  --in <claude|codex>         Select the target CLI
  --recent <n>                Number of recent sessions to inspect
  --context-level <level>     minimal, standard, or deep
  --max-messages <n>          Maximum messages used for handoff context
  --first-message <text>      Add a request to a new or cross-agent session
  --cwd <path>                Override the launch directory
  --write-local               Also write .continues-handoff.md
  --dry-run                   Print the launch command without running it
  --                          Forward remaining arguments to the target CLI`;
}
