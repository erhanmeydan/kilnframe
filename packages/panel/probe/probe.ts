// kilnframe probe panel: one button per open question in docs/premiere-uxp.md.
import type { premierepro } from "@adobe/premierepro";
import { connect, connectionFilePath, readConnection } from "../src/companion";
import { host, setHost } from "../src/host";
import {
  createPremiereHost,
  type FsModule,
  type OsModule,
  type UxpModule,
} from "../src/host-premiere";

// the probe goes through the same host as the panel, so it checks the calls the panel really makes
setHost(
  createPremiereHost(
    require("premierepro") as premierepro,
    require("uxp") as UxpModule,
    require("fs") as FsModule,
    require("os") as OsModule,
  ),
);

const os = require("os") as { homedir(): string };
const fs = require("fs") as {
  writeFile(path: string, data: string, opts: { encoding: string }): Promise<void>;
};

const logEl = document.getElementById("log") as HTMLDivElement;
function log(title: string, data?: unknown) {
  const line =
    data === undefined
      ? title
      : `${title}\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`;
  logEl.textContent = `${line}\n\n${logEl.textContent ?? ""}`;
  // the whole log is also written to ~/.kilnframe/probe/log.txt so it can be read outside Premiere
  fs.writeFile(`${probeDir()}log.txt`, logEl.textContent ?? "", { encoding: "utf-8" }).catch(
    (err: unknown) => {
      logEl.textContent = `log.txt could not be written: ${String(err)}\n\n${logEl.textContent ?? ""}`;
    },
  );
}

function button(id: string, run: () => Promise<void>) {
  document.getElementById(id)?.addEventListener("click", () => {
    run().catch((err: unknown) =>
      log(
        `HATA (${id})`,
        err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
      ),
    );
  });
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value.trim();
}

const probeDir = () => `${os.homedir().replace(/\\/g, "/")}/.kilnframe/probe/`;

button("btn-sequence", async () => {
  log("1. Sekans bilgisi", await host().currentSequence());
});

button("btn-frame", async () => {
  const info = await host().currentSequence();
  const ok = await host().exportFrame(
    info,
    info.inSeconds,
    probeDir(),
    "probe-in.png",
    info.width,
    info.height,
  );
  log("2. Kare dışa aktar", { ok, file: `${probeDir()}probe-in.png`, at: info.inSeconds });
});

button("btn-audio", async () => {
  const preset = inputValue("preset");
  if (!preset) throw new Error("Önce WAV .epr preset yolunu yaz.");
  const seq = await host().currentSequence();
  const out = `${probeDir()}probe-sequence.wav`;
  const { ok } = await host().exportRangeAudio(seq, 0, seq.endSeconds, out, { wavPreset: preset });
  log("3. Ses dışa aktar (tüm sekans)", { ok, out });
});

button("btn-companion", async () => {
  const info = await readConnection();
  log("4. Bağlantı dosyası okundu", {
    path: await connectionFilePath(),
    port: info.port,
    version: info.version,
  });
  for (const host of ["127.0.0.1", "localhost"]) {
    try {
      const client = await connect(host, info, (m) => {
        if (m.type === "system") log(`4. system.check (${host})`, m.report);
      });
      log(`4. ${host} bağlandı`);
      client.send({ type: "system.check" });
      setTimeout(() => client.close(), 15000);
      return;
    } catch (err) {
      log(`4. ${host} başarısız`, err instanceof Error ? err.message : String(err));
    }
  }
});

button("btn-place", async () => {
  const media = inputValue("media");
  if (!media) throw new Error("Önce yerleştirilecek dosyanın yolunu yaz.");
  const info = await host().currentSequence();
  const placed = await host().placeInsert(
    info,
    { video: media, sfx: null },
    info.inSeconds,
    0,
    info.outSeconds - info.inSeconds,
  );
  log("5. Import + yerleştir", {
    at: info.inSeconds,
    ...placed,
    note: "Geri almak için Cmd+Z",
  });
});

