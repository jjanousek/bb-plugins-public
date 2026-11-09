// bb-plugin-chief-of-comms - frontend entry.
//
// One nav panel ("Comms") whose body is a unified inbox: work mail, personal
// mail and WhatsApp in one list, with the conversation and its reply dock
// beside it, and the chief (the thread that runs the inbox) in a drawer on the
// right, opened from the header. There are no host fixed tabs: Activity and
// Connections are views inside the panel. Everything else here is
// registration; the surfaces live in components/comms.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { ChiefComposerSeed } from "@/components/comms/chief-drawer";
import { InboxPage } from "@/components/comms/inbox-page";
import { HeaderContent, useCommsBadge } from "@/components/comms/panel-chrome";
import { COMMS_PANEL_ID, COMMS_PANEL_PATH, TRIAGE_PROMPT } from "@/components/comms/tabs";
import { bridgeNavigate, bridgeRpc, errorText } from "@/components/comms/use-comms";

const NEEDS_PAGE = "Open the Comms page once, then try again";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: COMMS_PANEL_ID,
    title: "Comms",
    icon: "chief-of-comms/rail",
    path: COMMS_PANEL_PATH,
    component: InboxPage,
    headerContent: HeaderContent,
    experimental_useBadge: useCommsBadge,
  });

  // "Ask chief…" writes a first line into the chief's composer and focuses it;
  // inert in every other composer.
  app.composer.customize({
    id: "comms-ask",
    scopes: ["thread"],
    banners: [{ id: "comms-ask", chrome: "bare", component: ChiefComposerSeed }],
  });

  app.slots.commandPaletteAction({
    id: "comms-open",
    title: "Chief of Communications: open inbox",
    run() {
      const navigate = bridgeNavigate();
      if (navigate === null) {
        toast.error(NEEDS_PAGE);
        return;
      }
      navigate.toPluginPanel(COMMS_PANEL_PATH, { subPath: "" });
    },
  });

  app.slots.commandPaletteAction({
    id: "comms-triage",
    title: "Chief of Communications: triage now",
    async run() {
      const rpc = bridgeRpc();
      if (rpc === null) {
        toast.error(NEEDS_PAGE);
        return;
      }
      try {
        const result = await rpc.call("ask_chief", { text: TRIAGE_PROMPT });
        if (result.ok) toast.success(result.text);
        else toast.error(result.text);
      } catch (cause) {
        toast.error(errorText(cause));
      }
    },
  });
});
