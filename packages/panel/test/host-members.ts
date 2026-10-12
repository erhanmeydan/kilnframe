// Every member a Host must have; a helper, not a test file (importing a test file would run its tests twice).
export const HOST_MEMBERS = [
  "currentSequence",
  "exportFrame",
  "exportRangeAudio",
  "exportRangePicture",
  "withoutOurInserts",
  "placeInsert",
  "createStorySequence",
  "pickImages",
  "openUrl",
  "uiLocale",
  "pluginVersion",
  "readTextFile",
  "writeTextFile",
  "fileExists",
  "homedir",
  "platform",
] as const;
