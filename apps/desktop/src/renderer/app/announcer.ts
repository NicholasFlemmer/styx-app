export const ANNOUNCER_ID = 'announcer';

/**
 * Screen-reader announcement via the hidden `#announcer` `aria-live=polite` region (plan §8 Accessibility),
 * e.g. "Granted Codex read, write on Supabase prod for 1 hour". Clears first so repeats re-announce.
 */
export const announce = (text: string): void => {
  const el = document.getElementById(ANNOUNCER_ID);
  if (el === null) return;
  el.textContent = '';
  const write = () => {
    el.textContent = text;
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(write);
  else write();
};
