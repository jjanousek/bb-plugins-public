// One line above a plugin-hosted chat, on finger surfaces only: the model,
// reasoning level and permission mode the thread's next turn will run with,
// each a 44px word that opens a bottom sheet of the choices bb reports for
// that thread's provider. On a mouse the host's own composer footer does this
// job and the bar renders nothing.
//
// The host collapses its composer footer to zero height on compact layouts
// (an upstream bb issue), so on a phone the pickers vanish
// the moment they are tapped. This bar does not depend on that footer.
//
// A copy of the same component in chief-of-staff. Keep the two in step.
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { cn } from "@/lib/utils";
import type { ExecutionChoice, ThreadExecution } from "../../contract";
import { Glyph } from "./glyph";
import { errorText, useCommsRpc, useIsFingerSurface, useThreadExecution } from "./use-comms";

type Field = "model" | "reasoningLevel" | "permissionMode";

const FIELD_TITLE: Record<Field, string> = {
  model: "Model",
  reasoningLevel: "Reasoning",
  permissionMode: "Permission mode",
};

function choicesFor(execution: ThreadExecution, field: Field): readonly ExecutionChoice[] {
  return field === "model"
    ? execution.models
    : field === "reasoningLevel"
      ? execution.reasoningLevels
      : execution.permissionModes;
}

export function ThreadExecutionBar({ threadId }: { threadId: string }) {
  const finger = useIsFingerSurface();
  const live = useThreadExecution(threadId);
  const rpc = useCommsRpc();
  const [open, setOpen] = useState<Field | null>(null);
  const [busy, setBusy] = useState(false);
  const execution = live.data;

  if (!finger || execution === null) return null;

  const current = (field: Field): string => {
    const value = execution[field];
    return choicesFor(execution, field).find((c) => c.value === value)?.short ?? value;
  };

  const pick = async (field: Field, value: string) => {
    setOpen(null);
    if (execution[field] === value) return;
    setBusy(true);
    try {
      await rpc.call("thread_execution_set", { threadId, [field]: value } as Parameters<typeof rpc.call<"thread_execution_set">>[1]);
      live.refetch();
    } catch (cause) {
      toast.error(`Could not change the ${FIELD_TITLE[field].toLowerCase()}: ${errorText(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const sheet = open === null ? null : choicesFor(execution, open);

  return (
    <>
      <div
        data-thread-execution-bar=""
        role="group"
        aria-label="Next turn runs with"
        className="flex min-h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 text-[13px] leading-5 text-muted-foreground"
      >
        {(["model", "reasoningLevel", "permissionMode"] as const).map((field, index) => (
          <Fragment key={field}>
            {index > 0 ? <span aria-hidden>·</span> : null}
            <button
              type="button"
              aria-label={`${FIELD_TITLE[field]}: ${current(field)}`}
              aria-haspopup="dialog"
              aria-expanded={open === field}
              disabled={busy}
              onClick={() => setOpen(field)}
              className={cn(
                "min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-sm px-2 text-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60",
              )}
            >
              {current(field)}
            </button>
          </Fragment>
        ))}
        {execution.catalogError === null ? null : (
          <span className="ml-auto truncate pl-2 text-[12px]" title={execution.catalogError}>
            catalog unavailable
          </span>
        )}
      </div>
      <ResponsiveDrawerShell
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        srLabel={open === null ? undefined : FIELD_TITLE[open]}
      >
        {open === null || sheet === null ? null : (
          <div className="flex flex-col overflow-y-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1">
            <h3 aria-hidden className="px-2 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {FIELD_TITLE[open]}
            </h3>
            {sheet.map((choice) => {
              const selected = choice.value === execution[open];
              return (
                <button
                  key={choice.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => void pick(open, choice.value)}
                  className="flex min-h-11 w-full shrink-0 cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-5 text-foreground">{choice.label}</span>
                    {choice.description === undefined ? null : (
                      <span className="block text-[12px] leading-4 text-muted-foreground">{choice.description}</span>
                    )}
                  </span>
                  {selected ? <Glyph name="done" size={16} className="text-foreground" /> : null}
                </button>
              );
            })}
          </div>
        )}
      </ResponsiveDrawerShell>
    </>
  );
}
