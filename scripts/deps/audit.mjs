// pnpm audit --json: the advisories that affect the installed tree.
export function parseAudit(json) {
  const d = JSON.parse(json || "{}");
  return Object.values(d.advisories ?? {}).map((a) => ({
    package: a.module_name,
    severity: a.severity,
    title: a.title,
    url: a.url,
    patched: a.patched_versions,
  }));
}
