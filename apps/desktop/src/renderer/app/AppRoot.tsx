import { useEffect, useState } from 'react';

export function AppRoot() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    let off = () => {};
    void window.styx.theme.resolved().then((t) => {
      setTheme(t);
      off = window.styx.theme.onResolved(setTheme);
    });
    return () => off();
  }, []);
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);
  return (
    <div
      style={{
        height: 38,
        background: 'var(--s1)',
        borderBottom: '1px solid var(--ln)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        paddingLeft: window.styx.platform === 'darwin' ? 70 : 12,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '.12em' }}>STYX</span>
    </div>
  );
}
