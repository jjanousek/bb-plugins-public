// Activity tab: what the plugin and the chief did, newest first, split into
// days. An event that points at a conversation opens it in the page.
// Consecutive identical connection rows collapse into one so real work stays
// visible.
import { useMemo } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { parseConversationKey } from "../../contract";
import type { Activity } from "../../contract";
import { Glyph, type GlyphName } from "./glyph";
import { dayKey, daySeparator, relativeTime } from "./format";
import { EmptyState, SIGNAL_TEXT, SectionLabel, SkeletonRows } from "./signals";
import { COMMS_PANEL_PATH, conversationSubPath } from "./tabs";
import { useActivity } from "./use-comms";

/**
 * Who triggered a send, in the words the panel uses for those paths. Sends are
 * the only rows that carry an actor, so the reader can see at a glance that a
 * message went out because the owner pressed Send and not because an agent
 * decided to.
 */
function actorLabel(actor: string): string {
  if (actor === "panel") return "(you pressed Send)";
  if (actor === "cli") return "(you ran bb comms)";
  const thread = actor.startsWith("agent ") ? actor.slice("agent ".length) : null;
  return thread === null ? "(an agent)" : `(an agent in ${thread})`;
}

const KIND_LABEL: Record<Activity["kind"], string> = {
  "chief-created": "Chief created",
  "mail-draft": "Mail draft",
  "mail-sent": "Mail sent",
  "mail-sync": "Mail sync",
  "wa-draft": "WhatsApp draft",
  "wa-sent": "WhatsApp sent",
  "wa-discarded": "Draft discarded",
  "wa-incoming": "WhatsApp in",
  "wa-connection": "WhatsApp",
  "auto-draft-requested": "Draft requested",
  voice: "Voice file",
  dismissed: "Dismissed",
  muted: "Muted",
  error: "Error",
};

interface KindStyle {
  glyph: GlyphName;
  cls: string;
  /** Background noise: the text stays muted too. */
  quiet?: boolean;
}

const KIND_STYLE: Record<Activity["kind"], KindStyle> = {
  "mail-sent": { glyph: "done", cls: SIGNAL_TEXT.ready },
  "wa-sent": { glyph: "done", cls: SIGNAL_TEXT.ready },
  "mail-draft": { glyph: "draft", cls: SIGNAL_TEXT.neutral },
  "wa-draft": { glyph: "draft", cls: SIGNAL_TEXT.neutral },
  "auto-draft-requested": { glyph: "chief", cls: SIGNAL_TEXT.neutral },
  voice: { glyph: "chief", cls: SIGNAL_TEXT.neutral },
  "wa-discarded": { glyph: "dismiss", cls: SIGNAL_TEXT.neutral },
  dismissed: { glyph: "dismiss", cls: SIGNAL_TEXT.neutral },
  muted: { glyph: "dismiss", cls: SIGNAL_TEXT.neutral, quiet: true },
  "wa-incoming": { glyph: "chat", cls: SIGNAL_TEXT.neutral, quiet: true },
  "mail-sync": { glyph: "sync", cls: SIGNAL_TEXT.neutral, quiet: true },
  "wa-connection": { glyph: "signal", cls: SIGNAL_TEXT.neutral, quiet: true },
  "chief-created": { glyph: "chief", cls: SIGNAL_TEXT.neutral },
  error: { glyph: "dismiss", cls: SIGNAL_TEXT.error },
};

interface Row {
  event: Activity;
  count: number;
}

/** Fold consecutive rows that say exactly the same thing into one. */
function collapse(events: Activity[]): Row[] {
  const rows: Row[] = [];
  for (const event of events) {
    const previous = rows[rows.length - 1];
    if (
      previous !== undefined &&
      previous.event.kind === event.kind &&
      previous.event.ref === event.ref &&
      previous.event.text === event.text
    ) {
      previous.count += 1;
      continue;
    }
    rows.push({ event, count: 1 });
  }
  return rows;
}

export function ActivityTab() {
  const activity = useActivity();
  const navigate = useBbNavigate();
  const rows = useMemo(() => collapse(activity.data ?? []), [activity.data]);

  if (activity.data === null) {
    return activity.error === null ? (
      <SkeletonRows className="p-0" />
    ) : (
      <p role="alert" className="text-[12px] text-rose-600">
        {activity.error}
      </p>
    );
  }

  return (
    <div className="min-w-0">
      <SectionLabel glyph="activity" label="Activity" count={rows.length} />
      {rows.length === 0 ? (
        <EmptyState glyph="activity" title="Nothing has happened yet" />
      ) : (
        <ul className="mt-1">
          {rows.map(({ event, count }, index) => {
            const key = event.ref === null ? null : parseConversationKey(event.ref) === null ? null : event.ref;
            const style = KIND_STYLE[event.kind];
            const previous = rows[index - 1];
            const newDay = previous === undefined || dayKey(previous.event.at) !== dayKey(event.at);
            const row = (
              <>
                <span className="w-16 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {relativeTime(event.at)}
                </span>
                <span className={cn("inline-flex w-28 shrink-0 items-center gap-1.5 text-[11px]", style.cls)}>
                  <Glyph name={style.glyph} size={12} />
                  <span className="min-w-0 truncate">{KIND_LABEL[event.kind]}</span>
                  {count > 1 ? <span className="ml-auto shrink-0 tabular-nums">x{count}</span> : null}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 basis-64 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[12px] leading-5",
                    style.quiet === true ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {event.text}
                  {event.actor === null ? null : (
                    <span className="text-muted-foreground"> {actorLabel(event.actor)}</span>
                  )}
                </span>
              </>
            );
            return (
              <li key={event.id} className="min-w-0">
                {newDay ? (
                  <div className={cn("pb-1.5", index === 0 ? "pt-1" : "pt-4")}>
                    <SectionLabel label={daySeparator(event.at)} />
                  </div>
                ) : null}
                {key === null ? (
                  <div className="flex min-w-0 flex-wrap items-start gap-x-2.5 gap-y-1 border-b border-border/60 py-2">{row}</div>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      navigate.toPluginPanel(COMMS_PANEL_PATH, { subPath: conversationSubPath(key), replace: true })
                    }
                    className="flex w-full min-w-0 cursor-pointer flex-wrap items-start gap-x-2.5 gap-y-1 border-b border-border/60 py-2 text-left transition-colors hover:bg-accent/50"
                  >
                    {row}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
