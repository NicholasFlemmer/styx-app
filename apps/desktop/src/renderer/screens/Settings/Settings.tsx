import {
  copy,
  fill,
  projectNameOf,
  targetRows,
  type ProjectId,
  type ReadModel,
  type TargetPolicy,
  type TargetRow,
} from '@styx/core';
import {
  Button,
  Label,
  LabelValueRow,
  NavItem,
  Select,
  Table,
  TableCell,
  TableRow,
  Tag,
  TABLE_COLUMNS,
} from '@styx/ui';
import { PROJECT_POLICY_BANNER } from '../../features/banners/BannerStack';
import { cliTargetMeta } from '../../features/modals/modals';
import { AgentsPane } from './AgentsPane';
import { SkillsPane } from './SkillsPane';
import { command } from '../../state/commands';
import { useCopyPlatform, useModel, useNow, useUi } from '../../state/hooks';
import { sectionRows, type SettingsRow } from './rows';
import {
  APP_SECTIONS,
  isProjectSection,
  PROJECT_SECTIONS,
  resolveSection,
  SECTION_LABEL,
  type SettingsSection,
} from './sections';
import s from './Settings.module.css';

const identity = (m: ReadModel): ReadModel => m;

const POLICY_OPTIONS = (['ask-mfa', 'ask', 'always'] as const).map((value) => ({
  value,
  label: copy.targets.policy[value],
}));
const isPolicy = (v: string): v is TargetPolicy => v in copy.targets.policy;


/** Settings (spec §4.6): 220px section nav · header · Targets table or label/value rows. */
export function Settings() {
  const projectId = useUi((u) => u.projectId);
  const rawSection = useUi((u) => u.settingsSection);
  const setSettingsSection = useUi((u) => u.setSettingsSection);
  const model = useModel(identity);

  const section = resolveSection(rawSection);
  const projectName = projectId === null ? copy.empty.noProject : projectNameOf(model, projectId);
  const scope = isProjectSection(section)
    ? fill(copy.settings.scope.project, { project: projectName })
    : copy.settings.scope.app;

  const navGroup = (ids: readonly SettingsSection[]) =>
    ids.map((id) => (
      <NavItem
        key={id}
        dense
        label={SECTION_LABEL[id]}
        inv={section === id}
        onClick={() => setSettingsSection(id)}
        data-settings-nav={id}
      />
    ));

  return (
    <div className={s['screen']} data-settings-section={section}>
      <nav className={s['nav']} aria-label={copy.nav.settings}>
        <Label as="div" className={s['groupHead']}>
          {copy.settings.groups.app}
        </Label>
        {navGroup(APP_SECTIONS)}
        <Label as="div" className={[s['groupHead'], s['groupHeadProject']].join(' ')}>
          {fill(copy.settings.groups.project, { project: projectName })}
        </Label>
        {navGroup(PROJECT_SECTIONS)}
        <div className={s['navFoot']}>
          {copy.settings.footer.file}
          <br />
          {copy.settings.footer.note}
        </div>
      </nav>
      <section className={s['main']} aria-labelledby="settings-title">
        <header className={s['header']}>
          <h2 id="settings-title" className={s['title']}>
            {SECTION_LABEL[section]}
          </h2>
          <Label data-settings-scope="true">{scope}</Label>
        </header>
        {section === 'project:targets' ? (
          <Targets model={model} projectId={projectId} />
        ) : section === 'app:skills' ? (
          <SkillsPane projectId={projectId} />
        ) : section === 'app:agents' ? (
          <AgentsPane>
            <Rows model={model} section={section} projectId={projectId} />
          </AgentsPane>
        ) : (
          <Rows model={model} section={section} projectId={projectId} />
        )}
      </section>
    </div>
  );
}

