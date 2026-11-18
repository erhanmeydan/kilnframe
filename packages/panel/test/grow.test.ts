import { describe, expect, it } from "vitest";
import { GROW_MAX_PX, estimatedHeight, grow, grownHeight } from "../src/grow";

describe("grownHeight", () => {
  it("keeps the starting height for short text", () => {
    expect(grownHeight(54, 40)).toBe(54);
  });
  it("follows longer text up to the cap", () => {
    expect(grownHeight(54, 130)).toBe(130);
    expect(grownHeight(54, 900)).toBe(GROW_MAX_PX);
  });
  it("lets a box that starts tall reach twice its height", () => {
    expect(grownHeight(260, 900)).toBe(520);
  });
});

/** A textarea as far as grow() looks at it (the panel tests run without a DOM). */
function box(
  cls: string,
  offset: number,
  scroll: number,
  tag = "TEXTAREA",
  value = "",
  width = 358,
) {
  const attrs = new Map<string, string>();
  return {
    tagName: tag,
    classList: { contains: (c: string) => c === cls },
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    hasAttribute: (k: string) => attrs.has(k),
    style: { height: "" },
    offsetHeight: offset,
    clientHeight: offset ? offset - 2 : 0,
    scrollHeight: scroll,
    clientWidth: width,
    value,
  };
}
const asEl = (b: ReturnType<typeof box>) => b as unknown as Element;

describe("grow", () => {
  it("makes a multi-line box as tall as its text", () => {
    const el = box("three", 54, 120);
    grow(asEl(el));
    expect(el.style.height).toBe("122px");
    expect(el.getAttribute("data-base-height")).toBe("54");
  });
  it("never shrinks a box below where it started", () => {
    const el = box("", 48, 20);
    grow(asEl(el));
    expect(el.style.height).toBe("48px");
  });
  it("leaves one-line boxes and other elements alone", () => {
    const one = box("one", 28, 200);
    grow(asEl(one));
    expect(one.style.height).toBe("");
    grow(asEl(box("", 40, 400, "DIV")));
  });
  it("skips a box that is not laid out yet", () => {
    const el = box("", 0, 0);
    grow(asEl(el));
    expect(el.hasAttribute("data-base-height")).toBe(false);
  });
});

describe("estimatedHeight", () => {
  it("matches what Premiere drew: 1216 characters at 358 px are 24 lines", () => {
    expect(estimatedHeight("okbu da ".repeat(152), 358)).toBe(24 * 15 + 8);
  });
  it("counts each paragraph from a new line", () => {
    expect(estimatedHeight("a\nb\n\nc", 358)).toBe(4 * 15 + 8);
  });
});

describe("grow where the host reports no scroll height (Premiere)", () => {
  it("grows from the estimate", () => {
    const el = box("three", 54, 0, "TEXTAREA", "okbu da ".repeat(40));
    grow(asEl(el));
    expect(el.style.height).toBe(`${estimatedHeight("okbu da ".repeat(40), 358)}px`);
  });
  it("stays put with short or no text", () => {
    const short = box("three", 54, 0, "TEXTAREA", "kısa");
    grow(asEl(short));
    expect(short.style.height).toBe("54px");
    const empty = box("", 48, 0);
    grow(asEl(empty));
    expect(empty.style.height).toBe("48px");
  });
});
