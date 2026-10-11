// What an insert cost, for the line under "The animation is on the timeline": the companion reads the job's
// usage.json (tokens, cost at the model's price, and the list price behind a plan).

export interface JobCost {
  inputTokens: number;
  outputTokens: number;
  /** What the user pays: 0 on a plan, null when the model's price is unknown. */
  costUsd: number | null;
  /** The same tokens at API list prices; what a plan would have cost as API use. */
  listPriceUsd: number | null;
  billing: "plan" | "api";
}

/** 83 bin / 83k, 1,3 milyon / 1.3M. */
export function formatTokens(n: number, turkish: boolean): string {
  if (n >= 1_000_000) {
    const m = (Math.round(n / 100_000) / 10).toFixed(1);
    return turkish ? `${m.replace(".", ",")} milyon` : `${m}M`;
  }
  if (n >= 1000) return turkish ? `${Math.round(n / 1000)} bin` : `${Math.round(n / 1000)}k`;
  return String(n);
}

/** 0,09 $ / $0.09; below a cent, "less than". */
export function formatUsd(usd: number, turkish: boolean): string {
  if (usd < 0.005) return turkish ? "0,01 $'dan az" : "less than $0.01";
  const s = usd.toFixed(2);
  return turkish ? `${s.replace(".", ",")} $` : `$${s}`;
}

const plus = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

/** The parts of a long range add up; one unknown cost makes the sum unknown. */
export function addCosts(a: JobCost | null, b: JobCost | null | undefined): JobCost | null {
  if (!b) return a;
  if (!a) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: plus(a.costUsd, b.costUsd),
    listPriceUsd: plus(a.listPriceUsd, b.listPriceUsd),
    billing: b.billing,
  };
}
