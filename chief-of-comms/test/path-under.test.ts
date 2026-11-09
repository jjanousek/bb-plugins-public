// The folder check behind fileTarget. Paths are invented.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { relativeUnder } from "../path-under.ts";

describe("relativeUnder", () => {
  const root = "/srv/desma/work";

  it("keeps a file whose name starts with two dots inside the folder", () => {
    assert.equal(relativeUnder(root, "/srv/desma/work/..notes.md"), "..notes.md");
    assert.equal(relativeUnder(root, "/srv/desma/work/docs/..draft.pdf"), "docs/..draft.pdf");
  });

  it("still refuses anything outside the folder", () => {
    assert.equal(relativeUnder(root, "/srv/desma/x"), null);
    assert.equal(relativeUnder(root, "/srv/desma/work/../x"), null);
    assert.equal(relativeUnder(root, "/srv/desma/workshop/a.md"), null);
    assert.equal(relativeUnder(root, "/srv/desma/work"), null);
    assert.equal(relativeUnder(null, "/srv/desma/work/a.md"), null);
  });

  it("reads an ordinary file as inside", () => {
    assert.equal(relativeUnder(root, "/srv/desma/work/a/b.md"), "a/b.md");
  });
});
