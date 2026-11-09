// Bloom: the six glyphs Claude Code blooms through while it thinks, in order.
// No imports, so core.test.ts can check it under node; the sidebar faces script
// is the only caller. Each frame holds for 250ms, so one bloom is 1.5s.
export const BLOOM_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"] as const;
export const BLOOM_FRAME_MS = 250;
