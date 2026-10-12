// The Resolve panel's look: the Premiere page's colours swapped for DaVinci Resolve's own while the Resolve
// build copies the page, and the text set in Open Sans, the font of Resolve's interface. The Premiere page is
// never changed. Resolve's greys and its red-orange were measured from Resolve Studio 21.1.1 (12 Oct 2026).

/** Every grey and blue of the Premiere page, as Resolve's counterpart (page colour: Resolve colour). */
export const RESOLVE_COLOURS = {
  // surfaces, darkest first: the panel, its bars, fields, raised and hovered controls
  "#232323": "#28282e",
  "#262626": "#1f1f23",
  "#2b2b2b": "#212026",
  "#333": "#34333a",
  "#3a3a3a": "#3b3a41",
  "#444": "#47464d",
  // lines and frames
  "#303030": "#2f2e35",
  "#383838": "#35343b",
  "#3f3f3f": "#3a3940",
  "#484848": "#424148",
  "#4a4a4a": "#45444b",
  "#555": "#4e4d54",
  "#5a5a5a": "#55545b",
  "#6a6a6a": "#605f66",
  // text, brightest first
  "#fff": "#ffffff",
  "#f0f0f0": "#ededef",
  "#e6e6e6": "#e2e2e4",
  "#e0e0e0": "#dcdcde",
  "#d6d6d6": "#cfcfd2",
  "#d0d0d0": "#cacacd",
  "#c8c8c8": "#c3c3c6",
  "#bdbdbd": "#b8b8bc",
  "#b5b5b5": "#b0b0b4",
  "#b4b4b4": "#aeaeb2",
  "#aaa": "#a5a5a9",
  "#8f8f8f": "#8e8e93",
  "#8a8a8a": "#88888d",
  "#7a7a7a": "#77777c",
  "#777": "#737378",
  // the accent: Resolve's red-orange of the timeline name and the selection frame
  "#5b8cff": "#e64c3c",
  "#2d64c8": "#cf4636",
  "#9db6ff": "#f08a7e",
  "#26304a": "#3d2a2a",
  "#262b36": "#30282a",
  "#263a63": "#4d2c29",
  "#9aa6c2": "#d4a49d",
  // notes: neutral in Resolve
  "#262a31": "#2e2d33",
  "#353c48": "#3b3a41",
  "#c4cad4": "#c8c8cc",
  "#b9c7e6": "#cfcfd2",
  "#3d4a66": "#4a4950",
};

/** Green, amber and red say what happened; they stay as they are. */
export const STATUS_COLOURS = [
  "#a9e0bd",
  "#2f5a3d",
  "#8fd6a8",
  "#24432f",
  "#9fe0b5",
  "#e0b050",
  "#4a3b1c",
  "#6b5320",
  "#e0a040",
  "#e8a598",
  "#6a3a33",
];

const FONT = `
      @font-face {
        font-family: "Open Sans";
        src: url("fonts/OpenSans-Variable.ttf") format("truetype");
        font-weight: 300 800;
        font-stretch: 75% 100%;
      }
      body,
      button,
      input,
      textarea,
      select {
        font-family: "Open Sans", "Helvetica Neue", sans-serif;
      }
`;

/** The Premiere page dressed for Resolve. */
export function resolveTheme(html) {
  const swapped = html.replace(
    /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi,
    (c) => RESOLVE_COLOURS[c.toLowerCase()] ?? c,
  );
  return swapped.replace("</style>", `${FONT}    </style>`);
}
