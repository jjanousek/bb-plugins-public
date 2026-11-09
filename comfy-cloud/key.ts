// key.ts: where the Comfy Cloud API key comes from.
//
// Resolution order (server side only, re-read on every generation):
//   1. the secret plugin setting `apiKey`
//   2. COMFY_API_KEY= in a git-ignored .env next to the plugin code
//      (the directory of server.ts, and its parent for a dist/ load)
//   3. COMFY_API_KEY= in the file named by the `keyFile` setting
// The key never leaves this process: it is not logged, not stored, not
// returned. `source` is the only thing callers may show.
import fs from "node:fs";
import path from "node:path";
import type { KeySource } from "./contract";

export const KEY_NAME = "COMFY_API_KEY";

/** Read one variable out of dotenv text. Handles `export`, quotes and trailing comments. */
export function parseDotenv(text: string, name: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    return value === "" ? null : value;
  }
  return null;
}

/** COMFY_API_KEY from a dotenv file, or null when the file is missing or has no key. */
export function readKeyFromFile(file: string): string | null {
  try {
    return parseDotenv(fs.readFileSync(file, "utf8"), KEY_NAME);
  } catch {
    return null;
  }
}

export interface KeyLookup {
  /** Value of the secret `apiKey` setting. */
  settingKey?: string | null;
  /** Directories that may hold a git-ignored `.env` (plugin dir, then its parent). */
  pluginDirs: readonly string[];
  /** Value of the `keyFile` setting. */
  keyFile?: string | null;
}

export interface ResolvedKey {
  key: string | null;
  source: KeySource;
}

export function resolveKey(lookup: KeyLookup): ResolvedKey {
  const setting = (lookup.settingKey ?? "").trim();
  if (setting !== "") return { key: setting, source: "setting" };
  for (const dir of lookup.pluginDirs) {
    const key = readKeyFromFile(path.join(dir, ".env"));
    if (key) return { key, source: "plugin-env" };
  }
  const keyFile = (lookup.keyFile ?? "").trim();
  if (keyFile !== "") {
    const key = readKeyFromFile(keyFile);
    if (key) return { key, source: "key-file" };
  }
  return { key: null, source: null };
}

/** Shown when no source has a key. Names the three options and never a value. */
export const CONFIGURE_HINT =
  "No Comfy Cloud API key found. Provide one of: the secret setting apiKey (bb plugin config comfy-cloud set apiKey <key>), " +
  "COMFY_API_KEY= in a git-ignored .env in the plugin folder, or the keyFile setting pointing at a dotenv file that holds COMFY_API_KEY " +
  "(bb plugin config comfy-cloud set keyFile /path/to/.env). Then run: bb plugin reload comfy-cloud";