// 6. The Motion > Scale question (4K inserts on 8K sequences): what a placed clip's effects are, then setting
// param 1 of Motion to 200 the way the panel does (host-premiere.ts scaleClip)
button("btn-scale", async () => {
  const ppro = require("premierepro") as premierepro;
  const project = await ppro.Project.getActiveProject();
  const sequence = await project.getActiveSequence();
  const count = await sequence.getVideoTrackCount();
  let clip: unknown = null;
  let at = -1;
  for (let i = count - 1; i >= 0 && !clip; i--) {
    const items = (await sequence.getVideoTrack(i)).getTrackItems(
      ppro.Constants.TrackItemType.CLIP,
      false,
    );
    if (items.length) {
      clip = items[0];
      at = i;
    }
  }
  if (!clip) throw new Error("Sekansta video klip yok.");
  const item = clip as {
    getName(): Promise<string>;
    getComponentChain(): Promise<{
      getComponentCount(): number;
      getComponentAtIndex(i: number): {
        getMatchName(): Promise<string>;
        getDisplayName(): Promise<string>;
        getParamCount(): number;
        getParam(i: number): {
          displayName?: string;
          getStartValue(): Promise<unknown>;
          isTimeVarying(): boolean;
          createKeyframe(v: number): unknown;
          createSetValueAction(k: unknown, safe: boolean): unknown;
        };
      };
    }>;
  };
  const chain = await item.getComponentChain();
  const components: unknown[] = [];
  let motion: ReturnType<typeof chain.getComponentAtIndex> | null = null;
  for (let c = 0; c < chain.getComponentCount(); c++) {
    const comp = chain.getComponentAtIndex(c);
    const matchName = await comp.getMatchName();
    if (matchName === "AE.ADBE Motion") motion = comp;
    const params: unknown[] = [];
    for (let i = 0; i < comp.getParamCount(); i++) {
      const param = comp.getParam(i);
      let start: unknown;
      try {
        start = await param.getStartValue();
      } catch (err) {
        start = `HATA ${String(err)}`;
      }
      params.push({ i, name: param.displayName, start, timeVarying: param.isTimeVarying() });
    }
    components.push({ c, matchName, name: await comp.getDisplayName(), params });
  }
  log(`6a. V${at + 1} klibi: ${await item.getName()}`, components);
  if (!motion) throw new Error("Motion bileşeni bulunamadı (AE.ADBE Motion).");
  const param = motion.getParam(1);
  let ok: unknown = null;
  let error: string | null = null;
  try {
    project.lockedAccess(() => {
      ok = project.executeTransaction(
        (compound) =>
          compound.addAction(param.createSetValueAction(param.createKeyframe(200), true) as never),
        "probe: Scale 200",
      );
    });
  } catch (err) {
    error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  }
  log("6b. Motion param 1'e 200 yazıldı mı", {
    param: param.displayName,
    ok,
    error,
    after: await param.getStartValue().catch((e: unknown) => `HATA ${String(e)}`),
  });
});

log("Hazır. Bir sekans aç, in/out işaretle ve butonları sırayla dene.");

