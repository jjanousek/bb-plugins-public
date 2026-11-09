# Vendoring the execution bar

`ThreadExecutionBar` is one line above a plugin-hosted `ThreadChat` on finger
surfaces: model, reasoning level and permission mode as 44px words, each
opening a bottom sheet. It exists because the host collapses its composer
footer to zero height on compact layouts (a bb host limit), so on a phone the
host's own pickers vanish when tapped. On a mouse it renders nothing.

## Files to copy

- `components/cos/thread-execution-bar.tsx`: the bar and the sheet.
- `components/cos/execution-options.ts`: pure mapping from bb's catalog to
  choices; no imports, shared by app and server bundles. Tests are the
  `execution options` block in `core.test.ts`; copy them too.

The bar imports `ResponsiveDrawerShell` (`components/ui/responsive-overlay.tsx`),
`useIsFingerSurface` (`components/cos/ui.tsx`), `Glyph` with the `check` glyph,
`TEXT_TERTIARY` from `tone.ts`, and `errorText` / `useCosRpc` /
`useThreadExecution` from `use-cos.ts`. Rename the rpc hook to your plugin's
rpc client; `useThreadExecution` is one `useLive` around `thread_execution_get`.

## Rpc pair to add (contract.ts, server.ts)

- `thread_execution_get({ threadId })` returns `ThreadExecution | null`:
  `providerId`, `model`, `reasoningLevel`, `permissionMode`, and three choice
  lists (`models`, `reasoningLevels`, `permissionModes`, each
  `{ value, label, short, description? }`), plus `catalogError`.
- `thread_execution_set({ threadId, model?, reasoningLevel?, permissionMode? })`
  changes one field and returns the new `ThreadExecution`.

Schemas: `threadExecutionSchema`, `reasoningLevelSchema`, `permissionModeSchema`
in `contract.ts`. Server side: `storedPermissionMode`, `loadCatalog`,
`threadExecution`, `setThreadExecution`, `permissionFor` in `server.ts`
(section "thread execution").

## SDK calls

Reads:

1. `bb.sdk.threads.defaultExecutionOptions({ threadId })`: what the next turn
   runs with (`model`, `reasoningLevel`, `permissionMode`). This is
   `GET /threads/:id/default-execution-options`; the thread DTO itself does
   not carry model or reasoning.
2. `bb.sdk.system.executionOptions({ providerId, environmentId })`: the
   provider's `models` (with `supportedReasoningEfforts` and
   `defaultReasoningEffort`), `providers[].reasoningLevels` labels,
   `providers[].capabilities.permissionModes`, and `permissionCeiling`.

Write:

- `bb.sdk.threads.update({ threadId, model?, reasoningLevel? })`: the thread's
  sticky overrides, the same `PATCH /threads/:id` the host picker makes. bb
  rejects a model not in the catalog and a level the model does not support,
  so `setThreadExecution` sends the model's default level with a model change
  when the current level is unsupported (`reasoningForModel`). `null` clears
  an override.

## Permission mode convention

bb has no thread-level permission setter; permission is per turn. The plugin
stores the bar's choice in its kv under `permission.<threadId>` and every
send the plugin makes to that thread spreads `await permissionFor(threadId)`
into `bb.sdk.threads.send(...)`. A turn typed by hand in the host composer
before the plugin has sent anything still runs with the host's mode. Keep the
same key so a thread moved between plugins reads the same choice.

## Where to mount

Directly above `<ThreadChat>`, outside it; `ThreadChat` has `leadingContent`
(scrolls with the transcript) but no slot above the composer. Wrap the chat in
`<div className="min-h-0 flex-1">` so the bar keeps its height.
