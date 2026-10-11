// Where each kind of dependency announces its versions. fetch is passed in: tests never go online.
import { compare, isPrerelease } from "./versions.mjs";

export class Unreachable extends Error {}

async function get(fetch, url, kind) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": "kilnframe-deps-check",
        ...(process.env.GH_TOKEN && url.startsWith("https://api.github.com/")
          ? { authorization: `Bearer ${process.env.GH_TOKEN}` }
          : {}),
      },
    });
  } catch (err) {
    throw new Unreachable(`${url}: ${err.message}`);
  }
  if (!res.ok) throw new Unreachable(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (kind === "text") return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Unreachable(`${url}: not JSON`);
  }
}
const need = (v, what) => {
  if (!v) throw new Unreachable(`no ${what} in the answer`);
  return v;
};
const newest = (vs) =>
  vs
    .filter((v) => !isPrerelease(v))
    .sort(compare)
    .at(-1);

/** "autobuild-2026-09-30-13-08" is from the last day of its month: those builds are kept for two years. */
function isMonthEnd(tag) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(tag);
  if (!m) return false;
  const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  return next.getUTCMonth() !== +m[2] - 1;
}

const READERS = {
  async npm(s, fetch) {
    const d = await get(fetch, `https://registry.npmjs.org/${s.package}`);
    return { latest: need(d["dist-tags"]?.latest, "dist-tags.latest") };
  },
  async "github-release"(s, fetch) {
    const list = await get(fetch, `https://api.github.com/repos/${s.repo}/releases?per_page=100`);
    const re = s.tagPattern ? new RegExp(s.tagPattern) : /\d/;
    const ok = (Array.isArray(list) ? list : []).filter(
      (r) =>
        !r.prerelease && !r.draft && re.test(r.tag_name) && (!s.monthEnd || isMonthEnd(r.tag_name)),
    );
    const tag = need(newest(ok.map((r) => r.tag_name)), "matching release");
    return { latest: tag, notes: ok.find((r) => r.tag_name === tag)?.html_url };
  },
  async "chrome-for-testing"(s, fetch) {
    const d = await get(
      fetch,
      "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json",
    );
    return { latest: need(d.channels?.[s.channel]?.version, `${s.channel} version`) };
  },
  async huggingface(s, fetch) {
    const d = await get(fetch, `https://huggingface.co/api/models/${s.model}`);
    return { latest: need(d.sha, "sha"), extra: { lastModified: d.lastModified } };
  },
  // the build server's front page links every platform's current release and snapshot builds
  async "ffmpeg-riedl"(s, fetch) {
    const html = await get(fetch, "https://ffmpeg.martin-riedl.de/", "text");
    const re = new RegExp(`/download/${s.platform}/(\\d+_\\d+\\.\\d+(?:\\.\\d+)?)/`, "g");
    const id = need(newest([...html.matchAll(re)].map((m) => m[1])), "release build");
    return { latest: id, notes: `https://ffmpeg.martin-riedl.de/info/detail/${s.platform}/${id}` };
  },
  async "openrouter-models"(_s, fetch) {
    const d = await get(fetch, "https://openrouter.ai/api/v1/models");
    const vision = need(d.data, "model list")
      .filter((m) => m.architecture?.input_modalities?.includes("image"))
      .map((m) => m.id)
      .sort();
    return { latest: String(vision.length), extra: { visionModels: vision } };
  },
  async manual(s) {
    throw new Unreachable(`manual: ${s.url}`);
  },
};

export async function latest(dep, fetch = globalThis.fetch) {
  const read = READERS[dep.source.type];
  if (!read) throw new Unreachable(`unknown source type ${dep.source.type}`);
  return read(dep.source, fetch);
}
