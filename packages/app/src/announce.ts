// The app has no window: opened, it only adds a small icon, which a full menu bar can hide behind the notch and
// Windows puts under the tray's ^ arrow. So when the user opens it (not when it starts at login), and when they
// open it again while it runs, it says where it is.

/** The flag the login item starts the app with on Windows, where Electron cannot tell a login start apart. */
export const LOGIN_FLAG = "--at-login";

export function startedAtLogin(o: {
  platform: string;
  argv: string[];
  /** macOS: getLoginItemSettings().wasOpenedAtLogin, where the system still reports it. */
  wasOpenedAtLogin?: boolean;
  /** Seconds since the computer started. */
  uptimeS?: number;
}): boolean {
  if (o.platform !== "darwin") return o.argv.includes(LOGIN_FLAG);
  // newer macOS no longer says whether a login item opened the app; a start just after login is one
  return Boolean(o.wasOpenedAtLogin) || (o.uptimeS ?? Infinity) < 180;
}

export function announceText(platform: string, turkish: boolean): string {
  if (platform === "darwin")
    return turkish
      ? "Kilnframe çalışıyor. Simgesi menü çubuğunda, saatin yanında. Animasyonları Premiere'deki Kilnframe panelinden yapın."
      : "Kilnframe is running. Its icon is in the menu bar, next to the clock. Make animations from the Kilnframe panel in Premiere.";
  return turkish
    ? "Kilnframe çalışıyor. Simgesi saatin yanındaki ^ okunun altında olabilir. Animasyonları Premiere'deki Kilnframe panelinden yapın."
    : "Kilnframe is running. Its icon may be under the ^ arrow next to the clock. Make animations from the Kilnframe panel in Premiere.";
}
