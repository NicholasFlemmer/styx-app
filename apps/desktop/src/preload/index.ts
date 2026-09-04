import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  theme: {
    resolved: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('styx:theme:resolved'),
    onResolved: (cb: (t: 'dark' | 'light') => void): (() => void) => {
      const h = (_e: unknown, t: 'dark' | 'light') => cb(t);
      ipcRenderer.on('styx:theme:resolved', h);
      return () => ipcRenderer.off('styx:theme:resolved', h);
    },
  },
};

export type StyxApi = typeof api;
contextBridge.exposeInMainWorld('styx', api);
