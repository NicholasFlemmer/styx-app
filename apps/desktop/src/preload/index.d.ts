import type { StyxApi } from '@styx/core/ipc/api';
declare global {
  interface Window {
    styx: StyxApi;
  }
}
export {};
