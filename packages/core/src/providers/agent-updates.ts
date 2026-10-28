import { tmpdir } from "node:os";
import { spawnAgentSync } from "./agent-binary.js";

/**
 * Whether a newer agent CLI is out, for the settings' Update (like HyperFrames Studio). An outdated CLI can
 * stop working: Grok's service refused 0.2.93 with "426 Upgrade Required" (8 Oct 2026). Grok reports it
 * itself (`grok update --check --json`); Claude Code and Codex are compared with their npm packages, read
 * from the public registry so the editor needs no npm.
 */

export type AgentId = "claude-code" | "codex" | "grok";

export interface AgentUpdate {
  current: string | null;
  latest: string | null;
  available: boolean;
}

const NPM: Record<Exclude<AgentId, "grok">, string> = {
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

/** a < b for dotted version numbers ("2.1.280" < "2.1.293"); a pre-release tail is ignored. */
export function olderVersion(a: string, b: string): boolean {
  const pa = a.split("-")[0]?.split(".").map(Number) ?? [];
  const pb = b.split("-")[0]?.split(".").map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function installedVersion(agent: AgentId): string | null {
  const name = agent === "claude-code" ? "claude" : agent;
  const r = spawnAgentSync(name, ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? null;
}

export async function agentUpdate(
  agent: AgentId,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentUpdate> {
  const current = installedVersion(agent);
  if (!current) return { current: null, latest: null, available: false };
  if (agent === "grok") {
    const r = spawnAgentSync("grok", ["update", "--check", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      cwd: tmpdir(),
    });
    try {
      const j = JSON.parse(r.stdout) as { latestVersion?: string; updateAvailable?: boolean };
      return { current, latest: j.latestVersion ?? null, available: j.updateAvailable === true };
    } catch {
      return { current, latest: null, available: false };
    }
  }
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${NPM[agent]}/latest`);
    if (!res.ok) return { current, latest: null, available: false };
    const latest = ((await res.json()) as { version?: string }).version ?? null;
    return { current, latest, available: latest !== null && olderVersion(current, latest) };
  } catch {
    // offline: no news is not an error
    return { current, latest: null, available: false };
  }
}

/** The CLI's own update command, run by the editor in a terminal. */
export function updateCommand(agent: AgentId): string {
  return agent === "claude-code"
    ? "claude update"
    : agent === "codex"
      ? "codex update"
      : "grok update";
}
