import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { persistHandoff } from "../dist/src/handoff.js";

test("handoff artifacts and optional local copy remain private", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "continues-test-"));
	let artifactDirectory;
	const artifacts = {
		cwd,
		state: {},
		handoff: "private handoff",
		transcript: [],
	};

	try {
		const paths = await persistHandoff(
			{ source: "codex", id: "session/../../unsafe", filePath: "unused" },
			cwd,
			artifacts,
			true,
		);
		artifactDirectory = path.dirname(paths.handoffPath);
		const localPath = path.join(cwd, ".continues-handoff.md");

		assert.equal((await stat(artifactDirectory)).mode & 0o777, 0o700);
		assert.equal((await stat(paths.handoffPath)).mode & 0o777, 0o600);
		assert.equal((await stat(paths.transcriptPath)).mode & 0o777, 0o600);
		assert.equal((await stat(paths.statePath)).mode & 0o777, 0o600);
		assert.equal((await stat(localPath)).mode & 0o777, 0o600);
		assert.equal(await readFile(localPath, "utf8"), "private handoff");
		assert.equal(path.dirname(artifactDirectory), os.tmpdir());
		for (const artifactPath of Object.values(paths)) {
			assert.equal(path.dirname(artifactPath), artifactDirectory);
		}
	} finally {
		if (artifactDirectory) {
			await rm(artifactDirectory, { recursive: true, force: true });
		}
		await rm(cwd, { recursive: true, force: true });
	}
});
