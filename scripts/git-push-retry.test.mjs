import test from "node:test";
import assert from "node:assert/strict";
import { pushWithRetries } from "./git-push-retry.mjs";

const recorder = (failUntil) => {
  const cmds = [];
  let pushes = 0;
  return {
    cmds,
    run: (cmd) => {
      cmds.push(cmd);
      if (cmd === "git push" && ++pushes <= failUntil) throw new Error("failed to push some refs");
    },
  };
};

test("a push that lands first time does not rebase", () => {
  const r = recorder(0);
  assert.equal(pushWithRetries({ run: r.run }), true);
  assert.deepEqual(r.cmds, ["git push"]);
});

test("a lost race is rebased and retried", () => {
  const r = recorder(1);
  assert.equal(pushWithRetries({ run: r.run }), true);
  assert.deepEqual(r.cmds, ["git push", "git pull --rebase --autostash", "git push"]);
});

test("a SECOND lost race is retried too — the case that killed run 4349", () => {
  const r = recorder(2);
  assert.equal(pushWithRetries({ run: r.run }), true);
  assert.equal(r.cmds.filter((c) => c === "git push").length, 3);
});

test("gives up quietly rather than throwing, so the caller can carry on", () => {
  const r = recorder(Infinity);
  const logged = [];
  assert.equal(pushWithRetries({ run: r.run, log: (m) => logged.push(m) }), false);
  assert.equal(r.cmds.filter((c) => c === "git push").length, 4);
  assert.match(logged[0], /stays local/);
});

test("a failing rebase does not abort the remaining attempts", () => {
  const cmds = [];
  let pushes = 0;
  const run = (cmd) => {
    cmds.push(cmd);
    if (cmd.startsWith("git pull")) throw new Error("rebase raced too");
    if (cmd === "git push" && ++pushes <= 2) throw new Error("failed to push some refs");
  };
  assert.equal(pushWithRetries({ run }), true);
  assert.equal(cmds.filter((c) => c === "git push").length, 3);
});
