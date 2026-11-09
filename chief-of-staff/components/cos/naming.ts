// Pure naming helpers for every surface that prints a worker. No imports at
// all, so core.test.ts can exercise them under node and the app, the server
// and avatars.ts can all share one copy.
import { executionWords } from "./execution-levels.ts";

/**
 * The display title for a worker name: "docs-qa" becomes "Docs QA",
 * "infra-helper" becomes "Infra Helper", "fact-checker" becomes "Fact Checker".
 * Convention: a one or two word role in Title Case.
 */
const TITLE_WORDS: Record<string, string> = {
  bb: "bb",
  qa: "QA",
  ui: "UI",
  ux: "UX",
  ai: "AI",
  api: "API",
  pdf: "PDF",
  html: "HTML",
  seo: "SEO",
  us: "US",
  ceo: "CEO",
  cto: "CTO",
  cfo: "CFO",
  coo: "COO",
  // Small words stay lower case inside a title: "Head of Sales", not
  // "Head Of Sales". A small word that STARTS a title is capitalised.
  of: "of",
  and: "and",
  the: "the",
  for: "for",
  to: "to",
  in: "in",
  on: "on",
};

/** Words that stay lower case unless they open the title. */
const SMALL_WORDS = new Set(["of", "and", "the", "for", "to", "in", "on"]);

export function titleFor(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter((part) => part !== "")
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (index === 0 && SMALL_WORDS.has(lower)) return part.charAt(0).toUpperCase() + part.slice(1);
      return TITLE_WORDS[lower] ?? part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

/**
 * The name a row prints: the worker's thread title ("Docs QA"), falling back
 * to the title the slug would get on brand. The slug (`docs-qa`) is the
 * identifier the chief and the CLI use; it stays in the Delegate, Adopt and
 * Import fields, in "imported as", and on the name's tooltip, never on the
 * name line itself. Proper names, not slugs, are shown, and bb's sidebar
 * already shows the title, so the two must agree.
 */
export function displayName(worker: { title: string | null; name: string }): string {
  const title = worker.title?.trim();
  return title !== undefined && title !== "" ? title : titleFor(worker.name);
}

const PERSONAL_PROJECT_NAMES = new Set(["personal"]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((word) => word !== "");
}

/**
 * The project word after the name, or undefined when it would only repeat the
 * name (`Docs QA · docs`, `Photo App Dev · photo-app`) or identify nothing
 * (`· Personal`, `· personal`). Only a project that adds a fact survives:
 * `Data QA · north_example`, `Website Dev · website`. The full project stays
 * in aria-labels and in the Worker tab header, which has room to be complete.
 */
export function projectLabel(worker: { name: string; projectName: string }): string | undefined {
  const project = worker.projectName.trim();
  if (project === "") return undefined;
  if (PERSONAL_PROJECT_NAMES.has(project.toLowerCase())) return undefined;
  const nameWords = new Set(words(worker.name));
  const projectWords = words(project);
  if (projectWords.length > 0 && projectWords.every((word) => nameWords.has(word))) return undefined;
  return project;
}

/**
 * "3 new for chief": finished turns the chief has not read yet, as plain words
 * for the name line, never a bubble.
 *
 * The words say whose count it is. A bare "3 new" on a surface read by the
 * user would read as three things new to the user, but the count is moved by
 * cos_read, cos_wait and a delivered report, which are all the chief's
 * actions. What is new to the user is `needIsNew`.
 */
export function unreadLabel(worker: { newTurns: number }): string | undefined {
  return worker.newTurns > 0 ? `${worker.newTurns} new for chief` : undefined;
}

/**
 * "new": this worker is asking the user something not yet looked at.
 *
 * A word and not a colour, because a level carried by colour alone is lost
 * in grayscale. It clears when the user opens the row or acts on it, and comes back on
 * its own when the worker says something different.
 */
export function newForYouLabel(worker: { needIsNew: boolean }): string | undefined {
  return worker.needIsNew ? "new" : undefined;
}

/**
 * Where the worker's thread runs, in the CLI's own words ("claude-code",
 * "acp-omp example-model-1.0"), or undefined when unknown. The
 * same shortening as `executionLabel` in server.ts, so the board and
 * `bb cos roster` never disagree.
 */
export function executionLabel(worker: {
  providerId: string | null;
  model: string | null;
  reasoningLevel?: string | null;
}): string | undefined {
  // `executionWords` is the shared body; undefined is this caller's empty.
  return executionWords(worker.providerId ?? null, worker.model, worker.reasoningLevel ?? null) ?? undefined;
}

const KIND_PREFIX =
  /^(Delegated|Failed|Forwarded to the chief|Imported|Remodelled|Adopted|Retired|Dismissed|Reported|Spawned|Worker created):\s*/;

/**
 * An activity excerpt without the kind word the row already prints as its
 * label. Rows written by older versions carry "Failed: ..." and "Forwarded to
 * the chief: ..." prefixes; stripping here keeps them reading right.
 */
export function stripKindPrefix(excerpt: string): string {
  const stripped = excerpt.replace(KIND_PREFIX, "");
  return stripped === "" ? excerpt : stripped;
}
