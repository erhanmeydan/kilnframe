import { describe, expect, it } from "vitest";
import { setLang } from "../src/i18n";
import { storyMusicNote } from "../src/story-music";

describe("storyMusicNote", () => {
  it("says nothing when the music was made", () => {
    expect(storyMusicNote(null)).toBe("");
  });
  it("says the story goes on without music", () => {
    setLang("tr");
    expect(storyMusicNote("Lyria failed (500): boom")).toMatch(/müziksiz/);
  });
  it("tells a free tier key to turn on billing", () => {
    setLang("en");
    const note = storyMusicNote("Lyria failed (429): limit: 0 requests per day on Free Tier");
    expect(note).toMatch(/without music/);
    expect(note).toMatch(/billing/);
  });
});
