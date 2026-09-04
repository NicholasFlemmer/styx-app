import type { StyxApi } from './index';
declare global {
  interface Window {
    styx: StyxApi;
  }
}
export {};
