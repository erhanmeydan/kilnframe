// Kilnframe Helper: the companion (packages/companion) as a menu bar / tray app. It starts the companion
// with Electron's own Node (ELECTRON_RUN_AS_NODE), restarts it if it stops, and offers a small menu. The
// panel in Premiere talks to the companion exactly as before; this app only keeps it running.
import { app, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledTools } from "./bundle.js";
import { companionPath } from "./shell-path.js";
import { startUpdates, type Updates } from "./updates.js";
import { bundledPlugin, installPlugin, installerAgent, needsInstall } from "./plugin.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.KILNFRAME_HOME ?? join(homedir(), ".kilnframe");
const logFile = join(home, "companion.log");
const turkish = app.getLocale().toLowerCase().startsWith("tr");

const text = turkish
  ? {
      running: "Kilnframe çalışıyor",
      starting: "Kilnframe başlıyor…",
      stopped: "Yardımcı uygulama durdu, yeniden başlatılıyor…",
      log: "Günlüğü Göster",
      styles: "Kendi Stillerimi Göster",
      login: "Oturum Açılınca Başlat",
      plugin: "Eklentiyi Premiere'e Kur",
      pluginDone: "Eklenti kuruldu. Premiere'i yeniden başlatın.",
      pluginFailed: "Eklenti kurulamadı, günlüğe bakın.",
      noAgent: "Adobe eklenti kurucusu bulunamadı. Creative Cloud kurulu mu?",
      updateReady: "Yeni sürüm hazır: {v}. Panelden güncelleyin.",
      quit: "Kilnframe'den Çık",
    }
  : {
      running: "Kilnframe is running",
      starting: "Kilnframe is starting…",
      stopped: "The helper stopped, restarting…",
      log: "Show Log",
      styles: "Show My Styles",
      login: "Open at Login",
      plugin: "Install the Plugin in Premiere",
      pluginDone: "Plugin installed. Restart Premiere.",
      pluginFailed: "The plugin could not be installed, see the log.",
      noAgent: "Adobe's plugin installer was not found. Is Creative Cloud installed?",
      updateReady: "Version {v} is ready. Update from the panel.",
      quit: "Quit Kilnframe",
    };

let tray: Tray | null = null;
let companion: ChildProcess | null = null;
let updates: Updates | null = null;
const appVersion = app.getVersion();
let quitting = false;
let status = text.starting;
let restarts = 0;
/** Read once: the login shell takes a moment, and restarts reuse it. */
let path: string | null = null;
/** A line under the status about the plugin, while installing or after it failed. */
let pluginNote = "";
/** "New version ready", shown in the menu; the panel offers the button. */
let updateNote = "";

