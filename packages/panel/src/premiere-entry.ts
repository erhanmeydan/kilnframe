// Installs the Premiere Pro host. index.ts imports this before the app, so the host is there when it starts.
import type { premierepro } from "@adobe/premierepro";
import { setHost } from "./host";
import { createPremiereHost, type FsModule, type OsModule, type UxpModule } from "./host-premiere";

setHost(
  createPremiereHost(
    require("premierepro") as premierepro,
    require("uxp") as UxpModule,
    require("fs") as FsModule,
    require("os") as OsModule,
  ),
);
