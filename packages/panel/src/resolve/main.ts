// The Kilnframe panel inside DaVinci Resolve Studio: Resolve starts this file in its own Electron when the user
// opens Workspace > Workflow Integrations > Kilnframe. It opens the panel window (electron/panel-window.ts) with
// the Resolve work done through the bridge (WorkflowIntegration.node, copied beside this file by the Kilnframe
// app from the user's own Resolve install).
import { app } from "electron";
import { join } from "node:path";
import { openPanelWindow } from "../electron/panel-window";
import { createResolveBridge } from "./bridge";
import { untilItWorks } from "./once";
import type { ResolveBridge } from "./api";

const PLUGIN_ID = "com.kilnframe.resolve";

interface WorkflowIntegrationModule {
  InitializePromise(id: string): Promise<boolean>;
  GetResolvePromise(): Promise<unknown>;
  CleanUp(): void;
}
const WorkflowIntegration = require("./WorkflowIntegration.node") as WorkflowIntegrationModule;

const resolveBridge = untilItWorks(async (): Promise<ResolveBridge> => {
  if (!(await WorkflowIntegration.InitializePromise(PLUGIN_ID)))
    throw new Error(
      "DaVinci Resolve did not accept the plugin (WorkflowIntegration.InitializePromise).",
    );
  return createResolveBridge(await WorkflowIntegration.GetResolvePromise());
});

app.whenReady().then(() => {
  // Resolve runs its panels in its own Electron, which the Dock shows with Electron's icon; the name there
  // comes from that app's bundle and cannot be changed from here
  app.dock?.setIcon(join(__dirname, "icons", "app.png"));
  openPanelWindow(
    {
      editor: "resolve",
      title: "Kilnframe",
      bridge: resolveBridge,
      onClosed: () => {
        WorkflowIntegration.CleanUp();
        app.quit();
      },
    },
    __dirname,
  );
});
