// Drives the panel demo (scripts/serve-panel-demo.mjs) through one real animation and saves a screenshot at
// every step with the point that was clicked, for the promo video and the site:
//   node scripts/record-panel.cjs <outDir> <lang> <style>
// Writes <outDir>/NN-name.png (380x760 at 2x) and <outDir>/steps.json. The job is real: it runs on the
// companion with the provider chosen in the panel's settings.
const { mkdirSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

const root = join(__dirname, "..");
const pptr = readdirSync(join(root, "node_modules", ".pnpm")).find((d) =>
  d.startsWith("puppeteer-core@"),
);
const puppeteer = require(
  join(root, "node_modules", ".pnpm", pptr, "node_modules", "puppeteer-core"),
);

const [outDir, lang = "en", style = "kil-lacivert"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  mkdirSync(outDir, { recursive: true });
  const cache = join(homedir(), ".cache", "puppeteer", "chrome-headless-shell");
  const build = readdirSync(cache).sort().pop();
  const browser = await puppeteer.launch({
    executablePath: join(cache, build, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
  });
  const page = await browser.newPage();
  page.on("console", (m) => /kilnframe|demo/.test(m.text()) && console.log(m.text().slice(0, 160)));
  page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
  await page.setViewport({ width: 380, height: 760, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:8091/?lang=${lang}`, { waitUntil: "networkidle0" });
  await sleep(3000);

  const steps = [];
  let n = 0;
  const shot = async (name, click) => {
    const file = `${String(++n).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: join(outDir, file) });
    steps.push({ file, name, at: Date.now(), click: click ?? null });
    writeFileSync(join(outDir, "steps.json"), JSON.stringify(steps, null, 2));
    console.log("shot", file);
  };
  // clicks the first element matching the selector and returns its centre (CSS pixels)
  const click = async (selector) => {
    const el = await page.waitForSelector(selector, { timeout: 30000 });
    await el.scrollIntoView();
    const box = await el.boundingBox();
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    await el.click();
    return point;
  };
  const has = (selector) => page.$(selector).then(Boolean);

  await shot("home");
  let p = await click('[data-act="settings"]');
  await sleep(1500);
  await shot("settings", p);
  p = await click('[data-act="home"]');
  await sleep(1000);
  await page.evaluate(() => document.scrollingElement && (document.scrollingElement.scrollTop = 0));
  await shot("home-again", p);
  p = await click(`[data-act="style"][data-val="${style}"]`);
  await sleep(1200);
  await shot("style-picked", p);
  p = await click('[data-act="generate"]');
  await sleep(2500);
  await shot("started", p);

  // the job: a screenshot every 20 s until the stills are there
  const started = Date.now();
  while (!(await has('[data-act="approve"]'))) {
    if (Date.now() - started > 25 * 60 * 1000) throw new Error("no stills after 25 minutes");
    await sleep(20000);
    await shot("progress");
  }
  await sleep(1500);
  await shot("review");
  p = await click('[data-act="zoom"]');
  await sleep(1200);
  await shot("still-zoom", p);
  p = await click('[data-act="lb-close"]');
  await sleep(800);
  await shot("review-again", p);
  p = await click('[data-act="approve"]');
  await sleep(2500);
  await shot("rendering", p);

  // render and placement: every 10 s until the panel leaves the progress screen
  const rendering = Date.now();
  for (;;) {
    await sleep(10000);
    const text = await page.evaluate(() => document.body.innerText);
    await shot("render-progress");
    // home.placed / premiere.placeFailed in either language
    if (
      /is on the timeline|timeline'a yerleştirildi|could not be placed|yerleştirilemedi/i.test(text)
    )
      break;
    if (Date.now() - rendering > 15 * 60 * 1000) break;
  }
  await shot("done");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
