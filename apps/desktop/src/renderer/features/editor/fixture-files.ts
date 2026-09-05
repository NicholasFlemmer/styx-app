/**
 * The prototype's Workspace file tree and `checkout.ts` snippet (design/handoff/Styx.dc.html, Workspace artboard).
 * Used when `fs.*` is unavailable (renderer-only dev, e2e over a fixture whose worktrees do not exist on disk).
 */
export type GitStatus = 'M' | 'A' | 'D' | '?';

export interface FileNode {
  /** Path relative to the worktree root, `/`-separated. */
  path: string;
  name: string;
  kind: 'file' | 'dir';
  depth: number;
  status: GitStatus | null;
}

const node = (path: string, kind: FileNode['kind'], status: GitStatus | null = null): FileNode => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind,
  depth: path.split('/').length - 1,
  status,
});

/** Prototype order (not alphabetical): src/, app.ts, checkout.ts ●, cart.ts, pay.ts ●, validate.ts A, tests/, checkout.test.ts ●. */
export const FIXTURE_TREE: readonly FileNode[] = [
  node('src', 'dir'),
  node('src/app.ts', 'file'),
  node('src/checkout.ts', 'file', 'M'),
  node('src/cart.ts', 'file'),
  node('src/pay.ts', 'file', 'M'),
  node('src/validate.ts', 'file', 'A'),
  node('tests', 'dir'),
  node('tests/checkout.test.ts', 'file', 'M'),
];

/** Prototype "Changes · 3": checkout.ts, pay.ts, validate.ts (the test file is marked in the tree only). */
export const FIXTURE_CHANGES: readonly { path: string; status: GitStatus }[] = [
  { path: 'src/checkout.ts', status: 'M' },
  { path: 'src/pay.ts', status: 'M' },
  { path: 'src/validate.ts', status: 'A' },
];

export const FIXTURE_DEFAULT_FILE = 'src/checkout.ts';

const CHECKOUT_TS = [
  "import { sum } from './cart'",
  "import { validate } from './validate'",
  '',
  'export async function checkout(cart) {',
  '  validate(cart)',
  '  const total = sum(cart.items)',
  '  const receipt = await pay(total)',
  '  audit(receipt)',
  '  return receipt',
  '}',
].join('\n');

const VALIDATE_TS = [
  'export function validate(cart) {',
  '  if (!cart.items.length) throw new CartError("empty")',
  '}',
  '',
].join('\n');

const FIXTURE_TEXT: Readonly<Record<string, string>> = {
  'src/checkout.ts': CHECKOUT_TS,
  'src/validate.ts': VALIDATE_TS,
  'src/app.ts': "import { checkout } from './checkout'\n\nexport { checkout }\n",
  'src/cart.ts': 'export const sum = (items) => items.reduce((t, i) => t + i.price, 0)\n',
  'src/pay.ts': 'export async function pay(total) {\n  return { total, ok: true }\n}\n',
  'tests/checkout.test.ts':
    "import { checkout } from '../src/checkout'\n\ntest('checkout validates', async () => {\n  await expect(checkout({ items: [] })).rejects.toThrow()\n})\n",
};

export const fixtureFileText = (path: string): string => FIXTURE_TEXT[path] ?? '';
