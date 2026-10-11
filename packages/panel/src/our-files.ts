// Files the companion made for the timeline, told apart from the editor's own media.

/** A file the companion made: it lives in a job folder (Kilnframe/, or Motion Inserts/ before the rename). */
export function isOurInsert(mediaPath: string): boolean {
  return /[\\/](Kilnframe|Motion Inserts)[\\/]/.test(mediaPath);
}
