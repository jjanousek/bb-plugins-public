// bb-plugin-comfy-cloud - frontend entry.
//
// One nav panel ("Comfy") whose body is the asset browser: a thumbnail grid
// and, when an asset is selected, the viewer with the workflow graph. The
// host panel carries two fixed tabs, Generate (the form) and Jobs (what is
// queued, running or failed). Everything else here is registration; the
// surfaces live in components/comfy.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginFixedTabRegistration } from "@get-bb/plugin-sdk/app";
import { BrowserPage } from "@/components/comfy/browser-page";
import { GenerateTab } from "@/components/comfy/generate-tab";
import { JobsTab } from "@/components/comfy/jobs-tab";
import { HeaderContent, SidebarAccessory } from "@/components/comfy/panel-chrome";
import { SettingsSection } from "@/components/comfy/settings-section";
import { COMFY_PANEL_ID, COMFY_PANEL_PATH, GENERATE_SUBPATH, GENERATE_TAB, JOBS_TAB } from "@/components/comfy/tabs";
import { bridgeNavigate } from "@/components/comfy/use-comfy";

// The host draws both fixed tabs with the panel's own icon and ignores these
// hints, so the tabs are told apart by their titles, by the header running
// pill (which opens Jobs) and by the "Jobs" link under the Generate form.
const GENERATE_TAB_REGISTRATION: PluginFixedTabRegistration = {
  ...GENERATE_TAB,
  title: "Generate",
  icon: "Zap",
  component: GenerateTab,
  layout: "padded",
};

const JOBS_TAB_REGISTRATION: PluginFixedTabRegistration = {
  ...JOBS_TAB,
  title: "Jobs",
  icon: "Clock",
  component: JobsTab,
  layout: "padded",
};

/** The panel's route in the host app, for the palette actions when no Comfy surface has lent its navigator yet. */
const PANEL_URL = "/plugins/comfy-cloud/comfy";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: COMFY_PANEL_ID,
    title: "Comfy",
    icon: "comfy-cloud/rail",
    path: COMFY_PANEL_PATH,
    component: BrowserPage,
    fixedTabs: [GENERATE_TAB_REGISTRATION, JOBS_TAB_REGISTRATION],
    headerContent: HeaderContent,
    experimental_sidebarAccessory: SidebarAccessory,
  });

  app.slots.settingsSection({
    id: "overview",
    title: "Status",
    description: "Where the key comes from and what has been generated.",
    component: SettingsSection,
  });

  app.slots.commandPaletteAction({
    id: "comfy-open",
    title: "Comfy Cloud: open",
    run() {
      const navigate = bridgeNavigate();
      if (navigate === null) {
        // No Comfy surface has mounted yet, so there is no in-app navigator to borrow: load the route directly.
        window.location.assign(PANEL_URL);
        return;
      }
      navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: "" });
    },
  });

  app.slots.commandPaletteAction({
    id: "comfy-generate-image",
    title: "Comfy Cloud: generate image",
    run() {
      const navigate = bridgeNavigate();
      if (navigate === null) {
        window.location.assign(`${PANEL_URL}/${GENERATE_SUBPATH}`);
        return;
      }
      navigate.toPluginPanel(COMFY_PANEL_PATH, { subPath: GENERATE_SUBPATH });
    },
  });
});