// 7. Pause removal spike (S1): what the public trim, clone, move and remove actions really do. Works only on a
// clone of the active sequence, never on the original. Every answer goes to the log.
/* eslint-disable @typescript-eslint/no-explicit-any */
button("btn-pauses", async () => {
  const ppro = require("premierepro") as any;
  const project = await ppro.Project.getActiveProject();
  const source = await project.getActiveSequence();
  if (!source) throw new Error("Önce bir sekans aç.");
  const T = (s: number) => ppro.TickTime.createWithSeconds(s);
  const CLIP = ppro.Constants.TrackItemType.CLIP;
  const run = (what: string, add: (c: any) => void): boolean => {
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction(add, `probe: ${what}`);
    });
    return ok;
  };
  const r = (t: any) => +Number(t?.seconds ?? NaN).toFixed(3);
  const describe = async (item: any) => ({
    name: await item.getName().catch(() => "?"),
    track: await item.getTrackIndex().catch(() => -1),
    start: r(await item.getStartTime()),
    end: r(await item.getEndTime()),
    in: r(await item.getInPoint()),
    out: r(await item.getOutPoint()),
    speed: await item.getSpeed().catch(() => null),
  });
  const items = async (seq: any, kind: "video" | "audio") => {
    const n = kind === "video" ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
    const all: any[] = [];
    for (let i = 0; i < n; i++) {
      const track = kind === "video" ? await seq.getVideoTrack(i) : await seq.getAudioTrack(i);
      all.push(...track.getTrackItems(CLIP, false));
    }
    return all;
  };
  const snapshot = async (seq: any) => ({
    video: await Promise.all((await items(seq, "video")).map(describe)),
    audio: await Promise.all((await items(seq, "audio")).map(describe)),
  });
  const out: Record<string, unknown> = {};

  // 1. clone, found by the guid that was not there before, renamed
  const before = new Set((await project.getSequences()).map((s: any) => s.guid.toString()));
  out.cloneOk = run("clone", (c) => c.addAction(source.createCloneAction()));
  const clone = (await project.getSequences()).find((s: any) => !before.has(s.guid.toString()));
  out.cloneFound = !!clone;
  if (!clone) return log("7. Boşluk denemesi", out);
  try {
    const pi = await clone.getProjectItem();
    out.renameOk = run("rename", (c) =>
      c.addAction(pi.createSetNameAction(`${source.name} probe`)),
    );
  } catch (err) {
    out.rename = String(err);
  }
  await project.openSequence(clone);
  await project.setActiveSequence(clone);
  out.sourceItems = await snapshot(source);
  out.cloneItems = await snapshot(clone);

  const video = await items(clone, "video");
  const v = video[0];
  if (!v) return log("7. Boşluk denemesi (video klip yok)", out);
  const v0 = await describe(v);
  // 2 + 3. set start one second later: trim or slide, and does the linked audio follow?
  out.setStartOk = run("set start", (c) => c.addAction(v.createSetStartAction(T(v0.start + 1))));
  out.afterSetStart = await snapshot(clone);
  // 5. end one second earlier, then back past it into the freed space
  const v1 = await describe(v);
  out.shrinkEndOk = run("shrink end", (c) => c.addAction(v.createSetEndAction(T(v1.end - 1))));
  out.afterShrink = await describe(v);
  out.growEndOk = run("grow end", (c) => c.addAction(v.createSetEndAction(T(v1.end - 0.5))));
  out.afterGrow = await describe(v);
  // 4. clone the item 0.25 s further on the same track, overwrite (isInsert false), for video and for audio
  const editor = ppro.SequenceEditor.getEditor(clone);
  out.cloneItemOk = run("clone item", (c) =>
    c.addAction(editor.createCloneTrackItemAction(v, T(0.25), 0, 0, false, false)),
  );
  out.afterCloneItem = await snapshot(clone);
  const a = (await items(clone, "audio"))[0];
  if (a) {
    out.cloneAudioAlignVideo = run("clone audio align", (c) =>
      c.addAction(editor.createCloneTrackItemAction(a, T(0.5), 0, 0, true, false)),
    );
    out.afterCloneAudio = await snapshot(clone);
  }
  // 6. move to 2 s: absolute (start becomes 2) or a shift (start grows by 2)?
  const m0 = await describe(v);
  out.moveOk = run("move", (c) => c.addAction(v.createMoveAction(T(2))));
  out.moveBefore = m0.start;
  out.moveAfter = (await describe(v)).start;
  // 7. speed of many actions in one transaction: 300 tiny moves back and forth
  const t0 = Date.now();
  out.manyOk = run("many", (c) => {
    for (let i = 0; i < 300; i++) c.addAction(v.createMoveAction(T(i % 2 ? -0.04 : 0.04)));
  });
  out.manyMs = Date.now() - t0;
  // remove with no ripple, then with ripple (a gap closes?)
  out.final = await snapshot(clone);
  // 8. the undocumented calls: only whether they are there
  out.razor = {
    createRazorAllTracksAction: typeof editor.createRazorAllTracksAction,
    createRazorTrackAction: typeof editor.createRazorTrackAction,
    createExtractActionInRange: typeof editor.createExtractActionInRange,
    createLiftActionInRange: typeof editor.createLiftActionInRange,
  };
  log("7. Boşluk denemesi (S1)", out);
});

