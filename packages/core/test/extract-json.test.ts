import { describe, expect, it } from "vitest";
import { extractJson } from "../src/prompts.js";

describe("extractJson", () => {
  it("finds the JSON after prose that has braces of its own", () => {
    expect(extractJson('Here is the data for {scene s1}: {"title": "Üç adım", "n": 3}')).toEqual({
      title: "Üç adım",
      n: 3,
    });
  });
  it("still reads a fenced reply and a bare object", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a": {"b": 2}}')).toEqual({ a: { b: 2 } });
  });
  it("says so when there is no JSON at all", () => {
    expect(() => extractJson("no data here {just words}")).toThrow(/no JSON object/i);
  });
});
