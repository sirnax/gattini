import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveStateDirectory } from "../src/core/state-dir.js";

test("state directory follows macOS and Linux user conventions with explicit override", () => {
  assert.equal(resolveStateDirectory({}, "darwin", "/Users/example"), "/Users/example/Library/Application Support/Gattini");
  assert.equal(resolveStateDirectory({}, "linux", "/home/example"), "/home/example/.local/state/gattini");
  assert.equal(resolveStateDirectory({ XDG_STATE_HOME: "/home/example/custom state" }, "linux", "/home/example"),
    "/home/example/custom state/gattini");
  assert.equal(resolveStateDirectory({ GATTINI_STATE_DIR: "/tmp/gattini state", XDG_STATE_HOME: "/elsewhere" }, "linux", "/home/example"),
    "/tmp/gattini state");
  assert.throws(() => resolveStateDirectory({ XDG_STATE_HOME: "relative" }, "linux", "/home/example"), /XDG_STATE_HOME/);
  assert.throws(() => resolveStateDirectory({ GATTINI_STATE_DIR: "" }, "linux", "/home/example"), /GATTINI_STATE_DIR/);
  assert.throws(() => resolveStateDirectory({}, "win32", "C:\\Users\\example"), /not defined/);
});