function Targets({ model, projectId }: { model: ReadModel; projectId: ProjectId | null }) {
  const now = useNow();
  const pushOverlay = useUi((u) => u.pushOverlay);
  const policyBanner = useUi((u) => (projectId === null ? undefined : u.banners[`${PROJECT_POLICY_BANNER}${projectId}`]));
  // The accept is bound to the reviewed file hash (security H-1 TOCTOU): main refuses and re-sets the banner if it changed.
  const policyHash = policyBanner?.action.kind === 'review-project-policy' ? policyBanner.action.hash : null;
  const rows = projectId === null ? [] : targetRows(model, projectId, now);

  const openConnect = () => {
    if (projectId !== null) pushOverlay({ kind: 'modal', modal: 'connect', projectId });
  };
  /** `via gcloud · nic@acme.dev` for CLI-backed targets, null otherwise. */
  const cliMeta = (t: TargetRow): string | null => {
    const target = model.targets.byId[t.targetId];
    return target === undefined ? null : cliTargetMeta(target);
  };
  const onAction = (t: TargetRow) => {
    const grantId = 'grantId' in t.state ? t.state.grantId : undefined;
    if (t.action === copy.targets.actions.revoke && grantId !== undefined) {
      void command('grant.revoke', { grantId, triggeredBy: 'settings' });
      return;
    }
    // Edit / Connect on an existing row reopens the connect modal on that target (CLI targets restart their login).
    const target = model.targets.byId[t.targetId];
    if (projectId !== null && target !== undefined && t.action !== copy.targets.actions.revoke) {
      pushOverlay({ kind: 'modal', modal: 'connect', projectId, provider: target.provider, targetId: target.id });
      return;
    }
    openConnect();
  };
  const onPolicy = (t: TargetRow, value: string) => {
    if (isPolicy(value)) void command('target.setPolicy', { targetId: t.targetId, policy: value });
  };

  const c = copy.targets.columns;
  return (
    <>
      <Table
        columns={TABLE_COLUMNS.targets}
        header={[c.target, c.env, c.policy, c.state, '']}
        rowPad="12px 20px"
        aria-label={copy.settings.project.targets}
      >
        {rows.map((t) => (
          <TableRow key={t.targetId} data-target-id={t.targetId}>
            <TableCell strong>{t.name}</TableCell>
            <TableCell>
              {/* Prototype: the tag is inline inside the cell's line box (baseline-aligned), not flex-centred. */}
              <span className={s['tagLine']}>
                <Tag tone={t.prod ? 'accent' : 'neutral'}>{t.env}</Tag>
              </span>
            </TableCell>
            <TableCell>
              <Select
                aria-label={`${c.policy} · ${t.name} ${t.env}`}
                width={170}
                options={POLICY_OPTIONS}
                value={t.policy}
                onChange={(e) => onPolicy(t, e.currentTarget.value)}
              />
            </TableCell>
            <TableCell mono muted className={s['state']}>
              {t.state.label}
              {cliMeta(t) !== null ? (
                <span className={s['meta']} data-target-meta="cli">
                  {cliMeta(t)}
                </span>
              ) : null}
            </TableCell>
            <TableCell label muted align="end" className={s['actions']}>
              {cliMeta(t) !== null ? (
                <button
                  type="button"
                  className={s['action']}
                  aria-label={`${copy.targets.actions.refresh} · ${t.name} ${t.env}`}
                  onClick={() => void command('target.refresh', { targetId: t.targetId })}
                >
                  {copy.targets.actions.refresh}
                </button>
              ) : null}
              <button
                type="button"
                className={s['action']}
                aria-label={`${t.action} · ${t.name} ${t.env}`}
                onClick={() => onAction(t)}
              >
                {t.action}
              </button>
            </TableCell>
          </TableRow>
        ))}
      </Table>
      {rows.length === 0 ? <p className={s['empty']}>{copy.empty.targets}</p> : null}
      {policyBanner !== undefined && policyHash !== null && projectId !== null ? (
        <div className={s['policyRow']} role="status" data-project-policy="true">
          <span className={s['policyText']}>{policyBanner.text}</span>
          <Button
            variant="secondary"
            size="compact"
            onClick={() => void command('project.policy.accept', { projectId, hash: policyHash })}
          >
            {copy.targets.acceptProjectPolicies}
          </Button>
        </div>
      ) : null}
      <div className={s['connectRow']}>
        <Button variant="dashed" size="regular" onClick={openConnect} disabled={projectId === null}>
          {copy.targets.connectRow}
        </Button>
      </div>
    </>
  );
}

function Rows({
  model,
  section,
  projectId,
}: {
  model: ReadModel;
  section: SettingsSection;
  projectId: ProjectId | null;
}) {
  const platform = useUi((u) => u.platform);
  const copyPlatform = useCopyPlatform();
  const rows = sectionRows(model, section, { projectId, platform, copyPlatform });

  const onChange = (row: SettingsRow, value: string) => {
    const change = row.change;
    switch (change.kind) {
      case 'fixed':
        return;
      case 'app':
        void command('settings.set', { patch: change.patch(value) });
        return;
      case 'project':
        if (projectId !== null) {
          void command('project.settings.set', { projectId, patch: change.patch(value) });
        }
        return;
      case 'policy':
        void command('policy.toggle', { policyId: change.policyId, enabled: value === 'on' });
        return;
      case 'cli-binary':
        void command('detect.setBinary', { agent: change.agent, path: value });
        return;
    }
  };
  const onReset = (row: SettingsRow) => {
    if (row.change.kind === 'project' && projectId !== null) {
      void command('project.settings.reset', { projectId, key: row.change.key });
    }
  };

  return (
    <div className={s['rows']}>
      {rows.map((row) => (
        <LabelValueRow
          key={row.id}
          label={row.label}
          overridden={row.overridden}
          data-settings-row={row.id}
          {...(row.overridden ? { onReset: () => onReset(row) } : {})}
          control={
            <Select
              aria-label={row.label}
              options={[...row.options]}
              value={row.value}
              disabled={row.change.kind === 'project' && projectId === null}
              onChange={(e) => onChange(row, e.currentTarget.value)}
            />
          }
        />
      ))}
    </div>
  );
}
