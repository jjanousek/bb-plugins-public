// Local file links in the chief drawer's chat. The rule is bb's own, copied
// with the helper from chief-of-staff; these are its cases plus
// the two kinds of link comms itself renders, which must stay out of it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { localFileLink } from "../components/comms/local-file-link.ts";

describe("a local file link in the chief drawer opens in bb's file panel", () => {
  it("recognises absolute paths and file:// URLs, with an optional line", () => {
    const pdf = "/srv/someone/.bb/thread-storage/thr_example/files/invoice.pdf";
    assert.deepEqual(localFileLink(pdf), { path: pdf, line: null });
    assert.deepEqual(localFileLink(`file://${pdf}`), { path: pdf, line: null });
    assert.deepEqual(localFileLink("file:///home/user/My%20Notes.md"), { path: "/home/user/My Notes.md", line: null });
    assert.deepEqual(localFileLink("/home/user/server.ts:42"), { path: "/home/user/server.ts", line: { start: 42, end: 42 } });
    assert.deepEqual(localFileLink("/home/user/server.ts#L10-L20"), { path: "/home/user/server.ts", line: { start: 10, end: 20 } });
  });

  it("leaves web links, app routes and the plugin's own media links alone", () => {
    for (const href of [
      "https://mail.google.com/mail/u/?authuser=x#all/abc",
      "https://mail.superhuman.com/x/thread/abc",
      "/plugins/chief-of-comms/comms/c/mail%253Awork%253Aabc",
      "/api/v1/plugins/chief-of-comms/http/media/photo.jpg?token=x",
      "//cdn.example.com/x.js",
      "/home/user/../etc/passwd.txt",
      "#section",
      "",
      null,
    ]) {
      assert.equal(localFileLink(href), null, String(href));
    }
  });
});
