#!/usr/bin/env node
import { keepWhen } from "./probe-memo.js";
import "./system-certs.js";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnAgentSync,
  withFreshPath,
  withoutHostSession,
  claudeCodeStatus,
  codexStatus,
  grokStatus,
  antigravityStatus,
  forgetAgyModels,
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
  loadMusicCatalog,
  listElevenLabsVoices,
  speechModelFor,
  narrate,
  downloadSpeechModel,
  systemReport,
  speechModelCached,
  vendorDir,
} from "@kilnframe/core";
import {
  AGENT_BINARY,
  type Agent,
  appleScriptString,
  loginCommand,
  loginEnv,
  logoutArgs,
} from "./agent-commands.js";
import { OsKeyStore } from "./keys.js";
import { makeCloneVoice } from "./clone-voice.js";
import { copyLegacyKeys, moveLegacyFolders } from "./legacy.js";
import {
  captionPreviewFrames,
  clearCaptionPreviews,
  deleteUserStyle,
  loadCaptionsState,
  saveCaptionsState,
  findPreviewPreset,
  findWavPreset,
  runningPremiereDirs,
  inspectImages,
  playSound,
  stopSound,
  previewText,
  prepareJobDir,
  styleCards,
  reviewFromDisk,
} from "./panel-support.js";
import { isolatedRunner, killAllJobs, killAllJobsNow } from "./isolated.js";
import { startCompanion } from "./server.js";
import { appUpdatesFromParent, type ChildMessage } from "./app-updates.js";

export const DEFAULT_PORT = 47615;
// the app passes its own version; the companion run on its own (development) has none
const VERSION = process.env.KILNFRAME_APP_VERSION ?? "0.0.0";

