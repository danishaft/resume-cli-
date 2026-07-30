import assert from "node:assert/strict";
import test from "node:test";

import { buildResumeCommand } from "../src/launch.mjs";

test("Codex sessions use the current native resume command", () => {
	assert.deepEqual(buildResumeCommand({ source: "codex", id: "session-1" }), {
		bin: "codex",
		args: ["resume", "session-1"],
	});
});

test("Claude sessions use the current native resume command", () => {
	assert.deepEqual(buildResumeCommand({ source: "claude", id: "session-2" }), {
		bin: "claude",
		args: ["--resume", "session-2"],
	});
});
