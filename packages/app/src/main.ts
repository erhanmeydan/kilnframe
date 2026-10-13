// Kilnframe Helper: the companion (packages/companion) as a menu bar / tray app. It starts the companion
// with Electron's own Node (ELECTRON_RUN_AS_NODE), restarts it if it stops, and offers a small menu. The
// panel in Premiere talks to the companion exactly as before; this app only keeps it running.
import { app, dialog, Menu, nativeImage, Notification, powerMonitor, shell, Tray } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledTools } from "./bundle.js";
import { companionPath } from "./shell-path.js";
import { startUpdates, type Updates } from "./updates.js";
import {
  bundledPlugin,
  installPlugin,
  installerAgent,
  needsInstall,
  removePlugin,
  replacesSameVersion,
} from "./plugin.js";
import { LOGIN_FLAG, announceText, startedAtLogin } from "./announce.js";
import { markBusy, onQuitRequest } from "./quit.js";
import {
  bundledResolvePanel,
  installResolvePanel,
  resolveInstallState,
  resolvePaths,
} from "./resolve-plugin.js";

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
      resolvePanel: "Paneli DaVinci Resolve'a Kur",
      resolveDone:
        "Kilnframe DaVinci Resolve'da hazır: Workspace > Workflow Integrations > Kilnframe. Resolve açıksa yeniden başlatın.",
      resolveNoDeveloper:
        "DaVinci Resolve Studio'nun geliştirici dosyaları bulunamadı. Resolve Studio'yu blackmagicdesign.com'dan yeniden kurun.",
      resolveFailed: "Resolve paneli kurulamadı, günlüğe bakın.",
      resolveNotStudio:
        "Kilnframe paneli DaVinci Resolve Studio gerektirir, ücretsiz sürüm eklenti yüklemiyor.",
      updateReady: "Yeni sürüm hazır: {v}. Panelden güncelleyin.",
      quit: "Kilnframe'den Çık",
      busyTitle: "Bir animasyon hazırlanıyor.",
      busyDetail:
        "Şimdi kapatırsanız iş durur ve harcanan token boşa gider. Bitince Kapat'ı seçerseniz Kilnframe animasyon bitince kendiliğinden kapanır.",
      quitWhenDone: "Bitince Kapat",
      quitNow: "Şimdi Kapat",
      closingWhenDone: "Animasyon bitince kapanacak",
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
      resolvePanel: "Install the Panel in DaVinci Resolve",
      resolveDone:
        "Kilnframe is ready in DaVinci Resolve: Workspace > Workflow Integrations > Kilnframe. Restart Resolve if it is open.",
      resolveNoDeveloper:
        "DaVinci Resolve Studio's developer files were not found. Reinstall Resolve Studio from blackmagicdesign.com.",
      resolveFailed: "The Resolve panel could not be installed, see the log.",
      resolveNotStudio:
        "The Kilnframe panel needs DaVinci Resolve Studio; the free version loads no plugins.",
      updateReady: "Version {v} is ready. Update from the panel.",
      quit: "Quit Kilnframe",
      busyTitle: "An animation is being made.",
      busyDetail:
        "If you quit now, the job stops and the tokens it used are lost. With Quit When Done, Kilnframe quits by itself once the animation is finished.",
      quitWhenDone: "Quit When Done",
      quitNow: "Quit Now",
      closingWhenDone: "Quits when the animation is done",
    };

let tray: Tray | null = null;
let companion: ChildProcess | null = null;
let updates: Updates | null = null;
const appVersion = app.getVersion();
let quitting = false;
/** A job runs or waits in the companion (job.busy); quitting then asks first (quit.ts). */
let busy = false;
let quitWhenDone = false;
let forceQuit = false;
let askingToQuit = false;
let shuttingDown = false;
/** When the app was ready (ms), so the activate that comes with the start is not taken for a reopen. */
let readyAt = 0;
let status = text.starting;
let restarts = 0;
/** Read once: the login shell takes a moment, and restarts reuse it. */
let path: string | null = null;
/** A line under the status about the plugin, while installing or after it failed. */
let pluginNote = "";
/** A Resolve panel problem worth showing in the menu (developer files missing, copy failed). */
let resolveNote = "";
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
    // the same version built again: the agent would keep the old files
    if (force || replacesSameVersion(plugin, state.plugin))
      logLine(
        `plugin: removing the installed ${plugin.name} first\n${await removePlugin(plugin.name, agent)}`,
      );
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
  companion.on("message", (m: { type?: string; busy?: boolean }) => {
    if (m?.type === "update.install") updates?.install();
    if (m?.type === "job.busy") setBusy(Boolean(m.busy));
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
    // its job ended with it
    setBusy(false);
    if (quitting) return;
    // a crash restarts it, a little later each time, so a broken install does not spin
    status = text.stopped;
    refreshMenu();
    restarts++;
    setTimeout(startCompanion, Math.min(30_000, 1000 * 2 ** Math.min(restarts, 5)));
  });
}

