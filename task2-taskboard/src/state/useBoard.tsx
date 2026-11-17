import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { BoardStore } from './store';

const StoreContext = createContext<StoreApi<BoardStore> | null>(null);

/** Provides the board store to the component tree (the app passes the real one, tests pass their own). */
export function BoardProvider({ store, children }: { store: StoreApi<BoardStore>; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/**
 * Subscribes a component to ONE slice of the store. The component re-renders only when that slice
 * changes (compared with Object.is), so an edit re-renders exactly the components that show it.
 */
export function useBoard<T>(selector: (state: BoardStore) => T): T {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useBoard must be used inside <BoardProvider>');
  return useStore(store, selector);
}
