import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompareOptions {
  /** pixelmatch colour threshold, 0–1 (default 0.1). */
  threshold?: number;
  /** Maximum allowed fraction of differing (unmasked) pixels (default 0.002 = 0.2 %). */
  maxDiffRatio?: number;
  /** Rects painted flat on both images before diffing (native window chrome, clocks, …). */
  masks?: readonly Rect[];
}

export interface CompareResult {
  pass: boolean;
  width: number;
  height: number;
  /** Pixels compared (image area minus masked area). */
  comparedPixels: number;
  diffPixels: number;
  diffRatio: number;
  /** Set when the two PNGs have different dimensions; nothing is diffed in that case. */
  sizeMismatch?: { actual: [number, number]; baseline: [number, number] };
}

function paintMask(png: PNG, rect: Rect): number {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(png.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(png.height, Math.ceil(rect.y + rect.height));
  let painted = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = 255;
      png.data[i + 1] = 0;
      png.data[i + 2] = 255;
      png.data[i + 3] = 255;
      painted++;
    }
  }
  return painted;
}

/**
 * Diffs two PNG files with pixelmatch, writes a diff PNG (red = changed, yellow = anti-aliasing) to `diffOutPath`,
 * and reports the ratio of differing pixels over the unmasked area.
 */
export function comparePng(
  actualPath: string,
  baselinePath: string,
  diffOutPath: string,
  opts: CompareOptions = {},
): CompareResult {
  const threshold = opts.threshold ?? 0.1;
  const maxDiffRatio = opts.maxDiffRatio ?? 0.002;
  const actual = PNG.sync.read(readFileSync(actualPath));
  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const { width, height } = actual;

  if (width !== baseline.width || height !== baseline.height) {
    return {
      pass: false,
      width,
      height,
      comparedPixels: 0,
      diffPixels: 0,
      diffRatio: 1,
      sizeMismatch: { actual: [width, height], baseline: [baseline.width, baseline.height] },
    };
  }

  let masked = 0;
  for (const rect of opts.masks ?? []) {
    // Painting the same rect on both sides means the region can never count as a diff, without over-counting overlaps.
    masked += paintMask(actual, rect);
    paintMask(baseline, rect);
  }

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(actual.data, baseline.data, diff.data, width, height, {
    threshold,
    includeAA: false,
  });
  mkdirSync(dirname(diffOutPath), { recursive: true });
  writeFileSync(diffOutPath, PNG.sync.write(diff));

  const comparedPixels = Math.max(1, width * height - masked);
  const diffRatio = diffPixels / comparedPixels;
  return { pass: diffRatio <= maxDiffRatio, width, height, comparedPixels, diffPixels, diffRatio };
}
