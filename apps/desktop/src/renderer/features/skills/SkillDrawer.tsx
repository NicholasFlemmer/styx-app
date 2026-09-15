import { copy, fill, INSTALLABLE_SKILL_HOSTS, type SkillHost, type SkillSummary } from '@styx/core';
import { Banner, Button, Checkbox, ChipGroup, Drawer, Field, Markdown, Tag } from '@styx/ui';
import { useEffect, useRef, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { splitFrontmatter } from './frontmatter';
import { useSkillsStore } from './skills-store';
import s from './SkillDrawer.module.css';

export interface SkillDrawerProps {
  id: string;
  directory: string;
}

type InstallHost = Exclude<SkillHost, 'agents'>;
type Scope = 'global' | 'project';

/**
 * Skill reader (Settings › Skills › Read): the catalogue SKILL.md rendered as markdown, then the install form.
 *
 * Reading comes first on purpose: a skill is instructions an agent will follow with whatever access its grants
 * allow, so Install lives under the text, never beside the catalogue row. "For" is one box per agent CLI (found
 * CLIs pre-checked; already-installed ones locked), "Where" is You / Project.
 */
export function SkillDrawer({ id, directory }: SkillDrawerProps) {
  const popOverlay = useUi((u) => u.popOverlay);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const projectId = useUi((u) => u.projectId);
  const clis = useModel((m) => m.discovery.clis);
  const bump = useSkillsStore((st) => st.bump);
  // Initial focus lands on the (labelled) dialog body, not the ✕, so opening the drawer paints no focus ring.
  const body = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [installed, setInstalled] = useState<readonly SkillSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('global');
  const [picked, setPicked] = useState<readonly InstallHost[]>(() =>
    INSTALLABLE_SKILL_HOSTS.filter((host) => clis.some((c) => c.agent === host && c.found)),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void command('skills.preview', { directory }).then((r) => {
      if (!live) return;
      if (r.ok) setText(r.value.text);
      else setError(r.error.message);
    });
    void command('skills.list', { projectId }).then((r) => {
      if (live && r.ok) setInstalled(r.value.skills);
    });
    return () => {
      live = false;
    };
  }, [directory, projectId]);

  const parsed = text === null ? null : splitFrontmatter(text);
  const name = parsed?.name ?? directory;
  const installedFor = (host: InstallHost): boolean =>
    installed.some((i) => i.directory === directory && i.host === host && i.scope === scope);
  const hosts = picked.filter((host) => !installedFor(host));
  const canInstall = !busy && hosts.length > 0 && (scope === 'global' || projectId !== null);
  const close = () => popOverlay(id);

  const install = async () => {
    if (!canInstall) return;
    setBusy(true);
    setError(null);
    const r = await command('skills.install', {
      directory,
      scope,
      hosts,
      projectId: scope === 'project' ? projectId : null,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    bump();
    close();
    pushOverlay({
      kind: 'toast',
      toast: {
        kind: 'info',
        heading: copy.skills.title,
        title: fill(copy.skills.installedToast, {
          name,
          hosts: hosts.map((host) => copy.skills.hostsShort[host]).join(', '),
        }),
      },
    });
  };

  return (
    <Drawer
      heading={copy.skills.drawerHeading}
      title={<span className={s['title']}>{name}</span>}
      meta={<span className={s['meta']}>{directory}</span>}
      onClose={close}
      escapeEnabled={false}
      initialFocus={body}
      footer={
        <>
          <Button size="footer" variant="primary" disabled={!canInstall} onClick={() => void install()}>
            {busy ? copy.skills.installing : copy.skills.install}
          </Button>
          <Button size="footer" onClick={close}>
            {copy.skills.close}
          </Button>
        </>
      }
    >
      <div ref={body} tabIndex={-1} className={s['body']} data-skill-drawer={directory}>
        {/* The security line: a skill is instructions, so it gets the accent edge a grant request gets. */}
        <Banner tone="info" text={copy.skills.warning} data-skill-warning="true" />
        {error !== null && <Banner tone="error" text={error} onDismiss={() => setError(null)} />}
        {parsed === null ? (
          <span className={['t-label', s['loading']].join(' ')}>{copy.skills.readerLoading}</span>
        ) : (
          <>
            {parsed.description !== null && parsed.description !== '' && (
              <p className={s['description']}>{parsed.description}</p>
            )}
            {/* No `onLink`: a skill's links render as text, never as something to click from inside Styx. */}
            <Markdown text={parsed.body} className={s['markdown'] ?? ''} />
          </>
        )}
        <div className={s['form']}>
          <Field label={copy.skills.installFor}>
            <div role="group" aria-label={copy.skills.installFor} className={s['hosts']}>
              {INSTALLABLE_SKILL_HOSTS.map((host) => {
                const already = installedFor(host);
                return (
                  <Checkbox
                    key={host}
                    label={
                      <span className={s['hostLabel']}>
                        {copy.skills.hosts[host]}
                        {already && <Tag tone="strong">{copy.skills.installedTag}</Tag>}
                      </span>
                    }
                    checked={already || picked.includes(host)}
                    disabled={already || busy}
                    onChange={(next) =>
                      setPicked((prev) => (next ? [...prev, host] : prev.filter((h) => h !== host)))
                    }
                    data-skill-host={host}
                  />
                );
              })}
            </div>
          </Field>
          <Field
            label={copy.skills.installWhere}
            hint={projectId === null ? copy.skills.needsProject : undefined}
          >
            <ChipGroup
              layout="inline"
              size="env"
              aria-label={copy.skills.installWhere}
              title={projectId === null ? copy.skills.needsProject : undefined}
              options={[
                { value: 'global', label: copy.skills.scopes.global },
                { value: 'project', label: copy.skills.scopes.project, disabled: projectId === null },
              ]}
              value={scope}
              onChange={(v) => setScope(v === 'project' ? 'project' : 'global')}
            />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}
