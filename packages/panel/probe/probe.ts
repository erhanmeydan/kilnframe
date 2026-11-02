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
