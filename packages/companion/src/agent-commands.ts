export type Agent = "claude-code" | "codex" | "grok";

/** The setting that moves each CLI's sign-in to a folder of its own (a test or second profile). */
const PROFILE_VAR: Record<Agent, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
};

const LOGIN: Record<Agent, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  grok: "grok login --oauth",
};

/**
 * The CLI's own sign-in, typed into a terminal window. The terminal does not inherit the companion's
 * environment, so a profile folder the companion uses is passed on; otherwise the sign-in lands in the
 * default profile and the companion never sees it.
 */
export function loginCommand(
  agent: Agent,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const name = PROFILE_VAR[agent];
  const dir = env[name];
  if (!dir) return LOGIN[agent];
  return platform === "win32"
    ? `set "${name}=${dir}" && ${LOGIN[agent]}`
    : `${name}='${dir}' ${LOGIN[agent]}`;
}

/** The CLI's own sign-out; it ends that account's session in the CLI on this computer. */
export function logoutArgs(agent: Agent): string[] {
  return agent === "claude-code" ? ["auth", "logout"] : ["logout"];
}
