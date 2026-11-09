// Opens a local file link in bb's file panel, for chat that bb's `ThreadChat`
// renders on a plugin surface.
//
// The problem: on the Chief page, [x.pdf](/home/...) in the chief's
// chat would open a browser tab on bb's home page instead of the file. bb's own
// thread route hands its chat a local-file handler through a context that a
// plugin cannot provide, and `ThreadChat` takes no prop for it, so on a plugin
// surface the link is a plain anchor to the path and the click leaves bb.
//
// This wraps the chat and catches that click before the anchor acts on it. A
// plain left click on a link `localFileLink` recognises is resolved on the
// server (`file_target`: the thread's storage, then its workspace, then bb's
// machine, the order bb's thread view uses) and handed to
// `experimental_openFilePreview`. Storage and workspace come first because bb's
// PDF viewer cannot read a bare host file from a plugin surface: a PDF shows
// "Preview not available" as a host target and renders as a workspace one.
// Web links, app routes and modified clicks are
// left exactly as they were. Remove this when `ThreadChat` opens local files
// itself.
import { useEffect, useRef, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "@/contract";
import { localFileLink, type LocalFileLink } from "./local-file-link";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Navigate = ReturnType<typeof useBbNavigate>;

/** Resolve and open one local file. False when there was nothing to open it with. */
async function openLocalFile(rpc: Rpc, navigate: Navigate, threadId: string | null, link: LocalFileLink): Promise<boolean> {
  let target;
  try {
    target = (await rpc.call("file_target", { threadId, path: link.path })).target;
  } catch {
    return false;
  }
  if (target === null) return false;
  return navigate.experimental_openFilePreview({
    target,
    location: link.line === null ? null : { kind: "range", startLine: link.line.start, endLine: link.line.end },
  });
}

/**
 * Open a board link: a worker thread, a web page, or a file on bb's machine in
 * bb's file panel. Returns false for anything it could not open, so the caller
 * can fall back (the board copies the text). `threadId` is the thread the link
 * came from, when there is one; the server falls back to the chief's.
 */
function useOpenLink(): (href: string, threadId?: string | null) => Promise<boolean> {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  return async (href, threadId = null) => {
    if (href.startsWith("thr_")) {
      navigate.toThread(href);
      return true;
    }
    if (/^https?:/iu.test(href)) {
      // bb's own URL handling first (its browser preference), then a tab.
      if (!navigate.openUrl(href)) window.open(href, "_blank", "noopener");
      return true;
    }
    const link = localFileLink(href);
    return link === null ? false : openLocalFile(rpc, navigate, threadId, link);
  };
}

/**
 * A board link's click: open it with `useOpenLink`, and copy what cannot be
 * opened, since there is nowhere to open it. One copy, shared by the board
 * list and the queue.
 */
export function useOpenOrCopyLink(): (href: string, threadId: string | null) => void {
  const open = useOpenLink();
  return (href, threadId) =>
    void open(href, threadId).then((opened) => {
      if (opened) return;
      void navigator.clipboard?.writeText(href).then(
        () => toast.success(`Copied ${href}`),
        () => toast.error("Could not copy that path."),
      );
    });
}

/** Wrap a `ThreadChat` for `threadId` so its local file links open in the file panel. */
export function LocalFileLinks({
  threadId,
  children,
  className,
}: {
  threadId: string;
  children: ReactNode;
  className?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (anchor === null || !root.contains(anchor)) return;
      const link = localFileLink(anchor.getAttribute("href"));
      if (link === null) return;
      // The anchor would open bb's home page in a new tab; nothing about that
      // is worth keeping, so it is stopped even if the file then fails to open.
      event.preventDefault();
      event.stopPropagation();
      void openLocalFile(rpc, navigate, threadId, link);
    };
    // Capture, so this runs before the anchor's own handler sends it to a tab.
    root.addEventListener("click", onClick, true);
    return () => root.removeEventListener("click", onClick, true);
  }, [navigate, rpc, threadId]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
