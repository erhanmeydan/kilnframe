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
 * The CLI's own sign-in, typed into a terminal window. The macOS Terminal does not inherit the companion's
 * environment, so a profile folder the companion uses is passed on in the command; otherwise the sign-in
 * lands in the default profile and the companion never sees it.
 */
export function loginCommand(
  agent: Agent,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const name = PROFILE_VAR[agent];
  const dir = env[name];
  // Windows: the folder goes to the new window as a setting (loginEnv); cmd's quoting broke on spaces
  if (!dir || platform === "win32") return LOGIN[agent];
  return `${name}='${dir}' ${LOGIN[agent]}`;
}

/** The profile setting the sign-in window needs on Windows, where the window inherits it from the companion. */
export function loginEnv(agent: Agent, env: NodeJS.ProcessEnv): Record<string, string> {
  const name = PROFILE_VAR[agent];
  const dir = env[name];
  return dir ? { [name]: dir } : {};
}

/** The CLI's own sign-out; it ends that account's session in the CLI on this computer. */
export function logoutArgs(agent: Agent): string[] {
  return agent === "claude-code" ? ["auth", "logout"] : ["logout"];
}
