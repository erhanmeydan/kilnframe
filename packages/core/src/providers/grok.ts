import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * The Grok CLI the user installed and signs in to with their own account. xAI has no public
 * sign-in programme for other apps, so this CLI is the way to the editor's Grok plan. Checked on Grok CLI
 * 0.2.93 (8 Oct 2026): `grok models` prints "You are not authenticated." before sign-in; `grok login --oauth`
 * signs in through the browser.
 */

export interface GrokStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
}

export function grokBinary(): string {
  return process.env.KILNFRAME_GROK ?? "grok";
}

export function grokStatus(): GrokStatus {
  const version = spawnSync(grokBinary(), ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (version.error || version.status !== 0)
    return { installed: false, version: null, loggedIn: false };
  const models = spawnSync(grokBinary(), ["models"], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: tmpdir(),
  });
  const text = `${models.stdout}\n${models.stderr}`;
  return {
    installed: true,
    version: version.stdout.trim().split(/\s+/)[1] ?? null,
    loggedIn: !/not authenticated|not signed in|log ?in first/i.test(text),
  };
}
