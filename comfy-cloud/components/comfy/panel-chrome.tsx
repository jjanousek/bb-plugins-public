// The two host-rendered slivers around the panel: the title bar (a Generate
// button plus a running pill or a red "No key" pill) and the sidebar row
// accessory. Both stay narrow enough that the host's "Comfy" title is never
// squeezed out: the words hide first, the numbers stay. Same hairline chrome
// as the panel body, and the plugin's own glyphs.
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { Glyph } from "./glyphs";
import { PrimaryButton } from "./kit";
import { SidebarAccessorySignal } from "./sidebar-accessory";
import { topSignal } from "./sidebar-signal";
import { COMFY_PANEL_PATH, GENERATE_SUBPATH, SETTINGS_HREF } from "./tabs";
import { useComfyBridge, useOpenGenerateTab, useOpenJobsTab, useStatus } from "./use-comfy";

const PILL = "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[11px] font-medium max-md:h-11 max-md:px-3";

export function HeaderContent() {
  useComfyBridge();
  const navigate = useBbNavigate();
  const openGenerate = useOpenGenerateTab();
  const openJobs = useOpenJobsTab();
  const status = useStatus();
  const running = status.data?.counts.running ?? 0;
  const configured = status.data?.configured ?? true;
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {running > 0 ? (
        // The host draws both fixed tabs with the panel icon, so this pill is
        // the way to the Jobs tab that says what it does.
        <button
          type="button"
          aria-label={`${running} running, open Jobs`}
          title={`${running} generating now. Open the Jobs tab.`}
          onClick={() => {
            if (!openJobs()) navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: "" });
          }}
          className={cn(
            PILL,
            "cursor-pointer border-border/60 text-foreground transition-colors duration-150 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none",
          )}
        >
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground motion-reduce:animate-none" aria-hidden />
          <span className="tabular-nums">{running}</span>
          <span className="hidden lg:inline">running</span>
        </button>
      ) : null}
      {configured ? null : (
        <UrlLink
          href={SETTINGS_HREF}
          className={cn(PILL, "border-destructive/30 text-destructive hover:bg-state-hover")}
          title={status.data?.configureHint ?? "No Comfy Cloud API key is configured. Open the plugin settings."}
        >
          <Glyph.alert className="size-3.5 shrink-0" />
          No key
        </UrlLink>
      )}
      <PrimaryButton
        glyph="spark"
        title="Write a prompt and generate"
        className="max-md:h-11 max-md:w-11 max-md:justify-center max-md:gap-0 max-md:px-0"
        onClick={() => {
          if (!openGenerate()) navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: GENERATE_SUBPATH });
        }}
      >
        <span className="sr-only md:not-sr-only">Generate</span>
      </PrimaryButton>
    </div>
  );
}

// Re-exported so the sidebar signal can be reached from the panel chrome module.
export { topSignal };

export function SidebarAccessory() {
  useComfyBridge();
  const status = useStatus();
  return <SidebarAccessorySignal signal={topSignal(status.data)} />;
}
