import { useEffect, useRef } from 'react';

/**
 * Runs `callback` once after `delay` ms. `null` disables (and clears) the timer; changing `delay` restarts it.
 * The latest `callback` is always used without restarting the timer.
 */
export function useTimeout(callback: () => void, delay: number | null): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    if (delay === null) return;
    const id = setTimeout(() => latest.current(), delay);
    return () => clearTimeout(id);
  }, [delay]);
}
