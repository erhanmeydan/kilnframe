// kilnframe probe panel: one button per open question in docs/premiere-uxp.md.
import { connect, connectionFilePath, readConnection } from "../src/companion";
import {
  activeSequence,
  exportFrame,
  exportSequenceAudio,
  importToBin,
  placeItem,
  sequenceInfo,
} from "../src/premiere";

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
  const { sequence } = await activeSequence();
  log("1. Sekans bilgisi", await sequenceInfo(sequence));
});

button("btn-frame", async () => {
  const { sequence } = await activeSequence();
  const info = await sequenceInfo(sequence);
  const ok = await exportFrame(
    sequence,
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
  const { sequence } = await activeSequence();
  const out = `${probeDir()}probe-sequence.wav`;
  const ok = await exportSequenceAudio(sequence, out, preset, true);
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
  const { project, sequence } = await activeSequence();
  const info = await sequenceInfo(sequence);
  const item = await importToBin(project, media);
  const ok = placeItem(project, sequence, item, info.inSeconds, info.videoTracks, info.audioTracks);
  log("5. Import + yerleştir", {
    ok,
    at: info.inSeconds,
    videoTrack: info.videoTracks,
    audioTrack: info.audioTracks,
    note: "Geri almak için Cmd+Z",
  });
});

log("Hazır. Bir sekans aç, in/out işaretle ve butonları sırayla dene.");
