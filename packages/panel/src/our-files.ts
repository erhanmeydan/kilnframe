// Files the companion made for the timeline, told apart from the editor's own media.

/** A job folder the companion writes: Kilnframe/, its own .kilnframe/jobs/, or Motion Inserts/ before the rename. */
const JOB_FOLDER = String.raw`[\\/](Kilnframe|\.kilnframe[\\/]jobs|Motion Inserts)[\\/](.+[\\/])?`;

const OUR_INSERT = new RegExp(
  `${JOB_FOLDER}(insert\\.(mov|mp4)|sfx_mix\\.wav|sfx_stems[\\\\/][^\\\\/]+\\.wav|music[\\\\/]s\\d+(-\\d+)?\\.wav)$`,
  "i",
);
const OUR_ANIMATION = new RegExp(`${JOB_FOLDER}insert\\.(mov|mp4)$`, "i");
const OUR_CAPTION = new RegExp(`${JOB_FOLDER}captions-\\d+\\.mov$`, "i");

/**
 * A file the companion delivered: the insert, its sound effects or a Music tab clip, inside a job folder. The file
 * name matters as much as the folder: the editor's own footage can live in a folder named Kilnframe too, and
 * switching its track off for the exports left the audio silent and the frames black (Resolve test, 12 Oct 2026).
 * Caption clips are not among them.
 */
export function isOurInsert(mediaPath: string): boolean {
  return OUR_INSERT.test(mediaPath);
}

/** An animation insert only (insert.mov or insert.mp4): what the captions stay hidden under. */
export function isOurAnimation(mediaPath: string): boolean {
  return OUR_ANIMATION.test(mediaPath);
}

/** A caption clip the Captions tab placed: captions-<n>.mov in a job folder. */
export function isOurCaption(mediaPath: string): boolean {
  return OUR_CAPTION.test(mediaPath);
}