function setBusy(next: boolean) {
  busy = next;
  try {
    markBusy(home, next);
  } catch (err) {
    logLine(`job marker: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!next && quitWhenDone) app.quit();
  refreshMenu();
}

/** A job is running: Quit When Done (the default) or Quit Now. */
function askToQuit() {
  askingToQuit = true;
  app.focus({ steal: true });
  const choice = dialog.showMessageBoxSync({
    type: "warning",
    message: text.busyTitle,
    detail: text.busyDetail,
    buttons: [text.quitWhenDone, text.quitNow],
    defaultId: 0,
    cancelId: 0,
  });
  askingToQuit = false;
  if (choice === 1) {
    forceQuit = true;
    app.quit();
  } else {
    // the job may have ended while the question was open
    quitWhenDone = true;
    if (!busy) app.quit();
    else refreshMenu();
  }
}

/** On Windows the login item carries LOGIN_FLAG, so a start at login can be told apart (announce.ts). */
const loginArgs = process.platform === "win32" ? { args: [LOGIN_FLAG] } : {};
const openAtLogin = () => app.getLoginItemSettings(loginArgs).openAtLogin;
const setOpenAtLogin = (on: boolean) => app.setLoginItemSettings({ openAtLogin: on, ...loginArgs });

/** Opened by the user, or again while it runs: say where the icon is, and open its menu the second time. */
function announce(again: boolean) {
  notify(announceText(process.platform, turkish));
  if (again) tray?.popUpContextMenu();
}

/** Asked once, on the first start: the helper should be there whenever Premiere is. */
function openAtLoginOnFirstStart() {
  const state = readState();
  if (state.firstStart) return;
  setOpenAtLogin(true);
  writeState({ ...state, firstStart: new Date().toISOString() });
}

/**
 * Installs the DaVinci Resolve panel that came with this app, when Resolve is installed. On a start it runs only
 * when the installed panel is another version; the menu item forces it.
 */
function ensureResolvePlugin(force = false) {
  const paths = resolvePaths();
  const bundled = bundledResolvePanel();
  if (!paths || !bundled) return;
  const state = resolveInstallState(paths, bundled);
  if (state === "no-resolve") return;
  if (state === "no-developer-files" || state === "not-studio") {
    const note = state === "not-studio" ? text.resolveNotStudio : text.resolveNoDeveloper;
    logLine(`resolve: ${note}`);
    resolveNote = note;
    refreshMenu();
    return;
  }
  if (state === "up-to-date" && !force) return;
  try {
    installResolvePanel(bundled.dir, paths);
    logLine(`resolve: panel ${bundled.version} installed in ${paths.pluginsDir}`);
    resolveNote = "";
    notify(text.resolveDone);
  } catch (err) {
    logLine(`resolve: ${err instanceof Error ? err.message : String(err)}`);
    resolveNote = text.resolveFailed;
    notify(text.resolveFailed);
  }
  refreshMenu();
}

/** The menu offers the Resolve panel only where it can be installed: Resolve Studio with its developer files. */
function resolvePanelInstallable(): boolean {
  const paths = resolvePaths();
  const bundled = bundledResolvePanel();
  if (!paths || !bundled) return false;
  const state = resolveInstallState(paths, bundled);
  return state === "install" || state === "up-to-date";
}

function refreshMenu() {
  if (!tray) return;
  const login = openAtLogin();
  tray.setToolTip(status);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: quitWhenDone ? text.closingWhenDone : status, enabled: false },
      ...(pluginNote ? [{ label: pluginNote, enabled: false }] : []),
      ...(resolveNote ? [{ label: resolveNote, enabled: false }] : []),
      ...(updateNote ? [{ label: updateNote, enabled: false }] : []),
      { type: "separator" },
      { label: text.log, click: () => void shell.openPath(logFile) },
      ...(bundledPlugin() ? [{ label: text.plugin, click: () => void ensurePlugin(true) }] : []),
      ...(resolvePanelInstallable()
        ? [{ label: text.resolvePanel, click: () => ensureResolvePlugin(true) }]
        : []),
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
          setOpenAtLogin(!login);
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
  // opened again while it runs: Windows starts a second copy (it quits at once), macOS sends activate
  app.on("second-instance", () => announce(true));
  // macOS also sends activate as the app starts and when the quit question takes focus: not a reopen
  app.on("activate", () => {
    if (readyAt && Date.now() - readyAt > 3000 && !askingToQuit) announce(true);
  });
  // kilnframe:// (the panel's Open Kilnframe button) only needs the app running; it opens no window
  app.on("open-url", (event) => event.preventDefault());
  app.on("window-all-closed", () => {
    // a tray app has no windows; it stays until Quit
  });
  app.on("before-quit", (event) => {
    const action = onQuitRequest({ busy, force: forceQuit, shuttingDown, asking: askingToQuit });
    if (action !== "quit") {
      event.preventDefault();
      if (action === "ask") askToQuit();
      return;
    }
    quitting = true;
    // the companion ends its running job and everything that job started (isolated.ts)
    companion?.kill("SIGTERM");
  });
  // a marker left by a crash would make the Windows installer wait for a job that is not there
  markBusy(home, false);
  void app.whenReady().then(() => {
    // logging out or shutting down is never held up by the question
    powerMonitor.on("shutdown", () => {
      shuttingDown = true;
    });
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
    // a Windows login item from before LOGIN_FLAG starts the app without it: give it the flag
    if (process.platform === "win32" && app.getLoginItemSettings().openAtLogin)
      setOpenAtLogin(true);
    openAtLoginOnFirstStart();
    const login = startedAtLogin({
      platform: process.platform,
      argv: process.argv,
      wasOpenedAtLogin: app.getLoginItemSettings().wasOpenedAtLogin,
      uptimeS: uptime(),
    });
    if (!login) announce(false);
    readyAt = Date.now();
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
    ensureResolvePlugin();
  });
}
