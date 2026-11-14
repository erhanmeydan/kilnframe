// The Kilnframe panel inside DaVinci Resolve Studio: Resolve starts this file in its own Electron when the user
// opens Workspace > Workflow Integrations > Kilnframe. It opens the panel window (electron/panel-window.ts) with
// the Resolve work done through the bridge (WorkflowIntegration.node, copied beside this file by the Kilnframe
// app from the user's own Resolve install).
import { app } from "electron";
import { join } from "node:path";
import { openPanelWindow } from "../electron/panel-window";
import { createResolveBridge, type ClosableResolveBridge } from "./bridge";
import { untilItWorks } from "./once";

const PLUGIN_ID = "com.kilnframe.resolve";

interface WorkflowIntegrationModule {
  InitializePromise(id: string): Promise<boolean>;
  GetResolvePromise(): Promise<unknown>;
  CleanUp(): void;
}
const WorkflowIntegration = require("./WorkflowIntegration.node") as WorkflowIntegrationModule;

/** The bridge once made: the window closing restores through it, and makes none for that. */
let made: ClosableResolveBridge | null = null;

const resolveBridge = untilItWorks(async (): Promise<ClosableResolveBridge> => {
  if (!(await WorkflowIntegration.InitializePromise(PLUGIN_ID)))
    throw new Error(
      "DaVinci Resolve did not accept the plugin (WorkflowIntegration.InitializePromise).",
    );
  made = createResolveBridge(await WorkflowIntegration.GetResolvePromise());
  return made;
});

/** The longest the window's close waits for Resolve to take its tracks, settings and page back. */
const RESTORE_LIMIT_MS = 15_000;

/**
 * The window closed: a job in flight never gets to its own clean-up, so the editor's tracks, render settings
 * and page are put back here before the plugin ends.
 */
async function restoreThenQuit() {
  try {
    if (made)
      await Promise.race([
        made.restoreEditorState(),
        new Promise((ok) => setTimeout(ok, RESTORE_LIMIT_MS)),
      ]);
  } catch {
    // quitting goes on
  }
  WorkflowIntegration.CleanUp();
  app.quit();
}

// the plugin quits itself once Resolve has its state back, not as soon as its one window is gone
app.on("window-all-closed", () => undefined);

app.whenReady().then(() => {
  // Resolve runs its panels in its own Electron, which the Dock shows with Electron's icon; the name there
  // comes from that app's bundle and cannot be changed from here
  app.dock?.setIcon(join(__dirname, "icons", "app.png"));
  openPanelWindow(
    {
      editor: "resolve",
      title: "Kilnframe",
      bridge: resolveBridge,
      onClosed: () => void restoreThenQuit(),
    },
    __dirname,
  );
});
