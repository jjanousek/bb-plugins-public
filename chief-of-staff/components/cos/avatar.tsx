// A worker's avatar: one flat blob with two white eye slits, inline SVG.
//
// The shape and colour come from avatars.ts, shared with the server, so the
// picture here is the same file `bb cos brand` exports to $HOME/.bb/cos-avatars.
// It sits after the 6px status dot on a worker row; the dot keeps its own
// gutter on the canvas so the five-level attention system keeps
// its one coloured pixel on the canvas its contrast was chosen for.
import type { AvatarDto } from "@/contract";
import { avatarInner } from "@/avatars";
import { cn } from "@/lib/utils";

export function Avatar({
  avatar,
  size = 20,
  className,
  label,
}: {
  avatar: AvatarDto | null;
  /** CSS pixels. 20 fits a row; 28 the worker header. */
  size?: number;
  className?: string;
  /** Accessible name, usually the worker name. Empty means decorative. */
  label?: string;
}) {
  if (avatar === null) {
    // Not branded yet: an empty ring the same size, so rows stay aligned.
    return (
      <span
        aria-hidden
        className={cn("inline-block shrink-0 rounded-full ring-1 ring-inset ring-muted-foreground/40", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0", className)}
      // The markup is generated from a fixed table in avatars.ts, never from user input.
      dangerouslySetInnerHTML={{ __html: avatarInner(avatar, size) }}
    />
  );
}

/**
 * A worker's avatar for a row's lead slot. Just the face: the status dot sits
 * in the row's own gutter on the canvas (ui.tsx Row), where its colour was
 * tuned, and the unread count is plain words on the name line. Nothing is
 * pinned to the avatar's corners.
 */
export function WorkerMark({
  avatar,
  size = 20,
  label,
}: {
  avatar: AvatarDto | null;
  /** 20 fits a row; 32 the Worker tab header. */
  size?: number;
  label?: string;
}) {
  return <Avatar avatar={avatar} size={size} label={label} />;
}
