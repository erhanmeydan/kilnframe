// Scoring a timeline or range with music in sections: plan, make, levels.
export * from "./levels.js";
export * from "./plan.js";
export * from "./write-plan.js";
export { SR as SCORE_SAMPLE_RATE, readAudio, writeAudio } from "./audio-io.js";
export { bakeCrossfade, fade, fitLength } from "./fit.js";
export { alignFinal, findHit } from "./final.js";
export * from "./make.js";
