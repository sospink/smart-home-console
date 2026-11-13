import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync(".git")) {
  console.log("No .git directory; commit-hook installation skipped.");
  process.exit(0);
}

const command = process.platform === "win32" ? "simple-git-hooks.cmd" : "simple-git-hooks";
const result = spawnSync(command, [], { stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
