// Mail bodies as the panel and the chief read them. Superhuman's reminder mail
// pads its preview line with zero-width characters, which would render as a
// tall blank block in the conversation.
import assert from "node:assert/strict";
import { it } from "node:test";

import { bodyToText } from "../gmail.ts";

it("drops invisible preview padding and the blank block it left", () => {
  const padded = `we can pick it up on ${"\u200C ".repeat(40)}\n\n\n\n\nFriday.`;
  assert.equal(bodyToText(padded), "we can pick it up on\n\nFriday.");
});

it("keeps ordinary paragraphs as they are", () => {
  assert.equal(bodyToText("Hi Desma,\n\nSee you Friday.\nBest"), "Hi Desma,\n\nSee you Friday.\nBest");
});
