import { copy, type ProjectId, type TargetId } from '@styx/core';
import { Button, Icon, StatusDot, Tag } from '@styx/ui';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useModel, useUi } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { startLearnDeploy } from '../abilities/learn';
import { deployButtonState } from './deploy-button';
import s from './DeployButton.module.css';

export interface DeployButtonProps {
  projectId: ProjectId;
}

/**
 * "Deploy to live · Vercel prod" at the right end of the workspace mode strip (owner request: a deploy button
 * that says where it deploys). One prod target → the accent button starts it; several → a small picker (the
 * rail "+" menu recipe); a deploy in flight → the label reports it with a blinking dot and click re-opens its
 * output. Everything it shows comes from `model.deploys`, so closing the modal loses nothing.
 *
 * A target Styx has no command for yet is not greyed out (owner principle, AI-native): the click hands the first
 * deploy to the project's agent in chat, which deploys under a grant and teaches Styx the command for next time.
 */
export function DeployButton({ projectId }: DeployButtonProps) {
  const learning = useUi((u) => u.learning);
  const state = useModel(
    useCallback((m) => deployButtonState(m, projectId, learning), [projectId, learning]),
  );
  const pushOverlay = useUi((u) => u.pushOverlay);
  const openSession = useUi((u) => u.openSession);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Outside clicks close the picker without focus return; Esc / Tab close it and hand focus back to the button.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const closeMenu = (refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const start = (targetId: TargetId, learn: boolean) => {
    if (!learn) {
      pushOverlay({ kind: 'modal', modal: 'deploy', targetId });
      return;
    }
    const model = useReadModel.getState().model;
    const target = model.targets.byId[targetId];
    if (target !== undefined) void startLearnDeploy(model, target);
  };
  const choose = (o: { targetId: TargetId; learn: boolean }) => {
    closeMenu(true);
    start(o.targetId, o.learn);
  };
  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % items.length
            : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const onClick = () => {
    switch (state.kind) {
      case 'none':
        // Nothing to deploy to yet: the button is the way to connect a target (it used to be greyed out).
        pushOverlay({ kind: 'modal', modal: 'connect', projectId });
        return;
      case 'learning':
        openSession(projectId, state.sessionId);
        return;
      case 'deploying':
        pushOverlay({ kind: 'modal', modal: 'deploy', targetId: state.targetId, deployId: state.deployId });
        return;
      case 'single':
        start(state.targetId, state.learn);
        return;
      case 'menu':
        setMenuOpen((o) => !o);
        return;
    }
  };

  const live = (state.kind === 'single' || state.kind === 'menu') && state.live;
  const label = state.kind === 'none' ? copy.deploy.noTarget : state.label;

  return (
    <div
      className={s['wrap']}
      data-deploy-button="true"
      data-state={state.kind}
      data-learn={state.kind === 'single' && state.learn ? 'true' : undefined}
    >
      <Button
        ref={buttonRef}
        size="compact"
        variant={live ? 'primary' : 'secondary'}
        className={s['button'] ?? ''}
        aria-haspopup={state.kind === 'menu' ? 'menu' : undefined}
        aria-expanded={state.kind === 'menu' ? menuOpen : undefined}
        onClick={onClick}
        onKeyDown={(e) => {
          if (state.kind === 'menu' && e.key === 'ArrowDown' && !menuOpen) {
            e.preventDefault();
            setMenuOpen(true);
          }
        }}
      >
        {state.kind === 'deploying' || state.kind === 'learning' ? (
          <StatusDot size={7} className={s['blink'] ?? ''} />
        ) : (
          <span className={s['glyph']} aria-hidden="true">
            ▲
          </span>
        )}
        {label}
        {state.kind === 'menu' ? <Icon name="chevron" size={10} /> : null}
      </Button>
      {menuOpen && state.kind === 'menu' ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={copy.deploy.pick}
          className={s['menu']}
          onKeyDown={onMenuKeyDown}
          data-deploy-menu="true"
        >
          <div className={['t-label', s['menuHead']].join(' ')} role="presentation">
            {copy.deploy.pick}
          </div>
          {state.options.map((o) => (
            <button
              key={o.targetId}
              type="button"
              role="menuitem"
              className={s['menuItem']}
              onClick={() => choose(o)}
              data-learn={o.learn ? 'true' : undefined}
            >
              {o.name}{' '}
              <Tag tone={o.prod ? 'accent' : 'neutral'} size="sm">
                {o.env}
              </Tag>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
