import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function createGitRemoteWorkspace(agentDir: string): Promise<{ cwd: string; nestedCwd: string }> {
	const cwd = path.join(agentDir, "git-project");
	const nestedCwd = path.join(cwd, "nested");
	await runGit(agentDir, ["init", cwd]);
	await runGit(cwd, ["remote", "add", "origin", "git@github.com:owner/project.git"]);
	await fsp.mkdir(nestedCwd);
	return { cwd, nestedCwd };
}

describe("SessionManager.continueRecent /new boundary", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		// Deterministic, non-TTY terminal id so breadcrumb read/write is stable.
		process.env.TMUX_PANE = "%new-boundary-test";
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-new-boundary-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("does not resume the pre-/new transcript when the new session produced no output", async () => {
		// Persisted old session with recognizable context (assistant output → file on disk).
		const old = SessionManager.create(cwd);
		old.appendMessage({ role: "user", content: "pre-new work", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		const oldFile = old.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted old session file");
		await old.close();

		// Resume it, then hit an explicit `/new` boundary and exit before any
		// assistant output — the new session's JSONL is never materialized (lazy).
		const resumed = await SessionManager.continueRecent(cwd);
		expect(JSON.stringify(resumed.getEntries())).toContain("pre-new work");
		await resumed.newSession();
		const freshFile = resumed.getSessionFile();
		if (!freshFile) throw new Error("Expected a fresh session file path");
		expect(path.resolve(freshFile)).not.toBe(path.resolve(oldFile));
		expect(fs.existsSync(freshFile)).toBe(false); // lazy: not yet on disk
		await resumed.close();

		// Relaunch with auto-resume: must NOT fall back to the pre-/new transcript.
		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			const dump = JSON.stringify(relaunched.getEntries());
			expect(dump).not.toContain("pre-new work");
			expect(relaunched.getEntries()).toHaveLength(0);
			// Reopens the fresh session established by `/new`, not the old file.
			expect(path.resolve(relaunched.getSessionFile() ?? "")).not.toBe(path.resolve(oldFile));
		} finally {
			await relaunched.close();
		}
	});

	it("preserves git-remote managed roots after relaunching a lazy /new session", async () => {
		const workspace = await createGitRemoteWorkspace(testAgentDir);
		const mode = "git-remote" as const;
		const old = SessionManager.create(workspace.cwd, undefined, undefined, mode);
		old.appendMessage({ role: "user", content: "pre-new work", timestamp: 1 });
		old.appendMessage(makeAssistantMessage());
		await old.flush();
		await old.close();

		const resumed = await SessionManager.continueRecent(workspace.cwd, undefined, undefined, mode);
		await resumed.newSession();
		await resumed.close();

		const relaunched = await SessionManager.continueRecent(workspace.cwd, undefined, undefined, mode);
		try {
			await relaunched.moveTo(workspace.nestedCwd);
			expect(path.dirname(relaunched.getSessionFile() ?? "")).toBe(
				SessionManager.getDefaultSessionDir(workspace.nestedCwd, undefined, undefined, mode),
			);
		} finally {
			await relaunched.close();
		}
	});

	it("preserves git-remote managed roots when cloning a session", async () => {
		const workspace = await createGitRemoteWorkspace(testAgentDir);
		const mode = "git-remote" as const;
		const source = SessionManager.create(workspace.cwd, undefined, undefined, mode);
		const clone = source.cloneCurrentSession();
		try {
			await clone.moveTo(workspace.nestedCwd);
			expect(path.dirname(clone.getSessionFile() ?? "")).toBe(
				SessionManager.getDefaultSessionDir(workspace.nestedCwd, undefined, undefined, mode),
			);
		} finally {
			await clone.close();
			await source.close();
		}
	});

	it("still falls back to the most-recent session for a genuinely stale breadcrumb", async () => {
		// A normal persisted session (survives).
		const first = SessionManager.create(cwd);
		first.appendMessage({ role: "user", content: "first session", timestamp: 1 });
		first.appendMessage(makeAssistantMessage());
		await first.flush();
		await first.close();

		// A distinct second session becomes the terminal's breadcrumb target and
		// materializes on disk (re-stamped non-fresh), then is externally deleted.
		const second = SessionManager.create(cwd);
		second.appendMessage({ role: "user", content: "second session", timestamp: 1 });
		second.appendMessage(makeAssistantMessage());
		await second.flush();
		const secondFile = second.getSessionFile();
		if (!secondFile) throw new Error("Expected persisted second session file");
		await second.close();
		await fsp.rm(secondFile, { force: true });

		const relaunched = await SessionManager.continueRecent(cwd);
		try {
			// Materialized-then-deleted target (non-fresh) → fall back to the
			// most-recent surviving session, not a fresh empty one.
			expect(JSON.stringify(relaunched.getEntries())).toContain("first session");
		} finally {
			await relaunched.close();
		}
	});
});
