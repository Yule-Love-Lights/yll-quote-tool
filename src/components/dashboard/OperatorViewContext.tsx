'use client';

// Client-side view state for the operator shell (ops hub workstream A slice
// 2). Per-tab React state, deliberately nothing more: no cookie, no schema,
// no persistence. The view is 'office' for every operator today; the admin
// View-as control is the only writer, and its Crew/Advertising options are
// disabled until those views are built, so setView never receives anything
// but 'office' yet. The provider lives in OperatorShell so both the nav and
// (later) page content read the same value.

import { createContext, useContext, useMemo, useState } from 'react';
import type { OperatorView } from './operatorView';

type OperatorViewState = { view: OperatorView; setView: (view: OperatorView) => void };

// Default keeps any OperatorNav rendered outside the provider (tests, a
// future stray usage) on the office view rather than crashing.
const OperatorViewContext = createContext<OperatorViewState>({ view: 'office', setView: () => {} });

export function OperatorViewProvider({ children }: { children: React.ReactNode }) {
  const [view, setView] = useState<OperatorView>('office');
  const value = useMemo(() => ({ view, setView }), [view]);
  return <OperatorViewContext.Provider value={value}>{children}</OperatorViewContext.Provider>;
}

export function useOperatorView(): OperatorViewState {
  return useContext(OperatorViewContext);
}
