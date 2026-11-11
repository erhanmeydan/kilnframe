export type Agent = "claude-code" | "codex" | "grok" | "antigravity";

/** The program each agent runs as. */
export const AGENT_BINARY = {
  "claude-code": "claude",
  codex: "codex",
  grok: "grok",
  antigravity: "agy",
} as const;

/** The setting that moves each CLI's sign-in to a folder of its own (a test or second profile). */
const PROFILE_VAR: Partial<Record<Agent, string>> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
};

const LOGIN: Record<Agent, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  grok: "grok login --oauth",
  // Antigravity CLI has no sign-in command: its first start asks for the Google sign-in
  antigravity: "agy",
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
  const dir = name ? env[name] : undefined;
  // Windows: the folder goes to the new window as a setting (loginEnv); cmd's quoting broke on spaces
  if (!name || !dir || platform === "win32") return LOGIN[agent];
  // single quotes keep everything literal in the shell; a quote in the folder name closes, escapes, reopens
  return `${name}='${dir.replace(/'/g, "'\\''")}' ${LOGIN[agent]}`;
}

/** Text as an AppleScript string literal: the command goes inside `do script "…"`. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The profile setting the sign-in window needs on Windows, where the window inherits it from the companion. */
export function loginEnv(agent: Agent, env: NodeJS.ProcessEnv): Record<string, string> {
  const name = PROFILE_VAR[agent];
  const dir = name ? env[name] : undefined;
  return name && dir ? { [name]: dir } : {};
}

/**
 * The CLI's own sign-out; it ends that account's session in the CLI on this computer. Null: the CLI signs out
 * only from inside its own screen (Antigravity CLI 1.5.5 has no sign-out command), so the panel offers none.
 */
export function logoutArgs(agent: Agent): string[] | null {
  if (agent === "antigravity") return null;
  return agent === "claude-code" ? ["auth", "logout"] : ["logout"];
}
