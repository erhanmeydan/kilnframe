import { describe, expect, it } from "vitest";
import { Unreachable, latest } from "./readers.mjs";

const reply =
  (body, status = 200) =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("readers", () => {
  it("npm: dist-tags.latest, never a pre-release", async () => {
    const r = await latest(
      { source: { type: "npm", package: "x" } },
      reply({ "dist-tags": { latest: "0.8.140", next: "0.9.0-rc.1" } }),
    );
    expect(r.latest).toBe("0.8.140");
  });
  it("github-release: newest matching non-prerelease tag", async () => {
    const r = await latest(
      { source: { type: "github-release", repo: "BtbN/FFmpeg-Builds", tagPattern: "^autobuild-" } },
      reply([
        { tag_name: "latest", prerelease: false },
        { tag_name: "autobuild-2026-10-31-13-05", prerelease: false, html_url: "u" },
        { tag_name: "autobuild-2026-09-30-13-08", prerelease: false },
      ]),
    );
    expect(r.latest).toBe("autobuild-2026-10-31-13-05");
    expect(r.notes).toBe("u");
  });
  it("github-release with monthEnd: only builds from a month's last day", async () => {
    const r = await latest(
      {
        source: {
          type: "github-release",
          repo: "BtbN/FFmpeg-Builds",
          tagPattern: "^autobuild-",
          monthEnd: true,
        },
      },
      reply([
        { tag_name: "autobuild-2026-10-11-13-04", prerelease: false },
        { tag_name: "autobuild-2026-09-30-13-08", prerelease: false },
        { tag_name: "autobuild-2026-09-29-13-02", prerelease: false },
      ]),
    );
    expect(r.latest).toBe("autobuild-2026-09-30-13-08");
  });
  it("chrome-for-testing: the channel's version", async () => {
    const r = await latest(
      { source: { type: "chrome-for-testing", channel: "Stable" } },
      reply({ channels: { Stable: { version: "153.0.8000.10" } } }),
    );
    expect(r.latest).toBe("153.0.8000.10");
  });
  it("huggingface: the model's current sha", async () => {
    const r = await latest(
      { source: { type: "huggingface", model: "a/b" } },
      reply({ sha: "abc123", lastModified: "2026-10-01" }),
    );
    expect(r.latest).toBe("abc123");
  });
  it("ffmpeg-riedl: the newest release build for the platform, not a snapshot", async () => {
    const html = [
      '<a href="/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip">',
      '<a href="/download/macos/arm64/1791000000_9.0.3/ffmpeg.zip">',
      '<a href="/download/macos/arm64/1792000000_N-127276-g8e9db1f152/ffmpeg.zip">',
      '<a href="/download/linux/amd64/1799000000_9.1.0/ffmpeg.zip">',
    ].join("");
    const r = await latest(
      { source: { type: "ffmpeg-riedl", platform: "macos/arm64" } },
      reply(html),
    );
    expect(r.latest).toBe("1791000000_9.0.3");
  });
  it("openrouter-models: lists models that take images", async () => {
    const r = await latest(
      { source: { type: "openrouter-models" } },
      reply({
        data: [
          { id: "a/vision", architecture: { input_modalities: ["text", "image"] } },
          { id: "b/text", architecture: { input_modalities: ["text"] } },
        ],
      }),
    );
    expect(r.extra.visionModels).toEqual(["a/vision"]);
    expect(r.latest).toBe("1");
  });
  it("turns an error status, an HTML page or an empty answer into Unreachable", async () => {
    const dep = { source: { type: "npm", package: "x" } };
    await expect(latest(dep, reply("oops", 503))).rejects.toBeInstanceOf(Unreachable);
    await expect(latest(dep, reply("<html>error</html>"))).rejects.toBeInstanceOf(Unreachable);
    await expect(latest(dep, reply({}))).rejects.toBeInstanceOf(Unreachable);
    const ff = { source: { type: "ffmpeg-riedl", platform: "macos/arm64" } };
    await expect(latest(ff, reply("<html>maintenance</html>"))).rejects.toBeInstanceOf(Unreachable);
  });
  it("openrouter-models: an empty vision list is a broken answer, not 'every model removed'", async () => {
    await expect(
      latest({ source: { type: "openrouter-models" } }, reply({ data: [] })),
    ).rejects.toBeInstanceOf(Unreachable);
    await expect(
      latest(
        { source: { type: "openrouter-models" } },
        reply({ data: [{ id: "a", architecture: { modalities: "text+image->text" } }] }),
      ),
    ).rejects.toBeInstanceOf(Unreachable);
  });
  it("manual sources are never fetched", async () => {
    await expect(
      latest({ source: { type: "manual", url: "u" } }, () => {
        throw new Error("fetched");
      }),
    ).rejects.toThrow("manual");
  });
});