/** Where the panel finds the port and token. Readable only by the current user. */
export function connectionFile(): string {
  return join(process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"), "companion.json");
}

/** GPU and FFmpeg do not change while the app runs: probed once, again only after a failed probe. */
// the GPU probe starts a browser (about 4 s): a GPU found is kept for the session, anything else asked again
const hardware = keepWhen(
  () => systemReport(loadDefaults(), join(vendorDir(), "gsap", "gsap.min.js")),
  (report) => report.gpu.mode === "hardware",
);

async function main() {
  // data kept under the old name (motion-insert, until 9 Oct 2026) moves over before anything reads it
  for (const moved of moveLegacyFolders()) process.stderr.write(`moved old data to ${moved}\n`);
  // caption previews a stopped job or a quit left behind
  clearCaptionPreviews();
  const token = randomBytes(32).toString("hex");
  const keys = new OsKeyStore();
  const defaults = loadDefaults();
  const copied = await copyLegacyKeys(
    new OsKeyStore("motion-insert"),
    keys,
    [
      ...new Set([
        "anthropic",
        "custom",
        defaults.speech.provider,
        defaults.music.provider,
        ...loadProviderCatalog().map((p) => p.id),
      ]),
    ],
    process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"),
  );
  if (copied.length) process.stderr.write(`copied keys from the old name: ${copied.join(", ")}\n`);
  const companion = await startCompanion({
    token,
    keys,
    runner: isolatedRunner(),
    appUpdates: appUpdatesFromParent(),
    // the app holds off quitting (its Quit, an installer) while a job runs; absent when run on its own
    onBusy: (busy) => tellParent({ type: "job.busy", busy }),
    version: VERSION,
    port: Number(process.env.KILNFRAME_PORT ?? DEFAULT_PORT),
    systemCheck: async () => {
      // the speech model is looked at each time
      const defaults = loadDefaults();
      const report = await hardware();
      const premiere = runningPremiereDirs();
      return {
        ...report,
        speechModel: { name: defaults.whisper.model, cached: speechModelCached(defaults) },
        wavPreset: findWavPreset(process.platform, premiere),
        previewPreset: findPreviewPreset(process.platform, premiere),
      };
    },
    listStyles: async () =>
      styleCards(
        join(process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"), "cache", "thumbs"),
      ),
    prepareJob: async (projectPath, sequenceName, jobRoot) =>
      prepareJobDir(projectPath, sequenceName, new Date(), { jobRoot }),
    captionPreviews: async () => captionPreviewFrames(),
    saveCaptions: async (jobDir, state) => saveCaptionsState(jobDir, state),
    loadCaptions: async (jobDir) => loadCaptionsState(jobDir),
    deleteStyle: async (name) => deleteUserStyle(name),
    listVoices: async (provider) => {
      const defaults = loadDefaults();
      const id = provider ?? defaults.speech.provider;
      const entry = loadSpeechCatalog().find((p) => p.id === id);
      const key = await keys.get(entry?.keyName ?? id);
      const musicEntry = loadMusicCatalog().find((p) => p.id === defaults.music.provider);
      const base = {
        provider: id,
        model: speechModelFor(defaults, id) ?? defaults.speech.model,
        keySet: Boolean(key),
        musicKeySet: Boolean(await keys.get(musicEntry?.keyName ?? defaults.music.provider)),
      };
      // ElevenLabs voices live in the editor's account, clones included
      if (id === "elevenlabs") {
        if (!key || !entry) return { ...base, voices: [] };
        try {
          return {
            ...base,
            voices: await listElevenLabsVoices({ apiKey: key, endpoint: entry.endpoint }),
          };
        } catch (err) {
          return { ...base, voices: [], error: err instanceof Error ? err.message : String(err) };
        }
      }
      return { ...base, voices: entry?.voices ?? [] };
    },
    previewVoice: async (voice, language, onEnd, o = {}) => {
      const defaults = loadDefaults();
      const id = o.provider ?? defaults.speech.provider;
      const model = speechModelFor(defaults, id) ?? defaults.speech.model;
      const dir = join(
        process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe"),
        "cache",
        "voices",
      );
      const file = join(dir, `${model}-${voice}-${language.slice(0, 2)}.wav`);
      if (!existsSync(file)) {
        const entry = loadSpeechCatalog().find((p) => p.id === id);
        const speech = createSpeechProvider(defaults, {
          provider: id,
          model,
          apiKey: await keys.get(entry?.keyName ?? id),
        });
        await narrate({
          provider: speech,
          text: previewText(o.label ?? voice, language),
          voice,
          language,
          outFile: file,
        });
      }
      playSound(file, onEnd);
    },
    cloneVoice: makeCloneVoice({ getKey: (name) => keys.get(name) }),
    stopVoice: () => stopSound(),
    playAudio: (file, onEnd) => playSound(file, onEnd),
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
      return { providers, ...(await agentStatuses()), updates: await agentUpdates() };
    },
    loginAgent: async (agent) => {
      // the panel watches for the sign-in to finish in the terminal: no cached state meanwhile
      freshUntil = Date.now() + 5 * 60_000;
      // a kept Antigravity model list belongs to the account before this sign-in
      if (agent === "antigravity") forgetAgyModels();
      openInTerminal(loginCommand(agent, process.env), loginEnv(agent, process.env));
    },
    logoutAgent: async (agent) => {
      statusCache = null;
      return logoutAgent(agent);
    },
    updateAgent: async (agent) => {
      freshUntil = Date.now() + 5 * 60_000;
      updateCache = null;
      openInTerminal(updateCommand(agent));
    },
    testProvider: async (provider, model, baseURL, thinking) => {
      try {
        return await testProvider(
          createTextProvider(loadDefaults(), {
            provider,
            model,
            baseURL,
            thinking,
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
      // Antigravity's preflight reads the status found here (its check goes over the network)
      if (provider === "antigravity") await antigravityStatus();
      p.preflight?.();
      const catalog = loadModelCatalog();
      return ((await p.listModels?.()) ?? []).map((m) => ({
        ...m,
        catalog: catalog.models[m.id] ?? null,
      }));
    },
    prepareModels: async (onProgress) => {
      const defaults = loadDefaults();
      await downloadSpeechModel(defaults, onProgress);
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
    void agentStatuses();
    void agentUpdates().catch(() => {});
  }, 0);
  // a running job lives in its own process group and would outlive the companion
  process.on("exit", killAllJobsNow);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    rmSync(file, { force: true });
    await killAllJobs();
    await companion.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (process.send) {
    // the app asks over IPC: on Windows a signal cannot be caught, it ends the process without clean-up
    process.on("message", (m: { type?: string } | null) => {
      if (m?.type === "quit") void stop();
    });
    // the app crashed or was force-quit: an orphan would hold the port the next app's companion needs
    process.on("disconnect", () => void stop());
  }
}

/** A message to the app, when it is there: a send on a closed channel would crash the companion. */
function tellParent(message: ChildMessage): void {
  if (!process.send || !process.connected) return;
  process.send(message, undefined, {}, () => {});
}

main().catch((err: unknown) => {
  process.stderr.write(
    `companion failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});

/**
 * The agent's own sign-out, run here without a window: the official CLI forgets its login, this app never
 * touches a credential. It signs that CLI out on this computer, not just in Kilnframe.
 */
function logoutAgent(agent: Agent): { ok: boolean; error?: string } {
  const args = logoutArgs(agent);
  if (!args) return { ok: false, error: "This CLI signs out only from its own screen." };
  const r = spawnAgentSync(AGENT_BINARY[agent], args, {
    encoding: "utf8",
    timeout: 30_000,
    env: withoutHostSession(process.env),
    // Grok's status is read from the temp folder too, so a project's own Grok settings play no part
    ...(agent === "grok" ? { cwd: tmpdir() } : {}),
  });
  if (r.error || r.status !== 0)
    return {
      ok: false,
      error: (r.stderr || r.stdout || r.error?.message || "").trim().slice(0, 300),
    };
  return { ok: true };
}

/** A command in a terminal window the editor sees: the official CLI does the work, this app only starts it. */
function openInTerminal(command: string, env: Record<string, string> = {}): void {
  if (process.platform === "darwin") {
    const r = spawnSync(
      "osascript",
      [
        "-e",
        `tell application "Terminal" to do script ${appleScriptString(command)}`,
        "-e",
        'tell application "Terminal" to activate',
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    // the panel waits for a sign-in in that window: say so when no window opened
    if (r.error || r.status !== 0)
      throw new Error(
        `Could not open Terminal: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`,
      );
  } else if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", command], {
      // the companion's own PATH is the one of sign-in time: an agent installed since would not be found
      env: { ...withFreshPath(process.env), ...env },
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    throw new Error(`Open a terminal and run: ${command}`);
  }
}

/**
 * Sign-in state of the agents. Asking them takes about a second (Grok goes over the network) and
 * blocks the companion meanwhile, so it is kept for a short while: opening the settings again is instant,
 * and a sign-in in the terminal still shows within seconds.
 */
let statusCache: { at: number; value: ReturnType<typeof readAgentStatuses> } | null = null;
/** Until then every request reads the agents again (a sign-in or update is under way). */
let freshUntil = 0;
async function readAgentStatuses() {
  // the others are read synchronously and block the event loop; Antigravity's check runs on timers (10 s
  // for --version), so it starts after them: started first, a slow Grok would make agy read as timed out
  const s = claudeCodeStatus();
  const codex = codexStatus();
  const grok = grokStatus();
  return {
    claudeCode: {
      installed: s.installed,
      loggedIn: s.loggedIn,
      version: s.version,
      subscription: s.subscription,
    },
    codex,
    grok,
    antigravity: await antigravityStatus(),
  };
}
function agentStatuses() {
  const ttl = Date.now() < freshUntil ? 0 : 15_000;
  if (!statusCache || Date.now() - statusCache.at > ttl)
    statusCache = { at: Date.now(), value: readAgentStatuses() };
  return statusCache.value;
}

/** Update news for the agents, read at most once an hour (a registry call per agent). */
let updateCache: { at: number; value: Record<string, unknown> } | null = null;
async function agentUpdates(): Promise<Record<string, unknown>> {
  if (updateCache && Date.now() - updateCache.at < 60 * 60_000) return updateCache.value;
  const ids = ["claude-code", "codex", "grok", "antigravity"] as const;
  const list = await Promise.all(ids.map((id) => agentUpdate(id)));
  const value = Object.fromEntries(ids.map((id, i) => [id, list[i]]));
  updateCache = { at: Date.now(), value };
  return value;
}
