#!/usr/bin/env node
import "./system-certs.js";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeCodeStatus,
  codexStatus,
  grokStatus,
  agentUpdate,
  updateCommand,
  loadProviderCatalog,
  providerPreset,
  presetNeedsKey,
  testProvider,
  createTextProvider,
  loadDefaults,
  loadModelCatalog,
  createSpeechProvider,
  ensureOcrData,
  loadSpeechCatalog,
  narrate,
  loadSpeechModel,
  systemReport,
  vendorDir,
} from "@kilnframe/core";
import { OsKeyStore } from "./keys.js";
import { copyLegacyKeys, moveLegacyFolders } from "./legacy.js";
import {
  deleteUserStyle,
  findPreviewPreset,
  findWavPreset,
  inspectImages,
  playSound,
  stopSound,
  previewText,
  prepareJobDir,
  styleCards,
  reviewFromDisk,
} from "./panel-support.js";
import { isolatedRunner, killAllJobs } from "./isolated.js";
import { startCompanion } from "./server.js";
import { appUpdatesFromParent } from "./app-updates.js";

export const DEFAULT_PORT = 47615;
// the app passes its own version; the companion run on its own (development) has none
const VERSION = process.env.KILNFRAME_APP_VERSION ?? "0.0.0";

/** Where the panel finds the port and token. Readable only by the current user. */
export function connectionFile(): string {
  return join(process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"), "companion.json");
}

async function main() {
  // data kept under the old name (motion-insert, until 9 Oct 2026) moves over before anything reads it
  for (const moved of moveLegacyFolders()) process.stderr.write(`moved old data to ${moved}\n`);
  const token = randomBytes(32).toString("hex");
  const keys = new OsKeyStore();
  const defaults = loadDefaults();
  const copied = await copyLegacyKeys(new OsKeyStore("motion-insert"), keys, [
    ...new Set([
      "anthropic",
      "custom",
      defaults.speech.provider,
      defaults.music.provider,
      ...loadProviderCatalog().map((p) => p.id),
    ]),
  ]);
  if (copied.length) process.stderr.write(`copied keys from the old name: ${copied.join(", ")}\n`);
  const companion = await startCompanion({
    token,
    keys,
    runner: isolatedRunner(),
    appUpdates: appUpdatesFromParent(),
    // the app holds off quitting (its Quit, an installer) while a job runs; absent when run on its own
    onBusy: (busy) => process.send?.({ type: "job.busy", busy }),
    version: VERSION,
    port: Number(process.env.KILNFRAME_PORT ?? DEFAULT_PORT),
    systemCheck: async () => ({
      ...(await systemReport(loadDefaults(), join(vendorDir(), "gsap", "gsap.min.js"))),
      wavPreset: findWavPreset(),
      previewPreset: findPreviewPreset(),
    }),
    listStyles: async () =>
      styleCards(
        join(process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"), "cache", "thumbs"),
      ),
    prepareJob: async (projectPath, sequenceName) => prepareJobDir(projectPath, sequenceName),
    deleteStyle: async (name) => deleteUserStyle(name),
    listVoices: async () => {
      const defaults = loadDefaults();
      const entry = loadSpeechCatalog().find((p) => p.id === defaults.speech.provider);
      return {
        provider: defaults.speech.provider,
        model: defaults.speech.model,
        voices: entry?.voices ?? [],
        keySet: Boolean(await keys.get(entry?.keyName ?? defaults.speech.provider)),
      };
    },
    previewVoice: async (voice, language, onEnd) => {
      const defaults = loadDefaults();
      const dir = join(
        process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"),
        "cache",
        "voices",
      );
      const file = join(dir, `${defaults.speech.model}-${voice}-${language.slice(0, 2)}.wav`);
      if (!existsSync(file)) {
        const speech = createSpeechProvider(defaults, {
          apiKey: await keys.get(defaults.speech.provider),
        });
        await narrate({
          provider: speech,
          text: previewText(voice, language),
          voice,
          outFile: file,
        });
      }
      playSound(file, onEnd);
    },
    stopVoice: () => stopSound(),
    inspectImages: async (paths) =>
      inspectImages(
        paths,
        join(process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"), "cache", "images"),
      ),
    loadReview: async (outDir) => reviewFromDisk(outDir),
    listProviders: async () => {
      const presets = loadProviderCatalog();
      const providers = await Promise.all(
        presets.map(async (p) => ({
          id: p.id,
          displayName: p.displayName,
          models: p.models,
          tier: p.tier,
          needsKey: presetNeedsKey(p),
          keySet: presetNeedsKey(p) ? (await keys.get(p.id)) !== undefined : true,
          requires: p.requires ?? [],
          baseURL: p.baseURL,
          regions: p.regions ?? null,
          perModelVision: p.capabilities.vision === "per-model",
          keyUrl: p.keyUrl ?? null,
          slowModels: p.slowModels ?? [],
        })),
      );
      return { providers, ...agentStatuses(), updates: await agentUpdates() };
    },
    loginAgent: async (agent) => {
      // the panel watches for the sign-in to finish in the terminal: no cached state meanwhile
      freshUntil = Date.now() + 5 * 60_000;
      openLogin(agent);
    },
    updateAgent: async (agent) => {
      freshUntil = Date.now() + 5 * 60_000;
      updateCache = null;
      openInTerminal(updateCommand(agent));
    },
    testProvider: async (provider, model, baseURL) => {
      try {
        return await testProvider(
          createTextProvider(loadDefaults(), {
            provider,
            model,
            baseURL,
            apiKey: await keys.get(provider === "auto" ? "anthropic" : provider),
          }),
        );
      } catch (err) {
        // a provider that cannot even be built (no address, no model) fails the test with its reason
        return {
          ok: false,
          vision: false,
          model: model ?? "",
          ms: 0,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    listModels: async (provider, baseURL) => {
      const p = createTextProvider(loadDefaults(), {
        provider,
        baseURL,
        // listing needs no model, but a provider without a preset model (LM Studio) wants one named
        model: providerPreset(provider)?.models[0] ?? "list",
        apiKey: await keys.get(provider),
      });
      p.preflight?.();
      const catalog = loadModelCatalog();
      return ((await p.listModels?.()) ?? []).map((m) => ({
        ...m,
        catalog: catalog.models[m.id] ?? null,
      }));
    },
    prepareModels: async (onProgress) => {
      const defaults = loadDefaults();
      await loadSpeechModel(defaults, onProgress);
      await ensureOcrData(defaults.ocr, onProgress);
    },
  });
  const file = connectionFile();
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    JSON.stringify({ port: companion.port, token, pid: process.pid, version: VERSION }),
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  process.stderr.write(`kilnframe companion listening on 127.0.0.1:${companion.port}\n`);
  // ready before the panel asks: its first settings screen should not wait for the agents
  setTimeout(() => {
    agentStatuses();
    void agentUpdates().catch(() => {});
  }, 0);
  // a running job lives in its own process group and would outlive the companion
  process.on("exit", killAllJobs);
  const stop = async () => {
    killAllJobs();
    rmSync(file, { force: true });
    await companion.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `companion failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});

/**
 * The agent's own sign-in in a terminal window the editor sees, so the official CLI does the whole login
 * (browser, account, plan) and this app never touches a credential (like HyperFrames Studio).
 */
function openLogin(agent: "claude-code" | "codex" | "grok"): void {
  // a Claude Code profile of its own (CLAUDE_CONFIG_DIR) must sign in to that profile, not the default one
  const claudeDir = process.env.CLAUDE_CONFIG_DIR;
  const claudeLogin = !claudeDir
    ? "claude auth login"
    : process.platform === "win32"
      ? `set "CLAUDE_CONFIG_DIR=${claudeDir}" && claude auth login`
      : `CLAUDE_CONFIG_DIR='${claudeDir}' claude auth login`;
  openInTerminal(
    agent === "claude-code"
      ? claudeLogin
      : agent === "codex"
        ? "codex login"
        : "grok login --oauth",
  );
}

/** A command in a terminal window the editor sees: the official CLI does the work, this app only starts it. */
function openInTerminal(command: string): void {
  if (process.platform === "darwin") {
    spawnSync("osascript", [
      "-e",
      `tell application "Terminal" to do script "${command}"`,
      "-e",
      'tell application "Terminal" to activate',
    ]);
  } else if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", command], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    throw new Error(`Open a terminal and run: ${command}`);
  }
}

/**
 * Sign-in state of the three agents. Asking them takes about a second (Grok goes over the network) and
 * blocks the companion meanwhile, so it is kept for a short while: opening the settings again is instant,
 * and a sign-in in the terminal still shows within seconds.
 */
let statusCache: { at: number; value: ReturnType<typeof readAgentStatuses> } | null = null;
/** Until then every request reads the agents again (a sign-in or update is under way). */
let freshUntil = 0;
function readAgentStatuses() {
  const s = claudeCodeStatus();
  return {
    claudeCode: {
      installed: s.installed,
      loggedIn: s.loggedIn,
      version: s.version,
      subscription: s.subscription,
    },
    codex: codexStatus(),
    grok: grokStatus(),
  };
}
function agentStatuses() {
  const ttl = Date.now() < freshUntil ? 0 : 15_000;
  if (!statusCache || Date.now() - statusCache.at > ttl)
    statusCache = { at: Date.now(), value: readAgentStatuses() };
  return statusCache.value;
}

/** Update news for the three agents, read at most once an hour (a registry call per agent). */
let updateCache: { at: number; value: Record<string, unknown> } | null = null;
async function agentUpdates(): Promise<Record<string, unknown>> {
  if (updateCache && Date.now() - updateCache.at < 60 * 60_000) return updateCache.value;
  const ids = ["claude-code", "codex", "grok"] as const;
  const list = await Promise.all(ids.map((id) => agentUpdate(id)));
  const value = Object.fromEntries(ids.map((id, i) => [id, list[i]]));
  updateCache = { at: Date.now(), value };
  return value;
}
