export type Platform = "claude" | "codex";
export type ContextLevel = "minimal" | "standard" | "deep";

export type HelpCommand = {
	command: "help";
};

export type ListCommand = {
	command: "list";
	source: Platform;
	limit: number;
};

export type NewCommand = {
	command: "new";
	target: Platform;
	cwd: string | null;
	dryRun: boolean;
	firstMessage: string | null;
	forwardArgs: string[];
};

export type ResumeCommand = {
	command: "resume";
	sessionId: string | null;
	source: Platform | null;
	target: Platform | null;
	recent: number;
	contextLevel: ContextLevel;
	maxMessages: number;
	dryRun: boolean;
	firstMessage: string | null;
	writeLocal: boolean;
	cwd: string | null;
	forwardArgs: string[];
};

export type CliCommand = HelpCommand | ListCommand | NewCommand | ResumeCommand;

export type SessionReference = {
	source: Platform;
	id: string;
	filePath: string;
};

export type SessionCandidate = SessionReference & {
	modifiedAt: number;
};

export type Session = SessionCandidate & {
	cwd: string;
	project: string;
	summary: string;
};

export type ConversationMessage = {
	role: "user" | "assistant";
	text: string;
	timestamp: string | null;
};

export type HandoffState = {
	goal: string;
	currentStatus: string;
	decisions: string[];
	constraints: string[];
	openQuestions: string[];
	nextActions: string[];
	keyFiles: string[];
	lastError: string;
	source: Platform;
	sessionId: string;
	workingDirectory: string;
	generatedAt: string;
};

export type HandoffArtifacts = {
	cwd: string;
	state: HandoffState;
	handoff: string;
	transcript: ConversationMessage[];
};

export type HandoffPaths = {
	statePath: string;
	handoffPath: string;
	transcriptPath: string;
};

export type LaunchCommand = {
	bin: Platform;
	args: string[];
};