// 8. Razor spike (Premiere 27): are the razor actions there, do they cut linked clips together, and does a
// ripple removal of the razored piece take its linked audio and close the gap? On a clone only.
button("btn-razor", async () => {
  const ppro = require("premierepro") as any;
  const project = await ppro.Project.getActiveProject();
  const source = await project.getActiveSequence();
  if (!source) throw new Error("Önce bir sekans aç.");
  const T = (s: number) => ppro.TickTime.createWithSeconds(s);
  const CLIP = ppro.Constants.TrackItemType.CLIP;
  const { VIDEO, AUDIO, ANY } = ppro.Constants.MediaType;
  const run = (what: string, add: (c: any) => void): boolean | string => {
    let ok: boolean | string = false;
    try {
      project.lockedAccess(() => {
        ok = project.executeTransaction(add, `probe: ${what}`);
      });
    } catch (err) {
      ok = `HATA ${String(err)}`;
    }
    return ok;
  };
  const r = (t: any) => +Number(t?.seconds ?? NaN).toFixed(3);
  const items = async (seq: any, kind: "video" | "audio") => {
    const n = kind === "video" ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
    const all: any[] = [];
    for (let i = 0; i < n; i++) {
      const track = kind === "video" ? await seq.getVideoTrack(i) : await seq.getAudioTrack(i);
      all.push(...track.getTrackItems(CLIP, false));
    }
    return all;
  };
  const spans = async (seq: any, kind: "video" | "audio") =>
    Promise.all(
      (await items(seq, kind)).map(async (it) => [
        await it.getTrackIndex().catch(() => -1),
        r(await it.getStartTime()),
        r(await it.getEndTime()),
        r(await it.getInPoint()),
      ]),
    );
  const out: Record<string, unknown> = { premiere: ppro.app?.version ?? null };

  const before = new Set((await project.getSequences()).map((s: any) => s.guid.toString()));
  out.cloneOk = run("clone", (c) => c.addAction(source.createCloneAction()));
  const findClone = async () =>
    (await project.getSequences()).find((s: any) => !before.has(s.guid.toString()));
  let clone = await findClone();
  if (!clone) return log("8. Razor denemesi", out);
  const pi = await clone.getProjectItem();
  run("rename", (c) => c.addAction(pi.createSetNameAction(`${source.name} razor probe`)));
  clone = await findClone();
  await project.openSequence(clone);
  await project.setActiveSequence(clone);

  const editor = ppro.SequenceEditor.getEditor(clone);
  out.api = {
    createRazorAllTracksAction: typeof editor.createRazorAllTracksAction,
    createRazorTrackAction: typeof editor.createRazorTrackAction,
  };
  if (typeof editor.createRazorAllTracksAction !== "function") return log("8. Razor denemesi", out);

  const first = (await items(clone, "video"))[0];
  if (!first) return log("8. Razor denemesi (video klip yok)", out);
  const a = r(await first.getStartTime());
  const b = r(await first.getEndTime());
  // a piece in the middle of the first video clip: 40% to 60% of it
  const t1 = +(a + (b - a) * 0.4).toFixed(2);
  const t2 = +(a + (b - a) * 0.6).toFixed(2);
  out.cutAt = [t1, t2];
  out.before = { video: await spans(clone, "video"), audio: await spans(clone, "audio") };

  // razor every video and every audio track at both edges, in one transaction
  const ed1 = ppro.SequenceEditor.getEditor(clone);
  out.razorOk = run("razor", (c) => {
    for (const t of [t1, t2]) {
      c.addAction(ed1.createRazorAllTracksAction(VIDEO, T(t), VIDEO));
      c.addAction(ed1.createRazorAllTracksAction(AUDIO, T(t), VIDEO));
    }
  });
  clone = await findClone();
  out.afterRazor = { video: await spans(clone, "video"), audio: await spans(clone, "audio") };

  // the video piece between t1 and t2, removed with ripple and ANY: does its audio go too, does the gap close?
  let mid: any = null;
  for (const it of await items(clone, "video"))
    if (Math.abs(r(await it.getStartTime()) - t1) < 0.05) mid = it;
  if (!mid) return log("8. Razor denemesi (orta parça bulunamadı)", out);
  const ed2 = ppro.SequenceEditor.getEditor(clone);
  let removeOk: unknown = "seçim yapılamadı";
  ppro.TrackItemSelection.createEmptySelection((sel: any) => {
    sel.addItem(mid, true);
    removeOk = run("ripple remove", (c) =>
      c.addAction(ed2.createRemoveItemsAction(sel, true, ANY, false)),
    );
  });
  out.removeOk = removeOk;
  clone = await findClone();
  out.afterRemove = { video: await spans(clone, "video"), audio: await spans(clone, "audio") };
  out.endBefore = r(await source.getEndTime());
  out.endAfter = r(await clone.getEndTime());
  log("8. Razor denemesi", out);
});
/* eslint-enable @typescript-eslint/no-explicit-any */
