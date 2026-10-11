#!/usr/bin/env node
// Which suggested models a provider no longer offers, read with the keys the app keeps in the keychain.
// No key is ever printed. Usage: pnpm deps:models (build the core and companion first).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OsKeyStore } from "../packages/companion/dist/keys.js";
import { createTextProvider, loadDefaults } from "../packages/core/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { providers } = JSON.parse(
  readFileSync(join(root, "packages/core/config/providers.json"), "utf8"),
);
const keys = new OsKeyStore();

// LM Studio is local, OpenRouter is checked weekly on GitHub without a key
for (const p of providers.filter((p) => !["lmstudio", "openrouter"].includes(p.id))) {
  const apiKey = await keys.get(p.id).catch(() => undefined);
  if (!apiKey) {
    console.log(`${p.displayName}: anahtar yok, kontrol edilmedi`);
    continue;
  }
  try {
    const provider = createTextProvider(loadDefaults(), { provider: p.id, apiKey });
    // Gemini names its models "models/<id>"
    const listed = (await provider.listModels()).map((m) => m.id.replace(/^models\//, ""));
    const missing = p.models.filter((m) => !listed.includes(m));
    console.log(
      `${p.displayName}: ${listed.length} model; ${
        missing.length
          ? `listede olmayan önerilen modeller: ${missing.join(", ")}`
          : "önerilen modellerin hepsi duruyor"
      }`,
    );
  } catch (err) {
    console.log(`${p.displayName}: kontrol edilemedi (${String(err.message).split("\n")[0]})`);
  }
}
