import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import s from './DeviceFrame.module.css';

export type DeviceFrameKind = 'phone' | 'tablet';

export interface DeviceFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Phone: thicker bezel with a dynamic-island bar in the status strip. Tablet: thinner bezel, no island. */
  kind: DeviceFrameKind;
  /** The screen is shown on its side (`width` / `height` are the screen as shown, already swapped by the caller). */
  landscape?: boolean;
  /** The screen's size in CSS px; the frame adds its bezel, status strip and home indicator around it. */
  width: number;
  height: number;
  /** Accessible name (`{device} frame`). */
  label: string;
  /** What is on the screen: a measured slot for the native view, or the mirrored device. */
  children?: ReactNode;
}

/** The status strip's glyphs: 1px strokes and filled squares on a small grid, like the navigation icons. */
const glyph = (box: [number, number], parts: { d: string; fill?: boolean }[]) => (
  <svg
    aria-hidden="true"
    focusable="false"
    width={box[0]}
    height={box[1]}
    viewBox={`0 0 ${box[0]} ${box[1]}`}
    className={s['glyph']}
  >
    {parts.map((p, i) => (
      <path
        key={i}
        d={p.d}
        fill={p.fill ? 'currentColor' : 'none'}
        stroke={p.fill ? 'none' : 'currentColor'}
        strokeWidth={1}
        strokeLinejoin="miter"
        strokeLinecap="square"
        shapeRendering="crispEdges"
      />
    ))}
  </svg>
);

/** Four rising bars. */
const signal = glyph(
  [12, 10],
  [{ d: 'M0 7 H2 V10 H0 Z M3 5 H5 V10 H3 Z M6 3 H8 V10 H6 Z M9 1 H11 V10 H9 Z', fill: true }],
);
/** Three narrowing bars over a point (straight lines only, no arcs). */
const wifi = glyph(
  [12, 10],
  [{ d: 'M0.5 1.5 H11.5 M2.5 4.5 H9.5 M4.5 7.5 H7.5' }, { d: 'M5 9 H7 V10 H5 Z', fill: true }],
);
/** A cell outline with its nub, three quarters full. */
const battery = glyph(
  [20, 10],
  [
    { d: 'M0.5 1.5 H16.5 V8.5 H0.5 Z' },
    { d: 'M18 3 H20 V7 H18 Z', fill: true },
    { d: 'M2 3 H12 V7 H2 Z', fill: true },
  ],
);

/**
 * Phone / tablet chrome around a screen, in the design language: square corners (radius 0 is the rule, even on a
 * phone), a 1px text-colour frame on `--s1`, a mono status strip reading `9:41` with signal / wifi / battery, a
 * dynamic-island bar (phone only), and a home-indicator line. The screen slot is exactly `width × height`; the
 * caller scales the whole frame (`transform`) when the pane is smaller than the device.
 */
export const DeviceFrame = forwardRef<HTMLDivElement, DeviceFrameProps>(function DeviceFrame(
  { kind, landscape, width, height, label, className, children, ...rest },
  ref,
) {
  const cls = [s['frame'], className].filter(Boolean).join(' ');
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={cls}
      data-kind={kind}
      data-landscape={landscape ? 'true' : undefined}
      {...rest}
    >
      <div className={s['status']} aria-hidden="true">
        <span className={s['clock']}>9:41</span>
        {kind === 'phone' ? <span className={s['island']} data-island="true" /> : <span />}
        <span className={s['glyphs']}>
          {signal}
          {wifi}
          {battery}
        </span>
      </div>
      <div className={s['screen']} style={{ width, height }} data-screen="true">
        {children}
      </div>
      <div className={s['homeRow']} aria-hidden="true">
        <span className={s['home']} />
      </div>
    </div>
  );
});
