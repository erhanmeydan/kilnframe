// The Kilnframe panel beside FilmCraft: the Kilnframe app loads this file (dist-filmcraft/panel.js) into its own
// main process and opens the panel window (electron/panel-window.ts) with the FilmCraft bridge. The app starts
// FilmCraft and holds its port and token; `endpoint` reads them, null while FilmCraft is not running.
import type { BrowserWindow } from "electron";
import { openPanelWindow } from "../electron/panel-window";
import { createFilmCraftBridge } from "./bridge";
import { createFilmCraftClient, type Endpoint } from "./client";
import type { ResolveBridge } from "../resolve/api";

let bridge: ResolveBridge | null = null;

/** Opens the panel window; closing it leaves the app and FilmCraft running. */
export function openFilmCraftPanel(endpoint: () => Endpoint | null): BrowserWindow {
  bridge ??= createFilmCraftBridge(createFilmCraftClient(endpoint));
  const b = bridge;
  return openPanelWindow(
    {
      editor: "filmcraft",
      title: "Kilnframe",
      bridge: async () => b,
      onClosed: () => undefined,
    },
    __dirname,
  );
}
