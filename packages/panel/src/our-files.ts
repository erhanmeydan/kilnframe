// Files the companion made for the timeline, told apart from the editor's own media.

/**
 * A file the companion delivered: the insert or its sound effects, inside a job folder (Kilnframe/, or Motion
 * Inserts/ before the rename). The file name matters as much as the folder: the editor's own footage can live in
 * a folder named Kilnframe too, and switching its track off for the exports left the audio silent and the
 * frames black (Resolve test, 12 Oct 2026).
 */
export function isOurInsert(mediaPath: string): boolean {
  return /[\\/](Kilnframe|Motion Inserts)[\\/](.+[\\/])?(insert\.(mov|mp4)|sfx_mix\.wav|sfx_stems[\\/][^\\/]+\.wav)$/i.test(
    mediaPath,
  );
}
