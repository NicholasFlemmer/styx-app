'use client';

import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { DemoStep } from '@/lib/demo-script';

export type Chrome = 'mac' | 'win';

type Demo = {
  step: DemoStep;
  setStep: Dispatch<SetStateAction<DemoStep>>;
  playing: boolean;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  chrome: Chrome;
  setChrome: Dispatch<SetStateAction<Chrome>>;
};

const DemoCtx = createContext<Demo | null>(null);

/** One grant, shared by the hero mock and the counters strip under it. */
export const DemoProvider = ({ children }: { children: ReactNode }) => {
  const [step, setStep] = useState<DemoStep>('command');
  const [playing, setPlaying] = useState(true);
  const [chrome, setChrome] = useState<Chrome>('mac');
  const value = useMemo(() => ({ step, setStep, playing, setPlaying, chrome, setChrome }), [step, playing, chrome]);
  return <DemoCtx.Provider value={value}>{children}</DemoCtx.Provider>;
};

export const useDemo = (): Demo => {
  const value = useContext(DemoCtx);
  if (!value) throw new Error('useDemo must be used inside DemoProvider');
  return value;
};
