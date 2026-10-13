// The Premiere panel in a browser, for screenshots (site, docs, promo video): node scripts/serve-panel-demo.mjs
// then open http://127.0.0.1:8091/?lang=en (or tr). The panel's real code and styles run with stand-ins for
// (UXP draws the panel in the system font, so the page uses it too)
// Premiere (packages/panel/demo/stubs.js) and talk to the running companion. When the panel asks Premiere to
// export audio, frames or the range's picture, this server copies them from a job folder Premiere really
// exported (DEMO_FIXTURE), into the job folder the companion made next to DEMO_PROJECT.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const panel = join(root, "packages", "panel");
const project = resolve(
  process.env.DEMO_PROJECT ?? join(root, "out", "premiere-probe", "motion-insert-probe.prproj"),
);
const fixture = resolve(
  process.env.DEMO_FIXTURE ??
    join(root, "out", "premiere-probe", "Kilnframe", "orjinal-1-20261009-000057"),
);
// the panel may only have files written next to the project, where the companion makes job folders
const writable = dirname(project);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ttf": "font/ttf",
};

const body = (req) =>
  new Promise((ok) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => ok(data ? JSON.parse(data) : {}));
  });
const inside = (path) => normalize(resolve(path)).startsWith(writable);

function copyInto(src, dest) {
  if (!inside(dest)) throw new Error(`refusing to write outside ${writable}: ${dest}`);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

const routes = {
  "/demo/companion": () =>
    JSON.parse(readFileSync(join(homedir(), ".kilnframe", "companion.json"), "utf8")),
  "/demo/exists": ({ path }) => ({ exists: existsSync(path) }),
  "/demo/read": ({ path }) => {
    if (!inside(path)) throw new Error("read outside the project folder");
    return { text: readFileSync(path, "utf8") };
  },
  // audio: the whole sequence (.wav); picture: the range (.mp4)
  "/demo/export": ({ outputPath }) => {
    const src = join(fixture, extname(outputPath) === ".wav" ? "sequence.wav" : "footage.mp4");
    copyInto(src, outputPath);
    return { ok: true };
  },
  "/demo/frame": ({ name, dir }) => {
    const want = join(
      fixture,
      basename(name).endsWith(".png") ? basename(name) : `${basename(name)}.png`,
    );
    const frames = readdirSync(fixture)
      .filter((f) => /^footage-\d+\.png$/.test(f))
      .sort();
    const src = existsSync(want) ? want : join(fixture, frames[0]);
    copyInto(
      src,
      join(dir, basename(name).endsWith(".png") ? basename(name) : `${basename(name)}.png`),
    );
    return { ok: true };
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "POST" && routes[url.pathname]) {
      const out = routes[url.pathname](await body(req));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // the built panel page, with the stand-ins loaded before the panel's script
      // ?theme=resolve: the page as the Resolve build dresses it (colours and Open Sans)
      const resolveLook = url.searchParams.get("theme") === "resolve";
      let page = readFileSync(join(panel, "dist", "index.html"), "utf8");
      if (resolveLook)
        page = (await import("../packages/panel/resolve/theme.mjs")).resolveTheme(page);
      const html = page.replace(
        '<script defer src="./index.js"></script>',
        `${resolveLook ? "" : '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}</style>'}<script>window.KILNFRAME_DEMO=${JSON.stringify({ project })}</script><script src="/demo/stubs.js"></script><script defer src="./index.js"></script>`,
      );
      res.writeHead(200, { "Content-Type": types[".html"] }).end(html);
      return;
    }
    const file = url.pathname.startsWith("/demo/")
      ? join(panel, url.pathname)
      : url.pathname.startsWith("/fonts/")
        ? join(panel, "dist-resolve", normalize(url.pathname))
        : join(panel, "dist", normalize(url.pathname));
    if (!file.startsWith(panel) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (err) {
    console.error(err);
    res
      .writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: String(err) }));
  }
}).listen(8091, "127.0.0.1", () =>
  console.log(`panel demo on http://127.0.0.1:8091 (project ${project})`),
);
