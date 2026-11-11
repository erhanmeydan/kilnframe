import { describe, expect, it } from "vitest";
import { staticSceneProblems } from "../src/index.js";

const scene = (body: string, js: string, css = "") =>
  `<template><div data-composition-id="s1" data-width="1920" data-height="1080">${css ? `<style>${css}</style>` : ""}${body}<script>${js}\nwindow.__timelines["s1"] = tl;</script></div></template>`;

const problems = (html: string, overlay = false) =>
  staticSceneProblems(html, "s1", [], overlay).join("\n");

describe("static scene rules", () => {
  it("lets a code scene show the calls it may not make", () => {
    const shown = scene(
      `<pre id="s1-code">const r = await fetch("https://api.example.com/users");
setTimeout(() => render(), 100); const id = Math.random(); const t = new Date(); video.play();</pre>`,
      `const lines = ['fetch("https://api.example.com")', "setTimeout(tick, 16)", \`Date.now() = \${n}\`];
// no requestAnimationFrame here
const re = /setInterval\\(/; const tl = gsap.timeline({ paused: true });`,
    );
    expect(problems(shown)).toBe("");
  });

  it("lets a mockup type a web address into its address bar", () => {
    const bar = scene(
      `<div id="s1-bar"></div>`,
      `const tl = gsap.timeline({ paused: true }); document.getElementById("s1-bar").textContent = "https://kilnframe.com";`,
    );
    expect(problems(bar)).toBe("");
  });

  it("still catches what runs or loads", () => {
    const run = (js: string) =>
      problems(scene("", `const tl = gsap.timeline({ paused: true }); ${js}`));
    expect(run("const x = Math.random();")).toMatch(/Math.random/);
    expect(run("const t = Date.now();")).toMatch(/clock/);
    expect(run(`setTimeout(() => {}, 10);`)).toMatch(/timer/);
    expect(run(`const s = \`\${Math.random()}\`;`)).toMatch(/Math.random/);
    expect(run(`tl.play();`)).toMatch(/play\(\)/);
    expect(run(`fetch("https://api.example.com/data.json");`)).toMatch(/network/);
    expect(run(`new THREE.TextureLoader().load("https://cdn.example.com/t.png");`)).toMatch(
      /network/,
    );
    expect(run(`img.src = "https://cdn.example.com/a.png";`)).toMatch(/network/);
    expect(run(`el.innerHTML = '<img src="https://cdn.example.com/a.png">';`)).toMatch(/network/);
    expect(run(`import("https://cdn.example.com/m.js");`)).toMatch(/network/);
    expect(run(`tl.set(el, { visibility: "visible" });`)).toMatch(/use opacity/);
  });

  it("catches network loads in markup and CSS, not in shown text", () => {
    expect(problems(scene(`<img src="https://cdn.example.com/a.png">`, ""))).toMatch(/network/);
    expect(problems(scene("", "", "#s1-a { background: url(https://x.example/b.png) }"))).toMatch(
      /network/,
    );
    expect(problems(scene(`<p id="s1-p">Visit https://kilnframe.com</p>`, ""))).toBe("");
    expect(problems(scene(`<svg xmlns="http://www.w3.org/2000/svg" id="s1-svg"></svg>`, ""))).toBe(
      "",
    );
  });

  it("looks for grain in an overlay's layers, not in its words", () => {
    expect(problems(scene(`<p id="s1-p">A grain of rice</p>`, ""), true)).toBe("");
    expect(problems(scene(`<div id="s1-grain"></div>`, ""), true)).toMatch(/haze/);
    expect(
      problems(
        scene("", `const tl = gsap.timeline({ paused: true }); el.className = "grain";`),
        true,
      ),
    ).toMatch(/haze/);
    // a noise filter the script writes into the page
    const written = scene(
      `<svg id="s1-svg"></svg>`,
      'const tl = gsap.timeline({ paused: true }); svg.innerHTML = `<filter id="s1-f"><feTurbulence seed="${seed}"/></filter>`;',
    );
    expect(problems(written, true)).toMatch(/haze/);
  });
});
