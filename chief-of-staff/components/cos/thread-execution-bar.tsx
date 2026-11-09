// One line above a plugin-hosted chat: the model, reasoning level and
// permission mode this thread runs at, each a word that opens a sheet of the
// choices bb reports for that thread's provider.
//
// It renders at every width. bb's own composer footer is not a substitute on
// a mouse: its picker is a PER-TURN override that reverts to the thread's
// stored level, so a selection made there can evaporate between two messages.
// This bar writes the STORED level through `threads.update`, which is the
// value every turn actually uses.
//
// The host also collapses its composer footer to zero height on compact
// layouts, so on a phone the pickers vanish
// the moment they are tapped. This bar does not depend on that footer.
//
// Each word opens `RowActions`, the plugin's one menu in two presentations:
// an anchored list on a pointer, the host's bottom sheet on a finger.
// `ResponsiveDrawerShell` on its own is a bottom drawer at EVERY width, so a
// click on "Full" on a large screen would slide a permission-mode sheet up
// over the lower half of the screen. One component decides presentation for
// "a word that opens choices", and this file does not decide it at all.
//
// Vendoring into another plugin: copy this file, execution-options.ts,
// row-actions.tsx and the two rpc methods in contract.ts / server.ts
// (thread_execution_get, thread_execution_set).
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ExecutionChoice, ThreadExecution } from "@/contract";
import { RowActions } from "./row-actions";
import { TEXT_TERTIARY } from "./tone";
import { errorText, useCosRpc, useThreadExecution } from "./use-cos";

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
  const live = useThreadExecution(threadId);
  const rpc = useCosRpc();
  const [busy, setBusy] = useState(false);
  const execution = live.data;

  if (execution === null) return null;

  const current = (field: Field): string => {
    const value = execution[field];
    return choicesFor(execution, field).find((c) => c.value === value)?.short ?? value;
  };

  const pick = async (field: Field, value: string) => {
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

  return (
    <div
      data-thread-execution-bar=""
      role="group"
      aria-label="What this thread runs at, until it is changed again"
      className={cn("flex min-h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 text-[13px] leading-5", TEXT_TERTIARY)}
    >
      {(["model", "reasoningLevel", "permissionMode"] as const).map((field, index) => {
        const choices = choicesFor(execution, field);
        return (
          <Fragment key={field}>
            {index > 0 ? <span aria-hidden>·</span> : null}
            <RowActions
              align="left"
              ariaLabel={`${FIELD_TITLE[field]}: ${current(field)}. This is the stored setting and it holds for every turn.`}
              selectedId={execution[field]}
              triggerClassName={cn(
                "min-h-11 whitespace-nowrap px-2 text-foreground hover:bg-accent/60",
                busy && "pointer-events-none opacity-60",
              )}
              triggerContent={
                <span
                  title={
                    field === "reasoningLevel"
                      ? `Stored reasoning level: ${current(field)}. This holds for every turn. The composer's own picker only lasts one turn.`
                      : `${FIELD_TITLE[field]}: ${current(field)}. Stored on the thread.`
                  }
                >
                  {current(field)}
                </span>
              }
              items={choices.map((choice) => ({
                id: choice.value,
                label: choice.label,
                // The one-line description is what makes the permission modes
                // legible ("Applies edits inside the workspace automatically").
                // It is a menu row's second line, not a sheet's.
                detail: choice.description,
                run: () => void pick(field, choice.value),
              }))}
            />
          </Fragment>
        );
      })}
      {execution.catalogError === null ? null : (
        <span className="ml-auto truncate pl-2 text-[12px]" title={execution.catalogError}>
          catalog unavailable
        </span>
      )}
    </div>
  );
}
