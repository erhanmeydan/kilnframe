// The one "dependencies" issue: Turkish, grouped, ticks kept from the previous body.
import { bump } from "./versions.mjs";

const SIZE = { patch: "yama", minor: "küçük", major: "büyük", other: "yeni derleme" };
const SEVERITY = {
  critical: "kritik",
  high: "yüksek",
  moderate: "orta",
  low: "düşük",
  info: "bilgi",
};
const GROUPS = [
  ["render", "Render"],
  ["app", "Uygulama"],
];

const ticked = (prev) =>
  new Set([...(prev ?? "").matchAll(/^- \[x\] \*\*([^*]+)\*\*/gim)].map((m) => m[1]));
const box = (id, keep) => `- [${keep.has(id) ? "x" : " "}] **${id}**`;
const stamp = (d) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function issueBody(results, advisories, previousBody, now) {
  const keep = ticked(previousBody);
  const newer = (r) => r.latest && bump(r.dep.current, r.latest) !== "none";
  const out = [`Son kontrol: ${stamp(now)}`, ""];
  if (advisories.length) {
    out.push("## Güvenlik");
    for (const a of advisories)
      out.push(
        `${box(a.package, keep)}: ${a.title} (${SEVERITY[a.severity] ?? a.severity}), düzeltildi: ${a.patched} · [ayrıntı](${a.url})`,
      );
    out.push("");
  }
  for (const [group, title] of GROUPS) {
    const rows = results.filter(
      (r) => r.dep.group === group && r.dep.source.type !== "openrouter-models",
    );
    out.push(`## ${title}`);
    const ups = rows.filter(newer);
    for (const r of ups) {
      const link = r.notes ?? r.dep.notes;
      out.push(
        `${box(r.dep.id, keep)} ${r.dep.current} → ${r.latest} (${SIZE[bump(r.dep.current, r.latest)]})${link ? ` · [notlar](${link})` : ""}${r.dep.follows ? ` · ${r.dep.follows} ile gelir` : ""}`,
      );
    }
    for (const r of rows.filter((r) => r.error))
      out.push(`- Kontrol edilemedi: ${r.dep.id} (${r.error})`);
    if (!ups.length && !rows.some((r) => r.error)) out.push("Yeni sürüm yok.");
    out.push("");
  }
  const dev = results.filter((r) => r.dep.group === "dev" && newer(r));
  out.push("## Geliştirici araçları");
  out.push(
    dev.length
      ? dev.map((r) => `${r.dep.id} ${r.dep.current} → ${r.latest}`).join(", ")
      : "Yeni sürüm yok.",
  );
  out.push("");
  const models = results.find((r) => r.dep.source.type === "openrouter-models");
  const prevList =
    /<!-- openrouter: ([^>]*) -->/
      .exec(previousBody ?? "")?.[1]
      ?.split(",")
      .filter(Boolean) ?? [];
  out.push("## Modeller");
  if (models?.error) out.push(`- Kontrol edilemedi: OpenRouter (${models.error})`);
  else if (models) {
    const list = models.extra.visionModels;
    const { added, removed } = modelChanges(prevList, list);
    const tag = (id) => (models.extra.suggested?.includes(id) ? `${id} (önerilen)` : id);
    out.push(
      `- OpenRouter: görsel okuyan ${list.length} model` +
        (prevList.length
          ? `; yeni: ${added.join(", ") || "yok"}; kalkan: ${removed.map(tag).join(", ") || "yok"}`
          : ""),
    );
  }
  out.push(
    "- Anthropic, OpenAI, Gemini, xAI, MiniMax: Mac'te `pnpm deps:models` ile kontrol edilir",
  );
  if (models && !models.error)
    out.push("", `<!-- openrouter: ${models.extra.visionModels.join(",")} -->`);
  return out.join("\n").trimEnd() + "\n";
}

export function modelChanges(prev, now) {
  return {
    added: now.filter((m) => !prev.includes(m)),
    removed: prev.filter((m) => !now.includes(m)),
  };
}

const strip = (b) => b.replace(/^Son kontrol:.*$/m, "").replace(/^- \[[ x]\]/gim, "- [ ]");
export const sameContent = (a, b) => strip(a) === strip(b);
