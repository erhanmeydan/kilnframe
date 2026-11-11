import { describe, expect, it } from "vitest";
import { repairScene, type ComposeContext } from "../src/stages/compose.js";
import { applyEdits, parseEdits } from "../src/stages/repair-edits.js";
import type { ChatMessage, CompletionRequest, TextProvider } from "../src/providers/types.js";
import type { Scene } from "../src/schemas/plan.js";

const html = `<!doctype html>
<html>
  <body>
    <template>
      <style>
        #s1-title { color: #888; }
      </style>
      <div id="root" data-composition-id="s1">
        <div id="s1-title">Hello</div>
      </div>
      <script>
        const tl = gsap.timeline({ paused: true });
        tl.to("#s1-title", { x: 10 }, 0);
        tl.to("#s1-title", { x: 10 }, 1);
        window.__timelines["s1"] = tl;
      </script>
    </template>
  </body>
</html>
`;

const block = (search: string, replace: string) =>
  `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

describe("parseEdits", () => {
  it("reads every search/replace block of a reply, around prose and fences", () => {
    const reply = `Two fixes:\n\n\`\`\`\n${block("a", "b")}\n\`\`\`\nand\n${block("c\nd", "")}\n`;
    expect(parseEdits(reply)).toEqual([
      { search: "a", replace: "b" },
      { search: "c\nd", replace: "" },
    ]);
  });

  it("finds none in a reply holding the whole file", () => {
    expect(parseEdits(`\`\`\`html\n${html}\`\`\``)).toEqual([]);
  });
});

describe("applyEdits", () => {
  it("applies exact edits in order", () => {
    const r = applyEdits(html, [
      {
        search: "        #s1-title { color: #888; }",
        replace: "        #s1-title { color: #222; }",
      },
      { search: '<div id="s1-title">Hello</div>', replace: '<div id="s1-title">Hi</div>' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain("color: #222;");
    expect(r.html).toContain(">Hi</div>");
    expect(r.html.replace("#222", "#888").replace(">Hi<", ">Hello<")).toBe(html);
  });

  it("matches lines whose indentation the model got wrong", () => {
    const r = applyEdits(html, [
      { search: "#s1-title { color: #888; }", replace: "        #s1-title { color: #222; }" },
    ]);
    expect(r.ok && r.html.includes("        #s1-title { color: #222; }\n")).toBe(true);
  });

  it("refuses a search found nowhere or in two places, and applies nothing", () => {
    const r = applyEdits(html, [
      { search: '<div id="s1-title">Hello</div>', replace: "x" },
      { search: "#s1-subtitle", replace: "y" },
      { search: 'tl.to("#s1-title", { x: 10 }', replace: "z" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toMatch(/edit 2 .*not found/);
    expect(r.problems[1]).toMatch(/edit 3 .*matches 2 places/);
  });
});

const scene = { id: "s1", technique: "kinetic-type" } as Scene;

function provider(replies: string[]) {
  const requests: CompletionRequest[] = [];
  const p: TextProvider = {
    name: "fake",
    model: "fake-1",
    capabilities: { vision: true, structuredOutput: false, contextWindow: 200_000 },
    async complete(req) {
      requests.push({ ...req, messages: [...req.messages] });
      return {
        text: replies.shift() ?? "",
        model: "fake-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  return { p, requests };
}

const lastUserText = (req: CompletionRequest) => {
  const m = req.messages.findLast((x) => x.role === "user");
  return (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
};

const start = (): ChatMessage[] => [
  { role: "user", content: [{ type: "text", text: "write s1" }] },
  { role: "assistant", content: [{ type: "text", text: `\`\`\`html\n${html}\`\`\`` }] },
];

describe("repairScene", () => {
  it("asks for edits and returns the whole repaired file", async () => {
    const { p, requests } = provider([block("color: #888;", "color: #222;")]);
    const reply = await repairScene(
      { provider: p } as ComposeContext,
      scene,
      start(),
      ["low contrast"],
      "repair s1",
      html,
    );
    expect(lastUserText(requests[0] as CompletionRequest)).toMatch(/SEARCH/);
    expect(lastUserText(requests[0] as CompletionRequest)).not.toMatch(/The current file/);
    expect(reply).toMatch(/^```html\n<!doctype html>/);
    expect(reply).toContain("color: #222;");
  });

  it("asks once for the whole file when an edit does not match", async () => {
    const whole = `\`\`\`html\n${html.replace("#888", "#111")}\`\`\``;
    const { p, requests } = provider([block("color: #999;", "color: #222;"), whole]);
    const messages = start();
    const reply = await repairScene(
      { provider: p } as ComposeContext,
      scene,
      messages,
      ["low contrast"],
      "repair s1",
      html,
    );
    expect(requests).toHaveLength(2);
    expect(lastUserText(requests[1] as CompletionRequest)).toMatch(
      /could not be applied.*complete corrected file/s,
    );
    expect(reply).toBe(whole);
  });

  it("takes a whole file the model chose to send instead of edits", async () => {
    const whole = `\`\`\`html\n${html.replace("#888", "#111")}\`\`\``;
    const { p } = provider([whole]);
    const reply = await repairScene(
      { provider: p } as ComposeContext,
      scene,
      start(),
      ["x"],
      "repair s1",
      html,
    );
    expect(reply).toBe(whole);
  });

  it("shows the current file when earlier edits made it newer than the conversation's last file", async () => {
    const current = html.replace("#888", "#222");
    const { p, requests } = provider([block("Hello", "Hi")]);
    const reply = await repairScene(
      { provider: p } as ComposeContext,
      scene,
      start(),
      ["x"],
      "repair s1",
      current,
    );
    expect(lastUserText(requests[0] as CompletionRequest)).toContain("The current file");
    expect(lastUserText(requests[0] as CompletionRequest)).toContain("#222");
    expect(reply).toContain("#222");
    expect(reply).toContain(">Hi<");
  });

  it("asks for the whole file without a current scene or when told to", async () => {
    const { p, requests } = provider(["a", "b"]);
    await repairScene({ provider: p } as ComposeContext, scene, start(), ["x"], "repair s1");
    await repairScene(
      { provider: p, repairWhole: true } as ComposeContext,
      scene,
      start(),
      ["x"],
      "repair s1",
      html,
    );
    for (const r of requests) expect(lastUserText(r)).not.toMatch(/SEARCH/);
  });
});
