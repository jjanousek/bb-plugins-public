// The one delete confirmation, shared by the gallery and the viewer: it shows
// the thumbnail and the prompt's first line so nobody deletes the wrong one.
//
// It is the plugin's only confirm, and that is deliberate. A dialog is for
// irreversible actions only, so Cancel, Retry and the star have none: a
// cancelled row keeps its status, its params and its workflow file, so Retry
// recovers it. Deleting removes the media, the workflow JSON, the job record
// and the row, so there is nothing left to recover from. Every confirm on a
// safe action makes this one weaker.
//
// The host's dialog draws its close X with the host icon set, which no surface
// of this plugin may show, so `hideCloseButton` turns it off: Escape and the
// Cancel button already close this. The footer uses the kit's own 28 px
// buttons rather than the host `Button`, so the dialog matches the panel.
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Asset } from "../../contract";
import { firstLine, hasStill, kindAndSize, mediaUrl } from "./format";
import { Glyph } from "./glyphs";
import { spentText } from "./cost";
import { GhostButton, Hairline, PrimaryButton } from "./kit";
import type { PreviewBase } from "./use-comfy";

export interface DeleteAssetDialogProps {
  asset: Asset | null;
  preview: PreviewBase | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (asset: Asset) => void;
}

export function DeleteAssetDialog({ asset, preview, onOpenChange, onConfirm }: DeleteAssetDialogProps) {
  // The 64 px square asks for the thumbnail, never the whole original.
  const url = asset !== null && asset.file !== null ? mediaUrl(preview, asset, "thumb") : null;
  const kind = asset?.kind === "video" ? "video" : "image";
  const hasFile = asset !== null && asset.file !== null;
  const spent = asset === null ? null : spentText(asset);
  return (
    <Dialog open={asset !== null} onOpenChange={onOpenChange}>
      <DialogContent hideCloseButton className="max-w-sm gap-4">
        <DialogHeader className="space-y-1.5">
          <DialogTitle className="text-[15px]">Delete this {kind}?</DialogTitle>
          {/* Name what goes, not just that it is permanent. The prompt is the
              part that makes Regenerate and Tweak possible, and the credits are
              the part that does not come back, so both are said out loud.
              "This cannot be undone" on its own is true and carries nothing. */}
          <DialogDescription className="text-[12px] leading-5">
            {hasFile ? `The ${kind}, its prompt and its workflow all go` : "Its prompt and its workflow go"}, so there is no
            Regenerate and no Tweak.{spent === null ? "" : ` It cost ${spent}.`} There is no undo.
          </DialogDescription>
        </DialogHeader>
        {asset === null ? null : (
          <div className="flex items-center gap-3">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40 ring-1 ring-border/60">
              {url === null ? (
                asset.kind === "video" ? (
                  <Glyph.video className="size-4 text-muted-foreground" />
                ) : (
                  <Glyph.image className="size-4 text-muted-foreground" />
                )
              ) : asset.kind === "video" && !hasStill(asset) ? (
                <video src={url} muted playsInline preload="metadata" className="size-full object-cover" aria-hidden />
              ) : (
                <img src={url} alt="" className="size-full object-cover" />
              )}
            </div>
            <div className="min-w-0">
              <p className="line-clamp-2 text-[13px] leading-5 text-foreground">{firstLine(asset.prompt, 90) || asset.id}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {kindAndSize(asset)}, {asset.id}
              </p>
            </div>
          </div>
        )}
        <DialogFooter className="gap-1.5 max-md:pointer-coarse:flex-col max-md:pointer-coarse:items-stretch max-md:pointer-coarse:gap-3">
          {/* Cancel takes the focus, so a return key pressed out of habit
              cancels rather than deletes. Radix would focus the first tabbable
              child anyway, which is this one, but the dialog must not depend on
              that: test/app.test.tsx asserts the focus lands here. */}
          <GhostButton autoFocus className="max-md:pointer-coarse:w-full" onClick={() => onOpenChange(false)}>
            Cancel
          </GhostButton>
          {/* Separated, not adjacent at equal weight: a vertical hairline in a
              row, a horizontal one once the buttons stack on touch. */}
          <Hairline vertical className="mx-0.5 max-md:pointer-coarse:h-px max-md:pointer-coarse:w-full max-md:pointer-coarse:self-auto" />
          <PrimaryButton
            tone="danger"
            glyph="trash"
            className="max-md:pointer-coarse:w-full"
            onClick={() => {
              if (asset !== null) onConfirm(asset);
              onOpenChange(false);
            }}
          >
            Delete
          </PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
