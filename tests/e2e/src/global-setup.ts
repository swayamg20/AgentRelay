import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function globalSetup() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../..");
  for (const pkg of ["relay", "agentrelay-mcp"]) {
    const r = spawnSync("pnpm", ["--filter", pkg, "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`build failed for ${pkg}: exit ${r.status}`);
  }
}
