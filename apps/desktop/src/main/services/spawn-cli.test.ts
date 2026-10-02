import { describe, expect, it } from 'vitest';
import { npmShimTarget, onePathKey, resolveWin } from './spawn-cli';

describe('spawn-cli (Windows launches)', () => {
  const shim = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;

  it('reads the script behind an npm .cmd shim, so it runs on node without cmd.exe', () => {
    const t = npmShimTarget(
      '/npm/codex.cmd',
      () => shim,
      (f) => f.endsWith('codex.js'),
    );
    expect({ ...t, script: t?.script.replace(/\\/g, '/') }).toEqual({
      node: 'node',
      script: '/npm/node_modules/@openai/codex/bin/codex.js',
    });
    const withNode = npmShimTarget(
      '/npm/codex.cmd',
      () => shim,
      () => true,
    );
    expect(withNode?.node.replace(/\\/g, '/')).toBe('/npm/node.exe');
  });

  it('leaves anything that is not an npm shim to cmd.exe', () => {
    expect(
      npmShimTarget(
        '/x/claude.exe',
        () => shim,
        () => true,
      ),
    ).toBeNull();
    expect(
      npmShimTarget(
        '/x/tool.cmd',
        () => '@echo off\r\ntool.exe %*\r\n',
        () => true,
      ),
    ).toBeNull();
    expect(
      npmShimTarget(
        '/x/gone.cmd',
        () => shim,
        () => false,
      ),
    ).toBeNull();
    expect(
      npmShimTarget(
        '/x/unreadable.cmd',
        () => {
          throw new Error('EACCES');
        },
        () => true,
      ),
    ).toBeNull();
  });

  it('finds a command the way Windows does (PATH, then PATHEXT), and says when it is not there', () => {
    const files = new Set(['C:/npm/codex.cmd', 'C:/bin/claude.exe', 'C:/x/tool.EXE']);
    const exists = (f: string) => files.has(f.replace(/\\/g, '/'));
    const env = { Path: 'C:/bin;C:/npm', PATHEXT: '.EXE;.CMD' };
    expect(resolveWin('claude', env, exists)?.replace(/\\/g, '/')).toBe('C:/bin/claude.exe');
    expect(resolveWin('codex', env, exists)?.replace(/\\/g, '/')).toBe('C:/npm/codex.cmd');
    expect(resolveWin('C:/x/tool', env, exists)).toBe('C:/x/tool.EXE');
    expect(resolveWin('C:/x/tool.EXE', env, exists)).toBe('C:/x/tool.EXE');
    expect(resolveWin('gemini', env, exists)).toBeNull();
  });

  it('keeps one PATH key on Windows, with the value Styx set', () => {
    expect(onePathKey({ Path: 'C:\\old', PATH: 'C:\\shims;C:\\old', HOME: 'h' }, 'win32')).toEqual({
      PATH: 'C:\\shims;C:\\old',
      HOME: 'h',
    });
    expect(onePathKey({ Path: 'C:\\only' }, 'win32')).toEqual({ Path: 'C:\\only' });
    const posix = { Path: 'a', PATH: 'b' };
    expect(onePathKey(posix, 'darwin')).toBe(posix);
  });
});
