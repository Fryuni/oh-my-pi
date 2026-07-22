import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDbPath, getLastChangelogVersionPath, removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

describe("__complete sessions", () => {
	it("uses effective git-remote workspace config without opening settings storage", async () => {
		const root = TempDir.createSync("@omp-complete-");
		try {
			const agentDir = root.join("agent");
			const cwd = root.join("project");
			await fs.mkdir(agentDir, { recursive: true });
			await runGit(root.path(), ["init", cwd]);
			await runGit(cwd, ["remote", "add", "origin", "git@github.com:owner/project.git"]);
			await Bun.write(
				path.join(agentDir, "config.yml"),
				"workspace:\n  identifier: git-remote\nlastChangelogVersion: 0.40.0\n",
			);

			const sessionDir = SessionManager.getDefaultSessionDir(cwd, agentDir, undefined, "git-remote");
			const session = SessionManager.create(cwd, sessionDir, undefined, "git-remote");
			session.appendMessage(makeAssistantMessage());
			await session.flush();
			const sessionId = session.getSessionId();
			await session.close();

			const child = Bun.spawn([process.execPath, cliEntry, "__complete", "sessions", "--", sessionId], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, NO_COLOR: "1", PI_CODING_AGENT_DIR: agentDir },
			});
			const stdout = new Response(child.stdout).text();
			const [exitCode, output] = await Promise.all([child.exited, stdout]);

			expect(exitCode).toBe(0);
			expect(output).toContain(sessionId);
			expect(await Bun.file(getAgentDbPath(agentDir)).exists()).toBe(false);
			expect(await Bun.file(getLastChangelogVersionPath(agentDir)).exists()).toBe(false);
		} finally {
			await removeWithRetries(root.path());
		}
	});
});
