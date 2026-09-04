import { describe, expect, it } from 'vitest';
import { demoLaneDiff } from '../fixtures/demo';
import { diffTotals, fnv1a, hunkHash, parseUnifiedDiff } from './unified';

const TWO_FILES = `diff --git a/checkout.ts b/checkout.ts
index 1111111..2222222 100644
--- a/checkout.ts
+++ b/checkout.ts
@@ -1,2 +1,3 @@
 import { sum } from './cart'
+import { validate } from './validate'

@@ -4,3 +5,5 @@ export async function checkout(cart) {
 export async function checkout(cart) {
+  validate(cart)
   const total = sum(cart.items)
   const receipt = await pay(total)
+  audit(receipt)
diff --git a/validate.ts b/validate.ts
new file mode 100644
--- /dev/null
+++ b/validate.ts
@@ -0,0 +1,3 @@
+export function validate(cart) {
+  if (!cart.items.length) throw new CartError("empty")
+}
\\ No newline at end of file
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/a.ts b/b.ts
similarity index 90%
rename from a.ts
rename to b.ts
--- a/a.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
`;

describe('parseUnifiedDiff', () => {
  const diff = parseUnifiedDiff(TWO_FILES);

  it('splits files with status, paths and totals', () => {
    expect(diff.files.map((f) => [f.path, f.status, f.added, f.removed, f.hunks.length])).toEqual([
      ['checkout.ts', 'modified', 3, 0, 2],
      ['validate.ts', 'added', 3, 0, 1],
      ['old.ts', 'deleted', 0, 1, 1],
      ['b.ts', 'renamed', 1, 1, 1],
    ]);
    expect(diff.files[1]).toMatchObject({ oldPath: null, newPath: 'validate.ts' });
    expect(diff.files[2]).toMatchObject({ oldPath: 'old.ts', newPath: null });
    expect(diffTotals(diff)).toEqual({ added: 7, removed: 2, files: 4 });
  });

  it('parses hunk headers, line numbers and kinds', () => {
    const [h1, h2] = diff.files[0]?.hunks ?? [];
    expect(h1).toMatchObject({
      file: 'checkout.ts',
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      header: '@@ -1,2 +1,3 @@',
    });
    expect(h1?.lines).toEqual([
      { kind: 'context', text: "import { sum } from './cart'", oldLine: 1, newLine: 1 },
      { kind: 'add', text: "import { validate } from './validate'", oldLine: null, newLine: 2 },
      { kind: 'context', text: '', oldLine: 2, newLine: 3 },
    ]);
    expect(h2).toMatchObject({
      oldStart: 4,
      oldLines: 3,
      newStart: 5,
      newLines: 5,
      header: '@@ -4,3 +5,5 @@',
    });
    expect(h2?.lines.map((l) => l.kind)).toEqual(['context', 'add', 'context', 'context', 'add']);
    const del = diff.files[2]?.hunks[0];
    expect(del).toMatchObject({
      oldStart: 1,
      oldLines: 1,
      newStart: 0,
      newLines: 0,
      header: '@@ -1 +0,0 @@',
    });
    expect(del?.lines).toEqual([{ kind: 'remove', text: 'gone', oldLine: 1, newLine: null }]);
    expect(diff.files[3]?.hunks[0]?.header).toBe('@@ -1 +1 @@');
  });

  it('emits a standalone patch per hunk that git apply accepts', () => {
    expect(diff.files[1]?.hunks[0]?.patch).toBe(
      '--- /dev/null\n+++ b/validate.ts\n@@ -0,0 +1,3 @@\n+export function validate(cart) {\n+  if (!cart.items.length) throw new CartError("empty")\n+}\n',
    );
    expect(diff.files[2]?.hunks[0]?.patch.startsWith('--- a/old.ts\n+++ /dev/null\n')).toBe(true);
  });

  it('hunkHash is stable across line-number shifts and differs by content', () => {
    const shifted = parseUnifiedDiff(TWO_FILES.replace('@@ -1,2 +1,3 @@', '@@ -11,2 +11,3 @@'));
    expect(shifted.files[0]?.hunks[0]?.hunkHash).toBe(diff.files[0]?.hunks[0]?.hunkHash);
    expect(diff.files[0]?.hunks[0]?.hunkHash).not.toBe(diff.files[0]?.hunks[1]?.hunkHash);
    expect(hunkHash('a.ts', [{ kind: 'add', text: 'x' }])).not.toBe(
      hunkHash('b.ts', [{ kind: 'add', text: 'x' }]),
    );
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
  });

  it('parses the demo lane diff and headerless diffs', () => {
    const lane = parseUnifiedDiff(demoLaneDiff);
    expect(lane.files).toHaveLength(1);
    expect(lane.files[0]).toMatchObject({ path: 'checkout.ts', added: 3, removed: 0 });
    const bare = parseUnifiedDiff(
      '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-c\n+d\n',
    );
    expect(bare.files.map((f) => f.path)).toEqual(['x.ts', 'y.ts']);
    const hunkOnly = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\nunrelated trailer\n');
    expect(hunkOnly.files).toHaveLength(1);
    expect(hunkOnly.files[0]?.hunks[0]?.lines).toHaveLength(2);
    const plusOnly = parseUnifiedDiff('+++ b/new.ts\n@@ -0,0 +1 @@\n+a\n');
    expect(plusOnly.files[0]).toMatchObject({ path: 'new.ts', status: 'added' });
    expect(parseUnifiedDiff('')).toEqual({ files: [] });
    expect(parseUnifiedDiff('diff --git a/e b/e\n')).toEqual({ files: [] });
  });
});
