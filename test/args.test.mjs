import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../dist/src/args.js";

test("no arguments opens the resume flow", () => {
	assert.equal(parseArgs([]).command, "resume");
});

test("resume rejects missing and unsupported option values", () => {
	assert.throws(
		() => parseArgs(["resume", "--recent", "0"]),
		/positive integer/,
	);
	assert.throws(
		() => parseArgs(["resume", "--session", "abc"]),
		/Unknown argument/,
	);
	assert.throws(
		() => parseArgs(["resume", "--in", "cursor"]),
		/claude or codex/,
	);
});
