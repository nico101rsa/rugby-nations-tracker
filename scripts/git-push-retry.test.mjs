import test from "node:test";
import assert from "node:assert/strict";
import { pushWithRetries } from "./git-push-retry.mjs";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("a failing pull that left no rebase behind (a fetch race) does not abort the remaining attempts", () => {
  const cmds = [];
  let pushes = 0;
  const run = (cmd) => {
    cmds.push(cmd);
    if (cmd.startsWith("git pull")) throw new Error("rebase raced too");
    if (cmd === "git rebase --abort") throw new Error("fatal: No rebase in progress?");
    if (cmd === "git push" && ++pushes <= 2) throw new Error("failed to push some refs");
  };
  assert.equal(pushWithRetries({ run }), true);
  assert.equal(cmds.filter((c) => c === "git push").length, 3);
  assert.ok(!cmds.some((c) => c.startsWith("git reset")), "a race is not a conflict: nothing is dropped");
});

test("a CONFLICTING rebase is aborted and this pass's commit dropped, so the checkout is never left mid-rebase", () => {
  const cmds = [];
  const logged = [];
  const run = (cmd) => {
    cmds.push(cmd);
    if (cmd === "git push") throw new Error("failed to push some refs");
    if (cmd.startsWith("git pull")) throw new Error("CONFLICT (content): Merge conflict in standings.json");
  };
  assert.equal(pushWithRetries({ run, log: (m) => logged.push(m) }), false);
  assert.deepEqual(cmds, ["git push", "git pull --rebase --autostash", "git rebase --abort", "git reset --keep @{u}"]);
  assert.match(logged[0], /next pass rebuilds/);
});

test("a conflict whose reset git refuses keeps the commit local and stops trying", () => {
  const cmds = [];
  const logged = [];
  const run = (cmd) => {
    cmds.push(cmd);
    if (cmd === "git push") throw new Error("failed to push some refs");
    if (cmd.startsWith("git pull")) throw new Error("CONFLICT");
    if (cmd.startsWith("git reset")) throw new Error("error: Entry 'nations.json' not uptodate. Cannot merge.");
  };
  assert.equal(pushWithRetries({ run, log: (m) => logged.push(m) }), false);
  assert.equal(cmds.filter((c) => c === "git push").length, 1);
  assert.match(logged[0], /stays local/);
});

// The real thing, against real git: two writers of one derived file, the
// second one's rebase conflicts. Afterwards the second checkout must be on
// its branch, level with origin, and able to publish its next pass.
test("real git: after a conflict the next pass publishes on top of the other writer", () => {
  const root = mkdtempSync(join(tmpdir(), "push-retry-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: root };
  const sh = (cwd, cmd) => execSync(cmd, { cwd, env, stdio: "pipe" }).toString().trim();
  try {
    sh(root, "git init -q --bare -b main origin.git");
    sh(root, "git clone -q origin.git a");
    writeFileSync(join(root, "a", "standings.json"), '{\n  "updatedAt": "t0"\n}\n');
    writeFileSync(join(root, "a", "nations.json"), "n0\n");
    sh(join(root, "a"), "git add -A && git commit -qm base && git push -q origin main");
    sh(root, "git clone -q origin.git b");
    const b = join(root, "b");

    // Writer A (team-events) lands first; writer B (the burst) changed the same line.
    writeFileSync(join(root, "a", "standings.json"), '{\n  "updatedAt": "tA"\n}\n');
    sh(join(root, "a"), "git commit -qam A && git push -q origin main");
    writeFileSync(join(b, "standings.json"), '{\n  "updatedAt": "tB"\n}\n');
    sh(b, "git commit -qam B");
    // An uncommitted file another step wrote, which upstream did not touch, survives.
    writeFileSync(join(b, "nations.json"), "n-fresh\n");

    const logged = [];
    const ok = pushWithRetries({ run: (cmd) => sh(b, cmd), log: (m) => logged.push(m) });
    assert.equal(ok, false);
    assert.match(logged[0], /next pass rebuilds/);
    assert.ok(!existsSync(join(b, ".git", "rebase-merge")) && !existsSync(join(b, ".git", "rebase-apply")), "not mid-rebase");
    assert.equal(sh(b, "git rev-parse HEAD"), sh(b, "git rev-parse @{u}"), "level with origin");
    assert.equal(readFileSync(join(b, "standings.json"), "utf8"), '{\n  "updatedAt": "tA"\n}\n');
    assert.equal(readFileSync(join(b, "nations.json"), "utf8"), "n-fresh\n", "uncommitted work kept");

    // The next pass: rebuild, commit, push — it lands.
    writeFileSync(join(b, "standings.json"), '{\n  "updatedAt": "tB2"\n}\n');
    sh(b, "git commit -qam B2");
    assert.equal(pushWithRetries({ run: (cmd) => sh(b, cmd), log: () => {} }), true);
    assert.equal(sh(root, "git --git-dir origin.git show main:standings.json"), '{\n  "updatedAt": "tB2"\n}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pushOutcome tells a conflict from a lost race, and push-data exits red only on the lost race", async () => {
  const { pushOutcome } = await import("./git-push-retry.mjs");
  const { exitCodeFor } = await import("./push-data.mjs");
  const conflict = (cmd) => {
    if (cmd === "git push") throw new Error("failed to push some refs");
    if (cmd.startsWith("git pull")) throw new Error("CONFLICT");
  };
  const quiet = () => {};
  assert.equal(pushOutcome({ run: () => {}, log: quiet }), "pushed");
  assert.equal(pushOutcome({ run: conflict, log: quiet }), "dropped");
  assert.equal(pushOutcome({ run: (c) => { if (c.startsWith("git reset")) throw new Error("refused"); conflict(c); }, log: quiet }), "kept");
  assert.equal(pushOutcome({ run: (c) => { if (c === "git push") throw new Error("rejected"); }, log: quiet }), "lost");
  assert.deepEqual(["pushed", "dropped", "kept", "lost"].map(exitCodeFor), [0, 0, 0, 1]);
});

test("refresh-data's final push goes through push-data, not a bare rebase that exits red on a conflict", () => {
  const yml = readFileSync(new URL("../.github/workflows/refresh-data.yml", import.meta.url), "utf8");
  assert.match(yml, /node scripts\/push-data\.mjs/);
  assert.doesNotMatch(yml, /git pull --rebase --autostash && git push/);
});
