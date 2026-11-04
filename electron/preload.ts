import { contextBridge, ipcRenderer, webUtils } from 'electron';

const EVENTS = new Set(['state', 'downloads', 'toast', 'deployed', 'plan', 'update']);

contextBridge.exposeInMainWorld('lattice', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('lattice:call', method, args),
  downloads: (action: string, id?: string) => ipcRenderer.invoke('lattice:downloads', action, id),
  dialog: (kind: string, defaultName?: string) => ipcRenderer.invoke('lattice:dialog', kind, defaultName),
  openExternal: (url: string) => ipcRenderer.invoke('lattice:external', url),
  openPath: (p: string) => ipcRenderer.invoke('lattice:openPath', p),
  fileIcon: (p: string) => ipcRenderer.invoke('lattice:icon', p),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  setTheme: (t: string) => ipcRenderer.invoke('lattice:theme', t),
  update: (action: string) => ipcRenderer.invoke('lattice:update', action),
  on: (event: string, cb: (payload: unknown) => void) => {
    if (!EVENTS.has(event)) return () => undefined;
    const h = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(`lattice:${event}`, h);
    return () => ipcRenderer.removeListener(`lattice:${event}`, h);
  },
});
