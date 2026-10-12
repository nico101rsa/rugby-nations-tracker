// The support page's calendar section (index.html#calendars), checked against
// what build-calendars.mjs actually publishes. Subscribe, don't import: an
// https link to an .ics, tapped on an iPhone, imports a one-off copy that never
// updates (critic, 12 Oct 2026), so the https address is selectable TEXT and
// only the webcal:// link is tappable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TRACKED_CODES, SITE_URL } from "./build-calendars.mjs";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const section = html.slice(html.indexOf('id="calendars"'), html.indexOf('id="data"'));
const FILES = [...TRACKED_CODES, "all"];
const httpsUrl = (code) => `${SITE_URL}calendar/${code}.ics`;
const webcalUrl = (code) => httpsUrl(code).replace(/^https:/, "webcal:");

test("the calendars section exists and lists exactly the files the builder writes", () => {
  assert.ok(section.length > 0 && html.includes('id="data"'), "index.html has #calendars before #data");
  const listed = [...section.matchAll(/calendar\/([A-Za-z]+)\.ics/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(listed)].sort(), [...FILES].sort());
});

test("every calendar has a tappable webcal:// subscribe link", () => {
  for (const code of FILES) {
    assert.ok(section.includes(`<a href="${webcalUrl(code)}">`), `${code}: webcal link`);
  }
});

test("no https .ics address is a link anywhere on the page — it is text to copy", () => {
  assert.doesNotMatch(html, /<a\b[^>]*href="https?:[^"]*\.ics"/i);
  for (const code of FILES) {
    assert.ok(section.includes(`<code>${httpsUrl(code)}</code>`), `${code}: https address as selectable text`);
  }
  assert.equal((section.match(/copy this address/g) ?? []).length, FILES.length, "each address says it is for copying");
});

test("the page still says subscribe, don't import", () => {
  assert.match(section, /Subscribe, don’t import/);
});
