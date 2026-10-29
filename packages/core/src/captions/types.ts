export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionLine {
  start: number;
  end: number;
  text: string;
  words: CaptionWord[];
  /** True when the correction step or a manual edit changed this line's text. */
  changed: boolean;
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
