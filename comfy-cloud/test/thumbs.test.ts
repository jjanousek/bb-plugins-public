// The small copies the Library draws instead of the originals. Pure here: the
// arguments and the paths, with no ffmpeg run, so this says nothing about
// whether the box has ffmpeg and everything about what it would be asked.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DERIVATIVES, DERIVATIVE_REVISION, derivativeArgs, derivativePath, makeDerivative } from "../thumbs";
import { VIEW_EDGE_PX } from "../components/comfy/format";

const SRC = "/data/.bb/plugins/comfy-cloud/assets/2031-08-05/img_abcd1234.png";

describe("where a derivative goes", () => {
  it("sits beside the asset under its own name", () => {
    // Beside it, so the media route serves it by the same relative path and
    // deleteAsset can find it by name rather than by a column that may be null.
    expect(derivativePath(SRC, "thumb")).toBe(path.join(path.dirname(SRC), "img_abcd1234.thumb.webp"));
    expect(derivativePath(SRC, "medium")).toBe(path.join(path.dirname(SRC), "img_abcd1234.medium.webp"));
  });

  it("replaces the asset's extension rather than appending to it", () => {
    // A video's poster frame is a webp, not an mp4.webp.
    expect(derivativePath("/a/2026/vid_x.mp4", "thumb")).toBe(path.join("/a/2026", "vid_x.thumb.webp"));
  });
});

describe("what ffmpeg is asked for", () => {
  it("fits the long edge and never upscales", () => {
    // `min(edge, iw)` and `min(edge, ih)` inside a box, so a portrait picture
    // is capped on its height too, and a 400 px picture stays 400 px rather
    // than being blown up and served as a bigger file than the original.
    for (const kind of ["thumb", "medium"] as const) {
      const args = derivativeArgs(SRC, "/tmp/out.webp", kind, "image");
      const { edge } = DERIVATIVES[kind];
      expect(args.join(" ")).toContain(`scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`);
    }
  });

  it("keeps both edges even, which webp needs", () => {
    expect(derivativeArgs(SRC, "/tmp/out.webp", "thumb", "image").join(" ")).toContain("force_divisible_by=2");
  });

  it("names the format, since it writes to a .part file", () => {
    const args = derivativeArgs(SRC, "/tmp/out.webp.part", "thumb", "image");
    expect(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2)).toEqual(["-f", "webp"]);
  });

  it("seeks a second into a video and takes one frame", () => {
    // Frame zero of a generated clip is often a fade from black, which makes a
    // poster frame that says nothing about the video.
    const video = derivativeArgs("/a/vid.mp4", "/tmp/out.webp", "thumb", "video");
    expect(video.slice(0, video.indexOf("-i"))).toContain("-ss");
    expect(video).toContain("-frames:v");
    // An image has nothing to seek.
    expect(derivativeArgs(SRC, "/tmp/out.webp", "thumb", "image")).not.toContain("-ss");
  });

  it("orders the input after the seek, or the seek is the slow kind", () => {
    const args = derivativeArgs("/a/vid.mp4", "/tmp/out.webp", "thumb", "video");
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
  });

  it("overwrites and stays quiet, since it runs inside the job loop", () => {
    const args = derivativeArgs(SRC, "/tmp/out.webp", "thumb", "image");
    expect(args).toContain("-y");
    expect(args.join(" ")).toContain("-loglevel error");
  });

  it("pins the derivative sizes and the revision together", () => {
    // If these move, DERIVATIVE_REVISION must move with them or the backfill
    // never regenerates the existing copies.
    expect(DERIVATIVES.thumb).toEqual({ edge: 512, quality: 65 });
    expect(DERIVATIVES.medium).toEqual({ edge: 2048, quality: 82 });
    expect(DERIVATIVE_REVISION).toBe(2);
  });

  it("agrees with the panel about how big the view copy is", () => {
    // The viewer sizes its stage box from VIEW_EDGE_PX before the copy has
    // loaded, so a thumbnail and the copy that replaces it share one box.
    expect(VIEW_EDGE_PX).toBe(DERIVATIVES.medium.edge);
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasFfmpeg())("a real ffmpeg run", () => {
  it("caps a portrait picture on its height and leaves no part file", async () => {
    // A synthetic test card, nothing from the library. 600x1000 portrait: a
    // width-only filter would make this 512x854; the long edge rule makes 307.2,
    // rounded to an even 308, by 512.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-thumbs-"));
    made.push(dir);
    const src = path.join(dir, "img_portrait.png");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=600x1000", "-frames:v", "1", src]);
    const out = await makeDerivative(src, "thumb", "image");
    expect(out).toBe(derivativePath(src, "thumb"));
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out as string]).toString().trim();
    expect(probe).toBe("308,512");
    expect(fs.readdirSync(dir).sort()).toEqual(["img_portrait.png", "img_portrait.thumb.webp"]);
  });

  it("gives a clip of a second or less a poster from its first frame", async () => {
    // The one second seek runs past the end of a 0.8 s clip, and ffmpeg then
    // writes an empty file, so the derivative falls back to the first frame.
    // A synthetic grey clip.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-thumbs-"));
    made.push(dir);
    const src = path.join(dir, "vid_short.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=0.8", "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);
    const out = await makeDerivative(src, "thumb", "video");
    expect(out).toBe(derivativePath(src, "thumb"));
    expect(fs.statSync(out as string).size).toBeGreaterThan(0);
    expect(fs.readdirSync(dir).sort()).toEqual(["vid_short.mp4", "vid_short.thumb.webp"]);
  });

  it("leaves the existing copy in place when a regeneration fails", async () => {
    // The backfill regenerates copies in place; a run that fails must not
    // blank a tile that was working.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comfy-thumbs-"));
    made.push(dir);
    const src = path.join(dir, "img_broken.png");
    fs.writeFileSync(src, "not a png");
    const existing = derivativePath(src, "thumb");
    fs.writeFileSync(existing, "old copy");
    expect(await makeDerivative(src, "thumb", "image")).toBe(null);
    expect(fs.readFileSync(existing, "utf8")).toBe("old copy");
    expect(fs.existsSync(`${existing}.part`)).toBe(false);
  });
});
