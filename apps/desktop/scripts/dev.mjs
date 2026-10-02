// `electron-vite dev` without ELECTRON_RUN_AS_NODE (set by VS Code's terminals; it would boot Electron as plain Node).
// A script rather than `env -u`, which Windows does not have.
import { spawn } from 'node:child_process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn('electron-vite', ['dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 1));
