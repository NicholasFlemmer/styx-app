import { cliInstallSchema, ideInstallSchema, type CliInstall, type IdeInstall } from '@styx/core';
import type { Db } from '../open';
import { asBool, asJson, asStr, placeholders, toBit, toJson, type Raw } from './mappers';

const IDE_COLS =
  'id, kind, product, version, location, launcher, config_dir, is_fallback, imported_json, detected_at';
const CLI_COLS =
  'agent, binary, version, found, auth_state, capabilities_json, checked_at, account, verified_at, verify_error';

export const ideFromRow = (r: Raw): IdeInstall =>
  ideInstallSchema.parse({
    id: String(r['id']),
    kind: String(r['kind']),
    product: String(r['product'] ?? r['kind']),
    version: asStr(r['version']),
    location: r['location'] === '' ? null : asStr(r['location']),
    launcher: asStr(r['launcher']),
    configDir: asStr(r['config_dir']),
    isFallback: asBool(r['is_fallback']),
    // `recentsSource` rides along in imported_json (no schema migration needed).
    recentsSource: asJson<Record<string, unknown>>(r['imported_json'], {})['recentsSource'] ?? null,
    imported: {
      recents: 0,
      keybindings: false,
      theme: false,
      ...Object.fromEntries(
        Object.entries(asJson<Record<string, unknown>>(r['imported_json'], {})).filter(
          ([k]) => k !== 'recentsSource',
        ),
      ),
    },
    detectedAt: Number(r['detected_at']),
  });

export const cliFromRow = (r: Raw): CliInstall =>
  cliInstallSchema.parse({
    agent: String(r['agent']),
    binary: asStr(r['binary']),
    version: asStr(r['version']),
    found: asBool(r['found']),
    authState: String(r['auth_state']),
    capabilities: asJson<Record<string, unknown>>(r['capabilities_json'], {}),
    checkedAt: Number(r['checked_at']),
    account: asStr(r['account']),
    verifiedAt: r['verified_at'] === null || r['verified_at'] === undefined ? null : Number(r['verified_at']),
    verifyError: asStr(r['verify_error']),
  });

/** `ide_installs` + `cli_installs`: the persisted result of DetectService. */
export class DiscoveryRepo {
  private readonly upsertIde;
  private readonly allIdes;
  private readonly delIdes;
  private readonly setFallbackStmt;
  private readonly upsertCli;
  private readonly allClis;
  private readonly getCli;
  private readonly delClis;

  constructor(db: Db) {
    this.upsertIde = db.prepare(
      `INSERT INTO ide_installs (${IDE_COLS}) VALUES (${placeholders(10)})
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, product = excluded.product, version = excluded.version, location = excluded.location, launcher = excluded.launcher,
         config_dir = excluded.config_dir, is_fallback = excluded.is_fallback, imported_json = excluded.imported_json, detected_at = excluded.detected_at`,
    );
    this.allIdes = db.prepare(`SELECT ${IDE_COLS} FROM ide_installs ORDER BY rowid`);
    this.delIdes = db.prepare('DELETE FROM ide_installs');
    this.setFallbackStmt = db.prepare('UPDATE ide_installs SET is_fallback = (kind = ?)');
    this.upsertCli = db.prepare(
      `INSERT INTO cli_installs (${CLI_COLS}) VALUES (${placeholders(10)})
       ON CONFLICT(agent) DO UPDATE SET binary = excluded.binary, version = excluded.version, found = excluded.found, auth_state = excluded.auth_state,
         capabilities_json = excluded.capabilities_json, checked_at = excluded.checked_at, account = excluded.account,
         verified_at = excluded.verified_at, verify_error = excluded.verify_error`,
    );
    this.allClis = db.prepare(`SELECT ${CLI_COLS} FROM cli_installs ORDER BY rowid`);
    this.getCli = db.prepare(`SELECT ${CLI_COLS} FROM cli_installs WHERE agent = ?`);
    this.delClis = db.prepare('DELETE FROM cli_installs');
  }

  ides(): IdeInstall[] {
    return (this.allIdes.all() as Raw[]).map(ideFromRow);
  }

  saveIde(i: IdeInstall): void {
    this.upsertIde.run(
      i.id,
      i.kind,
      i.product,
      i.version,
      i.location ?? '',
      i.launcher,
      i.configDir,
      toBit(i.isFallback),
      toJson({ ...i.imported, recentsSource: i.recentsSource }),
      i.detectedAt,
    );
  }

  replaceIdes(list: IdeInstall[]): void {
    this.delIdes.run();
    for (const i of list) this.saveIde(i);
  }

  setFallback(kind: string | null): void {
    this.setFallbackStmt.run(kind ?? '');
  }

  clis(): CliInstall[] {
    return (this.allClis.all() as Raw[]).map(cliFromRow);
  }

  cli(agent: string): CliInstall | null {
    const r = this.getCli.get(agent) as Raw | undefined;
    return r ? cliFromRow(r) : null;
  }

  saveCli(c: CliInstall): void {
    this.upsertCli.run(
      c.agent,
      c.binary,
      c.version,
      toBit(c.found),
      c.authState,
      toJson(c.capabilities),
      c.checkedAt,
      c.account,
      c.verifiedAt,
      c.verifyError,
    );
  }

  replaceClis(list: CliInstall[]): void {
    this.delClis.run();
    for (const c of list) this.saveCli(c);
  }
}
