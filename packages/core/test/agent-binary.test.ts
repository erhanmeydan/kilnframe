import { describe, expect, it } from "vitest";
import {
  agentCommand,
  cmdShimTarget,
  expandWinVars,
  parseRegPath,
  windowsSearchDirs,
} from "../src/providers/agent-binary.js";

const env = {
  USERPROFILE: "C:\\Users\\mete",
  APPDATA: "C:\\Users\\mete\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\mete\\AppData\\Local",
  PATH: "C:\\Windows\\system32",
};

// an npm global install on Windows (cmd-shim)
const shim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

describe("agent binaries on Windows", () => {
  it("expands %VARS% from the environment", () => {
    expect(expandWinVars("%USERPROFILE%\\.local\\bin;%NOPE%", env)).toBe(
      "C:\\Users\\mete\\.local\\bin;%NOPE%",
    );
  });

  it("reads a Path value out of reg query output", () => {
    const out =
      "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools\r\n\r\n";
    expect(parseRegPath(out)).toBe("%USERPROFILE%\\.local\\bin;C:\\Tools");
    expect(parseRegPath("ERROR: The system was unable to find the specified registry key")).toBe(
      "",
    );
  });

  it("searches the registry PATH, the process PATH and the installers' own folders", () => {
    const dirs = windowsSearchDirs(env, ["%USERPROFILE%\\fresh", "C:\\Machine"]);
    expect(dirs.slice(0, 3)).toEqual([
      "C:\\Users\\mete\\fresh",
      "C:\\Machine",
      "C:\\Windows\\system32",
    ]);
    expect(dirs).toContain("C:\\Users\\mete\\.local\\bin");
    expect(dirs).toContain("C:\\Users\\mete\\AppData\\Roaming\\npm");
    expect(dirs).toContain("C:\\Users\\mete\\.grok\\bin");
    expect(dirs).toContain("C:\\Users\\mete\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin");
  });

  it("finds the script an npm .cmd shim runs", () => {
    expect(cmdShimTarget(shim)).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(cmdShimTarget("@echo off\r\nfoo.exe %*")).toBeNull();
  });

  it("runs an .exe found in a folder the stale PATH misses", () => {
    const files = new Set(["C:\\Users\\mete\\.local\\bin\\claude.exe"]);
    const cmd = agentCommand("claude", {
      platform: "win32",
      env,
      registryPaths: () => [],
      exists: (p) => files.has(p),
      read: () => "",
      execPath: "C:\\Kilnframe\\Kilnframe.exe",
    });
    expect(cmd).toEqual({ file: "C:\\Users\\mete\\.local\\bin\\claude.exe", prefix: [], env: {} });
  });

  it("runs an npm shim's script with node, not through cmd", () => {
    const npm = "C:\\Users\\mete\\AppData\\Roaming\\npm";
    const files = new Set([`${npm}\\claude.cmd`, "C:\\Program Files\\nodejs\\node.exe"]);
    const cmd = agentCommand("claude", {
      platform: "win32",
      env,
      registryPaths: () => ["C:\\Program Files\\nodejs"],
      exists: (p) => files.has(p),
      read: () => shim,
      execPath: "C:\\Kilnframe\\Kilnframe.exe",
    });
    expect(cmd).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe",
      prefix: [`${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`],
      env: {},
    });
  });

  it("falls back to the app's own Node when no node.exe is around", () => {
    const npm = "C:\\Users\\mete\\AppData\\Roaming\\npm";
    const files = new Set([`${npm}\\codex.cmd`]);
    const cmd = agentCommand("codex", {
      platform: "win32",
      env,
      registryPaths: () => [],
      exists: (p) => files.has(p),
      read: () =>
        shim.replace("@anthropic-ai\\claude-code\\cli.js", "@openai\\codex\\bin\\codex.js"),
      execPath: "C:\\Kilnframe\\Kilnframe.exe",
    });
    expect(cmd.file).toBe("C:\\Kilnframe\\Kilnframe.exe");
    expect(cmd.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("keeps the plain name elsewhere and an override everywhere", () => {
    const deps = {
      platform: "darwin" as const,
      env: {},
      registryPaths: () => [],
      exists: () => false,
      read: () => "",
      execPath: "",
    };
    expect(agentCommand("grok", deps)).toEqual({ file: "grok", prefix: [], env: {} });
    expect(
      agentCommand("grok", { ...deps, platform: "win32", env: { KILNFRAME_GROK: "D:\\g.exe" } }),
    ).toEqual({
      file: "D:\\g.exe",
      prefix: [],
      env: {},
    });
  });
});

describe("withFreshPath", () => {
  it("gives a terminal one Path with the registry's folders first", async () => {
    const { withFreshPath } = await import("../src/providers/agent-binary.js");
    const { PATH: _p, ...rest } = env;
    void _p;
    const out = withFreshPath({ ...rest, Path: "C:\\old" }, ["C:\\new"]);
    const keys = Object.keys(out).filter((k) => k.toLowerCase() === "path");
    expect(keys).toEqual(["Path"]);
    expect(out.Path!.split(";").slice(0, 2)).toEqual(["C:\\new", "C:\\old"]);
    expect(out.Path).toContain("C:\\Users\\mete\\.local\\bin");
  });
});

describe("remembered for a moment", () => {
  it("reads the registry once for calls close together, and again after a while", async () => {
    const { remembered } = await import("../src/providers/agent-binary.js");
    let reads = 0;
    let now = 0;
    const read = remembered(
      () => {
        reads += 1;
        return ["x"];
      },
      5_000,
      () => now,
    );
    read();
    read();
    now = 4_000;
    read();
    expect(reads).toBe(1);
    now = 6_000;
    read();
    expect(reads).toBe(2);
  });
});
