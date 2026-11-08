export interface CaptionWord {
  text: string;
  start: number;
  end: number;
  /** #rrggbb; the look's text colour when missing (anything else is ignored). */
  color?: string;
  /** Drawn emphasised, as the doc's emphasis setting says. */
  emphasis?: boolean;
}

export interface CaptionLine {
  start: number;
  end: number;
  text: string;
  words: CaptionWord[];
  /** True when the correction step or a manual edit changed this line's text. */
  changed: boolean;
  /** One emoji drawn centred above the line's block, popping in with it. */
  emoji?: string;
}

export type CaptionStyleId =
  | "kil-lacivert"
  | "loud"
  | "dinamik"
  | "hap"
  | "karaoke"
  | "daktilo"
  | "sakin"
  | "bant"
  | "editoryal";

export interface CaptionColors {
  text: string;
  accent: string;
  box?: string;
}
