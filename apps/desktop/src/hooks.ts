import { useEffect, useRef } from 'react';

/** Enter runs the handler unless focus is in a field or on a button, which handle Enter themselves. */
export function useEnter(handler: (() => void) | null) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || !ref.current) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLButtonElement || t instanceof HTMLSelectElement) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
