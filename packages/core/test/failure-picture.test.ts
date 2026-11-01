import { describe, expect, it } from "vitest";
import { pictureFilter, pictureFinding, type CheckFinding } from "../src/index.js";

const overlap: CheckFinding = {
  code: "content_overlap",
  severity: "error",
  message: "Two text blocks overlap and may render unreadable.",
  time: 20.4,
  rect: { left: 290, top: 1845, width: 719.5, height: 96 },
};

describe("pictureFinding", () => {
  it("takes the first finding that names a place on the frame", () => {
    const haze: CheckFinding = {
      code: "overlay_faint_layer",
      severity: "error",
      message: "",
      time: 3,
    };
    expect(pictureFinding([haze, overlap])).toBe(overlap);
  });

  it("has nothing to show for findings without a place", () => {
    expect(pictureFinding([{ severity: "error", message: "lint", time: 1 }])).toBeNull();
    expect(
      pictureFinding([{ ...overlap, rect: { left: 0, top: 0, width: 0, height: 0 } }]),
    ).toBeNull();
  });
});

describe("pictureFilter", () => {
  it("frames the place a little outside it and scales a portrait frame by its height", () => {
    expect(pictureFilter(overlap.rect!, { width: 2160, height: 3840 })).toBe(
      "drawbox=x=220:y=1775:w=860:h=236:color=0xE5484D:t=35,scale=-2:'min(720,ih)'",
    );
  });

  it("keeps the frame inside the picture and scales a landscape frame by its width", () => {
    expect(
      pictureFilter({ left: 1900, top: 0, width: 100, height: 50 }, { width: 1920, height: 1080 }),
    ).toBe("drawbox=x=1866:y=0:w=54:h=118:color=0xE5484D:t=17,scale='min(720,iw)':-2");
  });
});
