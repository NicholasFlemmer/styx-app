import { copy, fill, type ProjectId, type ReadModel, type SessionId } from '@styx/core';
import { Button } from '@styx/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { command } from '../../state/commands';
import { useModel } from '../../state/hooks';
import s from './HubLaneControl.module.css';

const selectRooms = (m: ReadModel) => m.hub.rooms;

type Room = { id: string; title: string; goal: string; state: 'active' | 'paused' | 'closed' };

/**
 * Rooms in the lane header (ADR-0032 round 2, mockup styx-next-hub-rooms.html frame 2). Not in a room: Join a room,
 * which lists the space's open rooms and asks what this lane brings. In a room: its name and the person's switch,
 * Wait for me / Work on room tasks (the one setting that lets a room start this lane's turns).
 */
export function RoomControl({ projectId, sessionId }: { projectId: ProjectId; sessionId: SessionId }) {
  const rooms = useModel(selectRooms);
  const mine = rooms.find((r) => r.sessionId === sessionId) ?? null;
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Room[] | null>(null);
  const [brings, setBrings] = useState('');
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = () => {
    if (!open)
      void command('hub.rooms', { projectId }).then((r) => {
        if (r.ok) setList(r.value.rooms.filter((x) => x.state !== 'closed'));
        else setError(r.error.message);
      });
    setOpen((o) => !o);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  };

  if (mine !== null)
    return (
      <div className={s['wrap']} ref={wrap} onKeyDown={onKeyDown}>
        <button
          type="button"
          className={s['tool']}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-hub-room={mine.roomId}
        >
          {fill(copy.hub.room.in, { title: mine.title })}
        </button>
        {(['wait', 'work'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={s['tool']}
            aria-pressed={mine.mode === m}
            data-inv={mine.mode === m ? 'true' : undefined}
            title={m === 'work' ? copy.hub.room.workTitle : copy.hub.room.waitTitle}
            onClick={() => void command('hub.setRoomMode', { sessionId, mode: m })}
            data-hub-room-mode={m}
          >
            {m === 'work' ? copy.hub.room.work : copy.hub.room.wait}
          </button>
        ))}
        {open ? (
          <div
            className={s['panel']}
            role="dialog"
            aria-label={fill(copy.hub.room.in, { title: mine.title })}
          >
            <Button
              variant="ghost"
              onClick={() => void command('hub.leaveRoom', { sessionId }).then(() => setOpen(false))}
            >
              {copy.hub.room.leave}
            </Button>
          </div>
        ) : null}
      </div>
    );

  return (
    <div className={s['wrap']} ref={wrap} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={s['tool']}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={copy.hub.room.joinTitle}
        onClick={toggle}
        data-hub-room-join="true"
      >
        {copy.hub.room.join}
      </button>
      {open ? (
        <div className={s['panel']} role="dialog" aria-label={copy.hub.room.join}>
          <label className="t-meta" htmlFor="hub-room-brings">
            {copy.hub.room.brings}
          </label>
          <input
            id="hub-room-brings"
            className={s['input']}
            value={brings}
            maxLength={300}
            placeholder={copy.hub.room.bringsHint}
            onChange={(e) => setBrings(e.currentTarget.value)}
          />
          {list !== null && list.length === 0 ? <p className={s['lead']}>{copy.hub.room.none}</p> : null}
          {list !== null && list.length > 0 ? (
            <div className={s['list']} role="group" aria-label={copy.hub.room.join}>
              {list.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={s['item']}
                  title={r.goal}
                  onClick={() =>
                    void command('hub.joinRoom', {
                      sessionId,
                      roomId: r.id,
                      brings: brings.trim(),
                      mode: 'wait',
                    }).then((res) => {
                      if (res.ok) setOpen(false);
                      else setError(res.error.message);
                    })
                  }
                  data-hub-room-pick={r.id}
                >
                  {fill(copy.hub.room.pick, { title: r.title })}
                </button>
              ))}
            </div>
          ) : null}
          {error !== null ? (
            <p className={s['error']} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
