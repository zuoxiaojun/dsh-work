/** Sandboxed renderer bridge: fixed methods only, no generic IPC escape hatch. */

import { contextBridge, ipcRenderer } from "electron";

/** Bridge API exposed to the renderer. */
export interface DesktopBridge {
  readonly platform: NodeJS.Platform;
  readonly versions: Promise<{ desktop: string; dsh: string | undefined }>;
  readonly dsh: {
    update(): Promise<{ ok: boolean; version?: string; error?: string; alreadyLatest?: boolean }>;
  };
  readonly desktopUpdate: {
    check(): Promise<{ ok: boolean }>;
  };
  readonly workspace: {
    pickDirectory(): Promise<string | null>;
  };
}

const bridge: DesktopBridge = Object.freeze({
  platform: process.platform,
  versions: ipcRenderer.invoke("dsh-work:get-versions") as Promise<{
    desktop: string;
    dsh: string | undefined;
  }>,
  dsh: Object.freeze({
    update: () =>
      ipcRenderer.invoke("dsh-work:update-dsh") as Promise<{
        ok: boolean;
        version?: string;
        error?: string;
        alreadyLatest?: boolean;
      }>,
  }),
  desktopUpdate: Object.freeze({
    check: () =>
      ipcRenderer.invoke("dsh-work:check-app-update") as Promise<{
        ok: boolean;
      }>,
  }),
  workspace: Object.freeze({
    pickDirectory: () =>
      ipcRenderer.invoke("dsh-work:workspace:pick-directory") as Promise<
        string | null
      >,
  }),
});

contextBridge.exposeInMainWorld("dshWork", bridge);
