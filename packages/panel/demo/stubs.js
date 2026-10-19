// The panel in a browser: stand-ins for the host modules UXP gives the panel inside Premiere (premierepro, uxp,
// fs, os), so the real panel code and styles run against the real companion. Used to take screenshots for
// the site, the docs and the promo video (scripts/serve-panel-demo.mjs). Premiere's exports are served from
// a job folder Premiere really exported earlier (the demo server copies its files where the panel asks).
(() => {
  const params = new URLSearchParams(location.search);
  const lang = params.get("lang") || "en";
  const api = (path, body) =>
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${path} ${r.status}`))));
  const missing = (name) =>
    new Proxy(function () {}, {
      get: (_, p) => (p === "then" ? undefined : missing(`${name}.${String(p)}`)),
      apply: () => {
        console.warn(`[demo] not stubbed: ${name}()`);
        return Promise.resolve(undefined);
      },
    });
  const loose = (obj, name) =>
    new Proxy(obj, {
      get: (t, p) => (p in t || p === "then" ? t[p] : missing(`${name}.${String(p)}`)),
    });

  // the sequence the panel sees: 25 fps 1080p, in 00:01, out 00:07, like the test project
  const TICKS = 254016000000;
  const fps = Number(params.get("fps") || 25);
  const seq = {
    in: Number(params.get("in") || 1),
    out: Number(params.get("out") || 7),
    end: Number(params.get("end") || 10.84),
  };
  const tick = (s) => ({
    seconds: s,
    ticks: String(Math.round(s * TICKS)),
    ticksNumber: Math.round(s * TICKS),
  });
  const track = () =>
    loose(
      {
        isMuted: async () => false,
        setMute: async () => true,
        getTrackItems: () => [],
      },
      "track",
    );
  const sequence = loose(
    {
      name: params.get("seq") || "orjinal-1",
      guid: { toString: () => "demo-sequence-guid" },
      getSettings: async () =>
        loose(
          {
            getVideoFrameRate: async () => ({ ticksPerFrame: TICKS / fps, value: fps }),
            getVideoFrameRect: async () => ({ width: 1920, height: 1080 }),
            getVideoPixelAspectRatio: async () => 1,
          },
          "settings",
        ),
      getInPoint: async () => tick(seq.in),
      getOutPoint: async () => tick(seq.out),
      getEndTime: async () => tick(seq.end),
      getTimebase: async () => String(TICKS / fps),
      getVideoTrackCount: async () => 3,
      getAudioTrackCount: async () => 3,
      getVideoTrack: async () => track(),
      getAudioTrack: async () => track(),
    },
    "sequence",
  );
  // the Kilnframe bin: what the panel imports shows up in it, as in Premiere
  const binItems = [];
  const bin = { name: "Kilnframe", getItems: async () => binItems };
  const project = loose(
    {
      path:
        params.get("project") || window.KILNFRAME_DEMO?.project || "/Users/demo/Interview.prproj",
      getActiveSequence: async () => sequence,
      getSequences: async () => [sequence],
      getRootItem: async () => loose({ getItems: async () => [bin] }, "root"),
      lockedAccess: (fn) => fn(),
      executeTransaction: (fn) => {
        fn(loose({ addAction: () => true }, "compound"));
        return true;
      },
      importFiles: async (paths) => {
        for (const path of paths) binItems.push({ name: path.split("/").pop(), path });
        return true;
      },
    },
    "project",
  );

  const premierepro = loose(
    {
      Project: { getActiveProject: async () => project },
      TickTime: { createWithSeconds: tick, TIME_ONE_SECOND: tick(1) },
      WorkAreaUtils: {
        getWorkAreaInPoint: () => tick(seq.in),
        getWorkAreaOutPoint: () => tick(seq.out),
        setWorkAreaInOutPoints: () => true,
      },
      Constants: { ExportType: { IMMEDIATELY: 0 }, TrackItemType: { CLIP: 1 } },
      EncoderManager: {
        getManager: () => ({
          exportSequence: async (_s, _t, outputPath) =>
            (await api("/demo/export", { outputPath })).ok,
        }),
      },
      Exporter: {
        exportSequenceFrame: async (_s, time, name, dir) =>
          (await api("/demo/frame", { seconds: time.seconds, name, dir })).ok,
      },
      ClipProjectItem: {
        cast: (x) => loose({ getMediaFilePath: async () => x?.path ?? "", ...x }, "clip"),
      },
      FolderItem: { cast: (x) => x ?? bin },
      SequenceEditor: {
        getEditor: () =>
          loose(
            { createOverwriteItemAction: () => ({}), createInsertProjectItemAction: () => ({}) },
            "editor",
          ),
      },
      RectF: function () {},
    },
    "premierepro",
  );

  const fs = {
    readFile: async (path) => {
      if (/companion\.json$/.test(path)) return JSON.stringify(await api("/demo/companion"));
      return (await api("/demo/read", { path })).text;
    },
    writeFile: async () => undefined,
    lstat: async (path) => {
      if (!(await api("/demo/exists", { path })).exists) throw new Error("ENOENT");
      return {};
    },
  };

  const modules = {
    premierepro,
    fs: loose(fs, "fs"),
    os: { homedir: () => "/Users/demo" },
    uxp: loose(
      {
        host: { uiLocale: lang === "tr" ? "tr_TR" : "en_US" },
        shell: { openExternal: async (url) => console.log("[demo] open", url) },
        storage: { localFileSystem: { getFileForOpening: async () => null } },
      },
      "uxp",
    ),
  };
  window.require = (name) => modules[name] ?? missing(name);
})();
