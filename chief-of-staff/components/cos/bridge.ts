// A mounted surface lends its navigator to the host-rendered callbacks that do
// not get one: `commandPaletteAction.run` receives only `{ threadId,
// projectId, openPanel }`, and `useBbNavigate` is a hook. Every long-lived
// Chief of Staff surface refreshes it on mount, so the palette works anywhere
// one of them has rendered. Module state is recreated whenever the app bundle
// is re-interpreted, so nothing here outlives a plugin reload.
import { useEffect } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { BbNavigate } from "@get-bb/plugin-sdk/app";

let navigateRef: BbNavigate | null = null;

export function useCosBridge(): void {
  const navigate = useBbNavigate();
  useEffect(() => {
    navigateRef = navigate;
  }, [navigate]);
}

export function bridgeNavigate(): BbNavigate | null {
  return navigateRef;
}
