// Which skills the chief is granted through `bb.agents.configure`.
//
// bb accepts only skill ids the plugin itself ships: the directory names under
// this plugin's `skills/` folder (`discoverPluginSkillIds` in bb's server).
// A user skill such as an optional, third-party `unslop` skill in ~/.bb/skills
// is not the plugin's to grant, and it does not need a grant either: the plugin
// selection filters only the plugin's own skills, so user skills reach the
// chief regardless. When installed, the chief loads it as
// `bb-global-skills:unslop` with no grant.
//
// Listing an id that is not ours is not a warning bb shrugs off. configure()
// throws, and the host then drops the plugin's whole configuration for that
// turn, tools included, while the log says only "selected unknown skill id".
// So the list is checked against the skills folder on disk before it is
// returned.

import fs from "node:fs";
import path from "node:path";

/** Skills the chief is granted. Only ids from this plugin's `skills/` folder. */
export const CHIEF_SKILLS: readonly string[] = ["chief-of-comms"];

/** The skill ids bb will accept from this plugin: the directory names under `skills/`. */
export function shippedSkillIds(skillsDir: string): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")))
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

/**
 * Split a wanted list into what bb will accept and what it would refuse. The
 * refused ids are dropped rather than passed through, because one unknown id
 * costs the chief every tool for the turn.
 */
export function grantableSkills(wanted: readonly string[], shipped: ReadonlySet<string>): { granted: string[]; unknown: string[] } {
  return {
    granted: wanted.filter((id) => shipped.has(id)),
    unknown: wanted.filter((id) => !shipped.has(id)),
  };
}
