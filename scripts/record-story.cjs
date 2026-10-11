// Drives the panel demo through story mode and saves a screenshot at every step, for the site and the promo:
//   node scripts/record-story.cjs <outDir> <lang>
// The story is really written (the AI chosen in the panel) and read aloud (Gemini); Premiere's new sequence
// is a stand-in, so the last screen may say the sequence could not be made.
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

const [outDir, lang = "en"] = process.argv.slice(2);
const topic = {
  en: "How a cup of coffee travels from a farm in Ethiopia to a café counter",
  tr: "Bir fincan kahvenin Etiyopya'daki bir çiftlikten kafe tezgahına yolculuğu",
}[lang];
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
    steps.push({ file, name, click: click ?? null });
    writeFileSync(join(outDir, "steps.json"), JSON.stringify(steps, null, 2));
    console.log("shot", file);
  };
  const click = async (selector) => {
    const el = await page.waitForSelector(selector, { timeout: 30000 });
    await el.scrollIntoView();
    const box = await el.boundingBox();
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    await el.click();
    return point;
  };

  let p = await click('[data-act="tab"][data-val="story"]');
  await sleep(1000);
  await shot("story-tab", p);
  await page.type("#story-brief", topic, { delay: 12 });
  await click('[data-act="story-length"][data-val="30"]');
  await click(`[data-act="story-lang"][data-val="${lang}"]`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);
  await shot("story-form");
  p = await click('[data-act="story-write"]');
  await sleep(1500);
  await shot("story-writing", p);
  await page.waitForSelector("#story-script", { timeout: 6 * 60 * 1000 });
  await sleep(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("story-script");
  // the voices
  const voice = await page.$('[data-act="story-voice"]');
  if (voice) {
    await voice.scrollIntoView();
    await sleep(600);
    await shot("story-voices");
  }
  p = await click('[data-act="story-make"]');
  await sleep(1500);
  await shot("story-make", p);
  const started = Date.now();
  while (Date.now() - started < 6 * 60 * 1000) {
    await sleep(8000);
    await shot("story-making");
    const text = await page.evaluate(() => document.body.innerText);
    if (
      /new sequence|yeni bir sekans|sequence could not|sekans oluşturulamadı|Pick a style and press|stil seçip/i.test(
        text,
      )
    )
      break;
  }
  await shot("story-done");
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
