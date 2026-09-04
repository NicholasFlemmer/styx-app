import { appSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from '@styx/core';
import { KvStore } from '../kv';
import type { Db } from '../open';

/** `app_settings` (one row per key) → AppSettings, defaults filled in and validated with the core schema. */
export class SettingsRepo {
  readonly kv: KvStore;
  constructor(db: Db, now: () => number) {
    this.kv = new KvStore(db, 'app_settings', now);
  }

  app(): AppSettings {
    const merged: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS };
    for (const [k, v] of Object.entries(this.kv.all())) if (k in DEFAULT_APP_SETTINGS) merged[k] = v;
    const parsed = appSettingsSchema.safeParse(merged);
    return parsed.success ? parsed.data : DEFAULT_APP_SETTINGS;
  }

  patch(p: { [K in keyof AppSettings]?: AppSettings[K] | undefined }): AppSettings {
    for (const [k, v] of Object.entries(p)) if (v !== undefined) this.kv.set(k, v);
    return this.app();
  }

  isEmpty(): boolean {
    return Object.keys(this.kv.all()).length === 0;
  }
}
