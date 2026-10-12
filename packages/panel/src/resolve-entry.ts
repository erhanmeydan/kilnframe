// Installs the DaVinci Resolve host. index-resolve.ts imports this before the app, so the host is there when it
// starts. window.kilnframeResolve comes from resolve/preload.ts.
import { setHost } from "./host";
import { createResolveHost } from "./host-resolve";
import type { KilnframeResolveApi } from "./resolve/api";

declare global {
  interface Window {
    kilnframeResolve: KilnframeResolveApi;
  }
}

setHost(createResolveHost(window.kilnframeResolve));
