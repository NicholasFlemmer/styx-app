import { copy, type ProjectId, type SkillSummary } from '@styx/core';
import { Button, Tag } from '@styx/ui';
import { useCallback, useEffect, useState } from 'react';
import { command } from '../../state/commands';
import s from './SkillsPane.module.css';

type Scope = 'global' | 'project';

/**
 * Skills, browsable and installable in place rather than through the CLI.
 *
 * A skill is instruction text an agent will follow while holding this project's grants, so the catalogue side
 * deliberately makes reading it a step: Read first opens the SKILL.md, and Install is only offered once it is on
 * screen. The catalogue is a pinned repository, not a user-supplied URL.
 */
export function SkillsPane({ projectId }: { projectId: ProjectId | null }) {
  const [installed, setInstalled] = useState<SkillSummary[]>([]);
  const [cat, setCat] = useState<SkillSummary[] | null>(null);
  const [catError, setCatError] = useState<string | null>(null);
  const [reading, setReading] = useState<{ directory: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void command('skills.list', { projectId }).then((r) => {
      if (r.ok) setInstalled(r.value.skills);
    });
  }, [projectId]);

  useEffect(refresh, [refresh]);

  const browse = () => {
    setCatError(null);
    void command('skills.catalogue', {}).then((r) => {
      if (r.ok) setCat(r.value.skills);
      else setCatError(r.error.message);
    });
  };

  const read = (directory: string) => {
    void command('skills.preview', { directory }).then((r) => {
      if (r.ok) setReading({ directory, text: r.value.text });
      else setCatError(r.error.message);
    });
  };

  const install = (directory: string, scope: Scope) => {
    setBusy(directory);
    void command('skills.install', { directory, scope, hosts: ['claude'], projectId }).then((r) => {
      setBusy(null);
      if (r.ok) {
        setReading(null);
        refresh();
      } else setCatError(r.error.message);
    });
  };

  const remove = (skill: SkillSummary) => {
    if (skill.scope === 'catalogue' || skill.host === null) return;
    void command('skills.remove', {
      directory: skill.directory,
      scope: skill.scope,
      host: skill.host,
      projectId,
    }).then(refresh);
  };

  const isInstalled = (directory: string) => installed.some((i) => i.directory === directory);

  return (
    <div className={s['pane']} data-skills-pane="true">
      <div className={s['section']}>
        <span className="t-label">{copy.skills.installed}</span>
        {installed.length === 0 && <div className={s['empty']}>{copy.skills.empty}</div>}
        {installed.map((skill) => (
          <div key={`${skill.scope}:${skill.directory}`} className={s['row']} data-skill={skill.directory}>
            <div className={s['head']}>
              <span className={s['name']}>{skill.name}</span>
              <Tag tone="neutral">{copy.skills.scopes[skill.scope]}</Tag>
            </div>
            <span className={s['desc']}>{skill.description}</span>
            <Button size="compact" variant="secondary" onClick={() => remove(skill)}>
              {copy.skills.remove}
            </Button>
          </div>
        ))}
      </div>

      <div className={s['section']}>
        <div className={s['head']}>
          <span className="t-label">{copy.skills.scopes.catalogue}</span>
          <Button size="compact" variant="secondary" onClick={browse}>
            {copy.skills.browse}
          </Button>
        </div>
        <div className={s['warning']}>{copy.skills.warning}</div>
        {catError !== null && <div className={s['error']}>{catError}</div>}
        {cat !== null && cat.length === 0 && <div className={s['empty']}>{copy.skills.catalogueEmpty}</div>}
        {(cat ?? []).map((skill) => (
          <div key={skill.directory} className={s['row']} data-catalogue-skill={skill.directory}>
            <div className={s['head']}>
              <span className={s['name']}>{skill.name}</span>
              {isInstalled(skill.directory) && <Tag tone="accent">{copy.skills.installed}</Tag>}
            </div>
            <span className={s['desc']}>{skill.description}</span>
            <div className={s['actions']}>
              <Button size="compact" variant="secondary" onClick={() => read(skill.directory)}>
                {copy.skills.read}
              </Button>
              {/* Install is only offered for the skill currently on screen: reading it is the point. */}
              {reading?.directory === skill.directory && (
                <>
                  <Button
                    size="compact"
                    variant="primary"
                    disabled={busy === skill.directory}
                    onClick={() => install(skill.directory, 'global')}
                  >
                    {copy.skills.installedTo.global}
                  </Button>
                  {projectId !== null && (
                    <Button
                      size="compact"
                      variant="secondary"
                      disabled={busy === skill.directory}
                      onClick={() => install(skill.directory, 'project')}
                    >
                      {copy.skills.installedTo.project}
                    </Button>
                  )}
                </>
              )}
            </div>
            {reading?.directory === skill.directory && (
              <pre className={s['read']} data-skill-text="true">
                {reading.text}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
