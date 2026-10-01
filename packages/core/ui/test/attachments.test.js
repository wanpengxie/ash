import assert from "node:assert/strict";
import test from "node:test";
import { decodeInlineAttachment, openInlineBlob } from "../js/attachments.js";

const wire = (name, mime_type, bytes) => ({ name, mime_type, data: Buffer.from(bytes).toString("base64") });

test("inline attachment is decoded only from canonical bounded base64", () => {
  const decoded = decodeInlineAttachment(wire("a/b.txt", "text/plain", "hello"));
  assert.equal(decoded.name, "a_b.txt");
  assert.equal(decoded.preview, false);
  assert.equal(decoded.mime_type, "application/octet-stream");
  assert.equal(Buffer.from(decoded.bytes).toString(), "hello");
  for (const item of [{ data: "!!!!", mime_type: "text/plain" }, { data: "eA", mime_type: "text/plain" }, { data: "eA==\n", mime_type: "text/plain" }]) assert.throws(() => decodeInlineAttachment(item));
});

test("only verified raster signatures get an active preview; SVG and fake image bytes download inert", () => {
  const png = decodeInlineAttachment(wire("photo.png", "image/png", Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1)));
  assert.equal(png.preview, true);
  assert.equal(png.mime_type, "image/png");
  const forged = decodeInlineAttachment(wire("fake.png", "image/png", "<script>alert(1)</script>"));
  assert.equal(forged.preview, false);
  assert.equal(forged.mime_type, "application/octet-stream");
  const svg = decodeInlineAttachment(wire("drawing.svg", "image/svg+xml", "<svg onload='alert(1)'/>"));
  assert.equal(svg.preview, false);
  assert.equal(svg.mime_type, "application/octet-stream");
});

test("temporary object URL revokes once", () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let revoked = 0;
  URL.createObjectURL = () => "blob:fixture";
  URL.revokeObjectURL = (url) => { assert.equal(url, "blob:fixture"); revoked++; };
  try {
    const opened = openInlineBlob(wire("note.txt", "text/plain", "note"));
    assert.equal(opened.url, "blob:fixture");
    opened.revoke();
    opened.revoke();
    assert.equal(revoked, 1);
  } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});
