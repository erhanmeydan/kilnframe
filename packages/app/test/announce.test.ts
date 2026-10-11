import { describe, expect, it } from "vitest";
import { LOGIN_FLAG, announceText, startedAtLogin } from "../src/announce.js";

describe("startedAtLogin", () => {
  it("reads the login item's flag on Windows", () => {
    expect(startedAtLogin({ platform: "win32", argv: ["Kilnframe.exe", LOGIN_FLAG] })).toBe(true);
    expect(startedAtLogin({ platform: "win32", argv: ["Kilnframe.exe"] })).toBe(false);
  });

  it("on macOS takes the system's word, or a start in the first minutes after logging in", () => {
    const mac = { platform: "darwin", argv: [] };
    expect(startedAtLogin({ ...mac, wasOpenedAtLogin: true })).toBe(true);
    expect(startedAtLogin({ ...mac, uptimeS: 60 })).toBe(true);
    expect(startedAtLogin({ ...mac, uptimeS: 3600 })).toBe(false);
  });
});

describe("announceText", () => {
  it("says where the icon is, in the menu bar or under the tray's arrow", () => {
    expect(announceText("darwin", true)).toMatch(/menü çubuğunda/);
    expect(announceText("darwin", false)).toMatch(/menu bar/);
    expect(announceText("win32", true)).toMatch(/\^/);
    expect(announceText("win32", false)).toMatch(/\^/);
  });
});
