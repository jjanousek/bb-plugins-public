// The RPC contract between server.ts and app.tsx. The app bundles this file,
// so it imports nothing at runtime except zod: a git install leaves the SDK
// package out of node_modules, and an import of it here fails that build.
// (`defineRpcContract` from the SDK returns its argument unchanged, so a
// plain object that satisfies the contract type is the same thing.)
import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** One thread's face: its stored key ("egg/teal") and whether it is hidden. */
export const faceRowSchema = z.object({ face: z.string(), hidden: z.boolean() });
export type FaceRow = z.infer<typeof faceRowSchema>;

/** The tag a thread's face is read under, so a change refreshes every reader. */
export function faceTag(threadId: string): string {
  return `face:${threadId}`;
}

export const rpcContract = {
  /**
   * The faces of these threads. A thread seen for the first time gets one
   * here, so every reader agrees on it from then on.
   */
  faces: {
    input: z.object({ keys: z.array(z.string().min(1).max(200)).max(2000) }),
    output: z.record(z.string(), faceRowSchema),
    keyTags: (key: string) => [faceTag(key)],
  },
  /** The thread menu's choices: a different face, or hide or show it. */
  face_change: {
    input: z.object({ threadId: z.string().min(1).max(200), change: z.enum(["new", "hide", "show"]) }),
    output: faceRowSchema,
  },
} satisfies PluginRpcContract;
