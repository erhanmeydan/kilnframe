/** UXP provides CommonJS `require` for host modules (premierepro, uxp, fs, os). */
declare function require(id: string): unknown;
/** The manifest version the panel was built with (vite.config.mjs). */
declare const __PANEL_VERSION__: string;
