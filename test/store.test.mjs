// Pure-logic tests for the channel-name normalization + file mapping that the
// MCP server, both hooks, and coord-chat all reimplement. If these drift, the
// shared cursor files stop meaning the same thing across processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { normalizeRoom, roomFile, ROOM_FILE, ROOMS_DIR, DEFAULT_ROOM } = await import("../dist/store.js");

test("normalizeRoom strips '#', lowercases, and restricts charset", () => {
  assert.equal(normalizeRoom("#SEO"), "seo");
  assert.equal(normalizeRoom("  #Proj-1  "), "proj-1");
  assert.equal(normalizeRoom("a b!c@d"), "abcd");
  assert.equal(normalizeRoom("keep.dots_and-dashes"), "keep.dots_and-dashes");
});

test("normalizeRoom falls back to the default channel for empty input", () => {
  assert.equal(normalizeRoom(undefined), DEFAULT_ROOM);
  assert.equal(normalizeRoom(""), DEFAULT_ROOM);
  assert.equal(normalizeRoom("###"), DEFAULT_ROOM);
  assert.equal(normalizeRoom("!@#$%"), DEFAULT_ROOM);
});

test("roomFile maps the default channel to the legacy room.jsonl", () => {
  assert.equal(roomFile("general"), ROOM_FILE);
  assert.equal(roomFile("#general"), ROOM_FILE);
});

test("roomFile cannot escape the rooms directory (path-traversal safety)", () => {
  for (const evil of ["../../etc/passwd", "..", "../../../root", "/abs/path"]) {
    const f = roomFile(evil);
    // Every non-default channel file must live directly inside ROOMS_DIR.
    assert.equal(path.dirname(f), ROOMS_DIR, `escaped for input ${JSON.stringify(evil)}`);
    assert.ok(f.endsWith(".jsonl"));
  }
});
