// A display choice that survives the panel being remounted.
//
// Plain React state is thrown away whenever the host remounts the panel, which
// it does on navigation, on a realtime reconnect and when the page reflows, so
// a "Show as list" kept there would be undone by the next navigation.
// A choice that reverses itself after being made is worse than never offering it.
//
// localStorage, not plugin kv: this is a per-device display preference (a phone
// and a desktop may want different views of one list), it holds a word like
// "list", never data, and it must be read synchronously on the first render so
// the wrong view never flashes. A storage that throws (private mode, a full
// quota) falls back to the default rather than breaking the panel.
import { useCallback, useState } from "react";

const PREFIX = "cos.view.";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    return raw !== null && raw !== undefined && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

export function useRememberedChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, allowed, fallback));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        globalThis.localStorage?.setItem(PREFIX + key, next);
      } catch {
        // Kept for this mount only; the next one falls back to the default.
      }
    },
    [key],
  );
  return [value, set];
}
