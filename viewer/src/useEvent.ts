import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Stable callback that always runs the latest `fn` (the "useEvent" pattern).
 * For handlers registered once on window (keydown, custom events): the
 * listener never goes stale and the effect that registers it never needs the
 * handler's dependencies. Do not call the returned function during render.
 */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