/** ~/.kilnframe/app.json: when the app first started and which plugin it installed. */
interface AppState {
  firstStart?: string;
  plugin?: { id: string; version: string; hash?: string };
}
const stateFile = join(home, "app.json");
function readState(): AppState {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as AppState;
  } catch {
    return {};
  }
}
function writeState(state: AppState) {
  mkdirSync(home, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function logLine(line: string) {
  mkdirSync(home, { recursive: true });
  createWriteStream(logFile, { flags: "a" }).end(`${line}\n`);
}

/** A system notification: the menu bar app has no window, and the menu is only seen when opened. */
function notify(body: string) {
  if (Notification.isSupported()) new Notification({ title: "Kilnframe", body }).show();
}

/**
 * Installs the panel that came with this app into Premiere (one download installs both). On a
 * start it runs only when the bundled version differs from the one this app installed last; the menu item
 * forces it, e.g. after the editor removed the plugin in Creative Cloud.
 */
async function ensurePlugin(force = false) {
  const plugin = bundledPlugin();
  if (!plugin) return;
  const state = readState();
  if (!force && !needsInstall(plugin, state.plugin)) return;
  const agent = installerAgent();
  if (!agent) {
    logLine(`plugin: ${text.noAgent}`);
    if (force) pluginNote = text.noAgent;
    refreshMenu();
    return;
  }
  try {
    const out = await installPlugin(plugin, agent);
    logLine(`plugin: ${plugin.id} ${plugin.version} installed\n${out}`);
    writeState({
      ...readState(),
      plugin: { id: plugin.id, version: plugin.version, hash: plugin.hash },
    });
    pluginNote = text.pluginDone;
    notify(text.pluginDone);
  } catch (err) {
    logLine(
      `plugin: ${plugin.id} ${plugin.version} failed: ${err instanceof Error ? err.message : err}`,
    );
    pluginNote = text.pluginFailed;
    notify(text.pluginFailed);
  }
  refreshMenu();
}

function startCompanion() {
  mkdirSync(home, { recursive: true });
  const log = createWriteStream(logFile, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} starting\n`);
  const entry = require.resolve("@kilnframe/companion/main");
  companion = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ...bundledTools(),
      PATH: (path ??= companionPath()),
      KILNFRAME_APP_VERSION: appVersion,
      ELECTRON_RUN_AS_NODE: "1",
    },
    // the IPC channel carries the update state to the companion and the panel's "install" back
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  companion.on("message", (m: { type?: string }) => {
    if (m?.type === "update.install") updates?.install();
  });
  if (updates) companion.send({ type: "update.state", state: updates.state() });
  companion.stdout?.pipe(log, { end: false });
  companion.stderr?.on("data", (chunk: Buffer) => {
    log.write(chunk);
    if (chunk.toString().includes("listening on")) {
      status = text.running;
      restarts = 0;
      refreshMenu();
    }
  });
  companion.on("exit", (code) => {
    log.write(`--- exited ${code ?? "signal"}\n`);
    companion = null;
    if (quitting) return;
    // a crash restarts it, a little later each time, so a broken install does not spin
    status = text.stopped;
    refreshMenu();
    restarts++;
    setTimeout(startCompanion, Math.min(30_000, 1000 * 2 ** Math.min(restarts, 5)));
  });
}

/** Asked once, on the first start: the helper should be there whenever Premiere is. */
function openAtLoginOnFirstStart() {
  const state = readState();
  if (state.firstStart) return;
  app.setLoginItemSettings({ openAtLogin: true });
  writeState({ ...state, firstStart: new Date().toISOString() });
}

function refreshMenu() {
  if (!tray) return;
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setToolTip(status);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      ...(pluginNote ? [{ label: pluginNote, enabled: false }] : []),
      ...(updateNote ? [{ label: updateNote, enabled: false }] : []),
      { type: "separator" },
      { label: text.log, click: () => void shell.openPath(logFile) },
      ...(bundledPlugin() ? [{ label: text.plugin, click: () => void ensurePlugin(true) }] : []),
      {
        label: text.styles,
        click: () => {
          const styles = join(home, "styles");
          mkdirSync(styles, { recursive: true });
          void shell.openPath(styles);
        },
      },
      {
        label: text.login,
        type: "checkbox",
        checked: login,
        click: () => {
          app.setLoginItemSettings({ openAtLogin: !login });
          refreshMenu();
        },
      },
      { type: "separator" },
      { label: text.quit, click: () => app.quit() },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("window-all-closed", () => {
    // a tray app has no windows; it stays until Quit
  });
  app.on("before-quit", () => {
    quitting = true;
    // the companion ends its running job and everything that job started (isolated.ts)
    companion?.kill("SIGTERM");
  });
  void app.whenReady().then(() => {
    app.dock?.hide();
    // macOS tints a black template image for the menu bar; Windows shows it as is, black on a dark taskbar,
    // so there the tray gets the colour app icon
    const icon =
      process.platform === "darwin"
        ? nativeImage.createFromPath(join(here, "..", "assets", "trayTemplate.png"))
        : nativeImage
            .createFromPath(join(here, "..", "assets", "icon.png"))
            .resize({ width: 32, height: 32 });
    if (process.platform === "darwin") icon.setTemplateImage(true);
    tray = new Tray(icon);
    openAtLoginOnFirstStart();
    refreshMenu();
    // only a packaged app updates; in development the version is the repository's
    if (app.isPackaged)
      updates = startUpdates({
        current: appVersion,
        log: logLine,
        feedUrl: process.env.KILNFRAME_UPDATE_URL,
        onState: (state) => {
          if (companion?.connected) companion.send({ type: "update.state", state });
          // installing is the panel's button: only the companion knows whether a job is running
          updateNote =
            state.status === "available" || state.status === "ready"
              ? text.updateReady.replace("{v}", state.version ?? "")
              : "";
          refreshMenu();
        },
      });
    startCompanion();
    void ensurePlugin();
  });
}
