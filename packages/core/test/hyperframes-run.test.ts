import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseCheckJson, runProcess, snapshotIndex } from "../src/hyperframes.js";

const node = (script: string) => [process.execPath, ["-e", script]] as const;

describe("runProcess", () => {
  it("hands over a line split across two chunks whole", async () => {
    const lines: string[] = [];
    const [cmd, args] = node(
      `process.stdout.write('@hf-progress {"code":"cap'); setTimeout(() => process.stdout.write('ture","done":1}\\nnext\\nlast'), 50);`,
    );
    const r = await runProcess(cmd, [...args], tmpdir(), { onLine: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines).toEqual(['@hf-progress {"code":"capture","done":1}', "next", "last"]);
  });

  it("stops a process that stays silent, and says so", async () => {
    const [cmd, args] = node(
      `process.stderr.write("booting chrome\\n"); setTimeout(() => {}, 60000);`,
    );
    await expect(
      runProcess(cmd, [...args], tmpdir(), { idleTimeoutMs: 300, label: "hyperframes check" }),
    ).rejects.toThrow(/hyperframes check stopped responding[\s\S]*booting chrome/);
  });

  it("keeps a talking process alive past the idle limit", async () => {
    const [cmd, args] = node(
      `let n = 0; const t = setInterval(() => { console.log(n); if (++n === 6) clearInterval(t); }, 100);`,
    );
    const r = await runProcess(cmd, [...args], tmpdir(), { idleTimeoutMs: 300 });
    expect(r.stdout.trim().split("\n")).toHaveLength(6);
  });
});

describe("parseCheckJson", () => {
  const atRoot = (code: string) => ({
    code,
    severity: "error",
    message: "Failed to launch the browser process",
    sourceFile: "index.html",
    selector: "[data-composition-id]",
  });

  it("reads a crashed browser as a problem of the machine, not of a scene", () => {
    const r = parseCheckJson(
      JSON.stringify({
        ok: false,
        browserSkipped: true,
        lint: { ok: true, errorCount: 0, findings: [] },
        runtime: { ok: false, errorCount: 1, findings: [atRoot("check_runtime_failure")] },
      }),
    );
    expect(r.environmentError).toContain("Failed to launch");
  });

  it("reads a skipped browser without lint errors as a browser that did not start", () => {
    const r = parseCheckJson(
      JSON.stringify({ ok: false, browserSkipped: true, lint: { ok: true, errorCount: 0 } }),
    );
    expect(r.environmentError).toMatch(/did not start/);
  });

  it("leaves a browser skipped for lint errors to the scenes", () => {
    const r = parseCheckJson(
      JSON.stringify({
        ok: false,
        browserSkipped: true,
        lint: {
          ok: false,
          errorCount: 1,
          findings: [
            {
              code: "missing_timeline",
              severity: "error",
              message: "no timeline",
              sourceFile: "compositions/s2.html",
            },
          ],
        },
      }),
    );
    expect(r.environmentError).toBeNull();
    expect(r.ok).toBe(false);
  });
});

describe("snapshotIndex", () => {
  it("reads the shot's place among the --at times from its name", () => {
    expect(snapshotIndex("frame-03-at-1.25s.png")).toBe(3);
    expect(snapshotIndex("frame-112-at-60s.png")).toBe(112);
    expect(snapshotIndex("pairs.png")).toBeNull();
  });
});
