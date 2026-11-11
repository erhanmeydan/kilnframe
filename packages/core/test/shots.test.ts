import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedShooter, projectHash } from "../src/shots.js";

let dir: string;
const project = () => join(dir, "project");
const shots = () => join(dir, "shots");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kilnframe-shots-"));
  mkdirSync(join(project(), "compositions"), { recursive: true });
  mkdirSync(shots(), { recursive: true });
  writeFileSync(join(project(), "index.html"), "<html></html>");
  writeFileSync(join(project(), "compositions", "s1.html"), "<template>a</template>");
  for (const f of ["a.png", "b.png"]) writeFileSync(join(shots(), f), "png");
  writeFileSync(
    join(shots(), "shots.json"),
    JSON.stringify({
      hash: projectHash(project()),
      files: { "1.000": join(shots(), "a.png"), "2.500": join(shots(), "b.png") },
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fallback = async (times: number[]) => times.map((t) => `fresh-${t}`);

describe("cachedShooter", () => {
  it("serves the recorded frames of an unchanged project, in the order asked", async () => {
    const shoot = cachedShooter(project(), shots(), fallback);
    expect(await shoot?.([2.5, 1])).toEqual([join(shots(), "b.png"), join(shots(), "a.png")]);
  });

  it("takes fresh frames for a time it does not hold", async () => {
    const shoot = cachedShooter(project(), shots(), fallback);
    expect(await shoot?.([1, 3])).toEqual(["fresh-1", "fresh-3"]);
  });

  it("is not used once a scene changed", () => {
    writeFileSync(join(project(), "compositions", "s1.html"), "<template>b</template>");
    expect(cachedShooter(project(), shots(), fallback)).toBeNull();
  });

  it("is not used without shots", () => {
    rmSync(shots(), { recursive: true });
    expect(cachedShooter(project(), shots(), fallback)).toBeNull();
  });
});
