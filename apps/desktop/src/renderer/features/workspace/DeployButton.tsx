import { copy, type ProjectId, type TargetId } from '@styx/core';
import { Button, Icon, StatusDot, Tag } from '@styx/ui';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useModel, useUi } from '../../state/hooks';
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
 */
export function DeployButton({ projectId }: DeployButtonProps) {
  const state = useModel(useCallback((m) => deployButtonState(m, projectId), [projectId]));
  const pushOverlay = useUi((u) => u.pushOverlay);
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
  const start = (targetId: TargetId) => pushOverlay({ kind: 'modal', modal: 'deploy', targetId });
  const choose = (targetId: TargetId) => {
    closeMenu(true);
    start(targetId);
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
        return;
      case 'deploying':
        pushOverlay({ kind: 'modal', modal: 'deploy', targetId: state.targetId, deployId: state.deployId });
        return;
      case 'single':
        start(state.targetId);
        return;
      case 'menu':
        setMenuOpen((o) => !o);
        return;
    }
  };

  const live = (state.kind === 'single' || state.kind === 'menu') && state.live;
  const label = state.kind === 'none' ? copy.deploy.noTarget : state.label;

  return (
    <div className={s['wrap']} data-deploy-button="true" data-state={state.kind}>
      <Button
        ref={buttonRef}
        size="compact"
        variant={live ? 'primary' : 'secondary'}
        className={s['button'] ?? ''}
        disabled={state.kind === 'none'}
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
        {state.kind === 'deploying' ? (
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
              onClick={() => choose(o.targetId)}
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
