// Checks the voice assistant's rules-based fallback parser (lib/voiceParse.ts)
// with sample phrases. No database. Run: bun src/scripts/voiceParseCheck.ts
import assert from "node:assert/strict";
import { briefHtml, fixDayWords, normalizeNumbers, parseDuration, parseRange, parseVoiceText, resolveDay, resolveLooseDay, tidyBriefRules } from "../lib/voiceParse.js";
import type { ParseOptions } from "../lib/voiceParse.js";

const base: ParseOptions = {
  asking: null,
  action: null,
  // A Friday.
  today: "2026-10-23",
  me: "u-me",
  projects: [
    { id: "p-zoom", code: "ZOOM", name: "ZOOM TT_Program_Oct2026", brand: "ZOOM TT", units: ["Reel", "Video"] },
    { id: "p-mo", code: "MO", name: "MomStore_Retainer_Oct2026", brand: "MomStore", units: ["Static"] },
    { id: "p-enoc", code: "ENOC", name: "ENOC_Project_Oct2026", brand: "Emirates Gas", units: ["Others"] },
  ],
  people: [
    { id: "u-rahaf", name: "Rahaf Ali" },
    { id: "u-izzat", name: "Izzat Haddad" },
    { id: "u-vishal", name: "Vishal Kumar" },
    { id: "u-sara1", name: "Sara Khan" },
    { id: "u-sara2", name: "Sara Lopez" },
  ],
  units: ["Video", "Static", "Story", "Carousel", "Reel", "Others"],
  codes: ["ZOOM", "MO", "ENOC", "EO26"],
};
const opts = (o: Partial<ParseOptions>): ParseOptions => ({ ...base, ...o });

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

check("numbers and durations", () => {
  assert.equal(normalizeNumbers("forty five minutes"), "45 minutes");
  assert.equal(parseDuration(normalizeNumbers("two hours")), 120);
  assert.equal(parseDuration("1h 30m"), 90);
  assert.equal(parseDuration("1h30"), 90);
  assert.equal(parseDuration(normalizeNumbers("an hour and a half")), 90);
  assert.equal(parseDuration(normalizeNumbers("half an hour")), 30);
  assert.equal(parseDuration("45 mins"), 45);
});

check("days", () => {
  assert.equal(resolveDay("Thursday", base.today), "2026-10-29");
  assert.equal(resolveDay("friday", base.today), "2026-10-30");
  assert.equal(resolveDay("tomorrow", base.today), "2026-10-24");
  assert.equal(resolveDay("next monday", base.today), "2026-10-26");
  assert.equal(resolveDay("2 nov", base.today), "2026-11-02");
  assert.equal(resolveDay("in 3 days", base.today), "2026-10-26");
});

check("time range", () => {
  assert.deepEqual(parseRange("from 10 to 12:30", base.today), { start: "2026-10-23T10:00", end: "2026-10-23T12:30" });
  assert.deepEqual(parseRange("worked 11am to 1", base.today), { start: "2026-10-23T11:00", end: "2026-10-23T13:00" });
  assert.equal(parseRange("MO-6 - 2 hours", base.today), null);
});

check("create: the prototype sentence", () => {
  const out = parseVoiceText(
    "New task for ZOOM TT, three reels, BTS cutdowns from today's shoot, for Rahaf and Izzat, due Thursday.",
    base
  );
  assert.equal(out.intent, "create");
  assert.deepEqual(out.projectIds, ["p-zoom"]);
  assert.equal(out.unit, "Reel");
  assert.equal(out.quantity, 3);
  assert.equal(out.shortName, "BTS cutdowns from today's shoot");
  assert.deepEqual(out.addPeople, ["u-rahaf", "u-izzat"]);
  assert.equal(out.dueDate, "2026-10-29");
  assert.equal(out.iteration, undefined);
});

check("create: a project code before a number", () => {
  const out = parseVoiceText("New task for EO26, three statics, launch posts, for me", { ...base, codes: [...base.codes] , projects: [...base.projects, { id: "p-eo", code: "EO26", name: "ENOC | October 2026", brand: "ENOC", units: ["Static"] }] });
  assert.deepEqual(out.projectIds, ["p-eo"]);
  assert.equal(out.quantity, 3);
  assert.equal(out.shortName, "Launch posts");
  assert.deepEqual(out.addPeople, ["u-me"]);
  // A long answer to "which project?" isn't matched word by word.
  assert.equal(parseVoiceText("Cut three statics from the footage with captions", opts({ asking: "project", action: "create" })).projectIds, undefined);
});

check("create: answers", () => {
  assert.equal(parseVoiceText("New work", opts({ asking: "iteration", action: "create" })).iteration, "new");
  assert.equal(parseVoiceText("Rework", opts({ asking: "iteration", action: "create" })).iteration, "rework");
  const brief = parseVoiceText("Cut three 15-second vertical reels, Arabic captions, logo end card.", opts({ asking: "brief", action: "create" }));
  assert.equal(brief.brief, "Cut three 15-second vertical reels, Arabic captions, logo end card");
  assert.equal(brief.intent, undefined);
  const who = parseVoiceText("vishal and me", opts({ asking: "assignees", action: "create" }));
  assert.deepEqual(new Set(who.addPeople), new Set(["u-me", "u-vishal"]));
  const sara = parseVoiceText("add Sara", opts({ action: "create" }));
  assert.deepEqual(sara.ambiguousPeople, [{ said: "Sara", ids: ["u-sara1", "u-sara2"] }]);
  assert.deepEqual(parseVoiceText("remove Izzat", opts({ action: "create" })).removePeople, ["u-izzat"]);
  assert.equal(parseVoiceText("due Friday", opts({ action: "create" })).dueDate, "2026-10-30");
  assert.deepEqual(parseVoiceText("MO", opts({ asking: "project", action: "create" })).projectIds, ["p-mo"]);
});

check("start and due dates", () => {
  const a = parseVoiceText("start today due Friday", opts({ action: "create" }));
  assert.equal(a.startDate, "2026-10-23");
  assert.equal(a.dueDate, "2026-10-30");
  const b = parseVoiceText("from tomorrow to 30 Oct", opts({ action: "create", asking: "dates" }));
  assert.equal(b.startDate, "2026-10-24");
  assert.equal(b.dueDate, "2026-10-30");
  assert.equal(parseVoiceText("due in three days", opts({ action: "create" })).dueDate, "2026-10-26");
  // The date chips: "Today 23 Oct → Sat 24 Oct".
  const chip = parseVoiceText("Today 23 Oct → Sat 24 Oct", opts({ action: "create", asking: "dates" }));
  assert.equal(chip.startDate, "2026-10-23");
  assert.equal(chip.dueDate, "2026-10-24");
  assert.equal(chip.addPeople, undefined);
  assert.equal(parseVoiceText("Fri 30 Oct", opts({ action: "create", asking: "dates" })).anyDate, "2026-10-30");
  assert.equal(parseVoiceText("next Monday", opts({ action: "create", asking: "dates" })).anyDate, "2026-10-26");
  assert.equal(resolveLooseDay("Tomorrow · Sat 24 Oct", base.today), "2026-10-24");
});

check("changes with typos (a ready card)", () => {
  const c = opts({ action: "create" });
  const a = parseVoiceText("due froday and add vishal also", c);
  assert.equal(a.dueDate, "2026-10-30");
  assert.deepEqual(a.addPeople, ["u-vishal"]);
  assert.deepEqual(a.fixes, [["froday", "friday"]]);
  assert.equal(parseVoiceText("due firday", c).dueDate, "2026-10-30");
  assert.equal(parseVoiceText("due wendesday", c).dueDate, "2026-10-28");
  assert.equal(parseVoiceText("due thrusday", c).dueDate, "2026-10-29");
  assert.equal(parseVoiceText("due tmrw", c).dueDate, "2026-10-24");
  assert.equal(parseVoiceText("start tomorow", c).startDate, "2026-10-24");
  assert.deepEqual(parseVoiceText("add vishl too", c).addPeople, ["u-vishal"]);
  assert.deepEqual(parseVoiceText("plus izzat", c).addPeople, ["u-izzat"]);
  assert.deepEqual(parseVoiceText("and rahaf", c).addPeople, ["u-rahaf"]);
  assert.deepEqual(parseVoiceText("remove izat", c).removePeople, ["u-izzat"]);
  assert.deepEqual(parseVoiceText("without Rahaf", c).removePeople, ["u-rahaf"]);
  // Not a day / not a person.
  assert.equal(fixDayWords("put it in the fridge").fixes.length, 0);
  assert.equal(fixDayWords("send the money").fixes.length, 0);
  assert.equal(parseVoiceText("due sometime", c).dueDate, undefined);
});

check("field edits on a ready card", () => {
  const c = opts({ action: "create" });
  const people = [...base.people, { id: "u-mae", name: "Mae Tan" }, { id: "u-omar", name: "Omar Said" }, { id: "u-moe", name: "Moe Ali" }];
  const edit = parseVoiceText('update the brief "ehance quality if image and also adding more high quality picture over product"', { ...c, people });
  assert.equal(edit.brief, "Ehance quality if image and also adding more high quality picture over product");
  assert.equal(edit.addPeople, undefined);
  assert.equal(edit.dueDate, undefined);
  assert.equal(parseVoiceText("brief: cut two reels, close-up shots", c).brief, "Cut two reels, close-up shots");
  assert.equal(parseVoiceText("change the brief to use the new logo", c).brief, "Use the new logo");
  assert.equal(parseVoiceText("new brief make it brighter", c).brief, "Make it brighter");
  assert.equal(parseVoiceText("add to the brief: Arabic captions too", c).briefAppend, "Arabic captions too");
  assert.equal(parseVoiceText("change the name to Launch teaser v2", c).shortName, "Launch teaser v2");
  assert.equal(parseVoiceText("call it Hero banner", c).shortName, "Hero banner");
  assert.equal(parseVoiceText("note: delivered both sizes", opts({ action: "close" })).note, "Delivered both sizes");
  assert.equal(parseVoiceText("memo shoot setup and lights", opts({ action: "log_time" })).note, "Shoot setup and lights");
  // Free text never fuzzy-matches ordinary words to people ("more" ≠ Moe, "image" ≠ Mae).
  const free = parseVoiceText("enhance quality of image and also add more high quality picture over product", { ...c, people });
  assert.equal(free.addPeople, undefined);
  assert.deepEqual(parseVoiceText("add moe", { ...c, people }).addPeople, ["u-moe"]);
});

check("brief tidy (rules)", () => {
  const tidy = tidyBriefRules(
    "Cut three 15-second vertical reels from the BTS footage, Arabic captions, logo end card. Use the hero shot first. Refs https://drive.google.com/x",
    base.units
  );
  assert.equal(tidy.objective, "Cut three 15-second vertical reels from the BTS footage, Arabic captions, logo end card");
  assert.ok(tidy.bullets.includes("Deliverables: 3 reels"), JSON.stringify(tidy.bullets));
  assert.ok(tidy.bullets.some((b) => b.startsWith("Size / duration: 15 second") && b.includes("vertical")), JSON.stringify(tidy.bullets));
  assert.ok(tidy.bullets.includes("Language: Arabic captions"), JSON.stringify(tidy.bullets));
  assert.ok(tidy.bullets.includes("References: https://drive.google.com/x"), JSON.stringify(tidy.bullets));
  assert.ok(tidy.bullets.includes("Use the hero shot first"));
  const one = tidyBriefRules("Two statics for the launch, 1080x1350, English and Arabic copy", base.units);
  assert.equal(one.objective, "Two statics for the launch");
  assert.ok(one.bullets.includes("Deliverables: 2 statics"), JSON.stringify(one.bullets));
  assert.ok(one.bullets.some((b) => b.includes("1080x1350")), JSON.stringify(one.bullets));
  assert.ok(one.bullets.includes("Language: English and arabic copy") || one.bullets.some((b) => /english and arabic/i.test(b)), JSON.stringify(one.bullets));
  assert.equal(
    briefHtml({ objective: "Cut <3> reels", bullets: ["A & B"] }),
    "<p>Cut &lt;3&gt; reels</p><ul><li>A &amp; B</li></ul>"
  );
  assert.equal(briefHtml("Line one\nLine two"), "<p>Line one</p><p>Line two</p>");
  assert.equal(tidyBriefRules("Make a teaser", base.units).bullets.length, 0);
  assert.equal(briefHtml("Intro\n• a\n• b"), "<p>Intro</p><ul><li>a</li><li>b</li></ul>");
  // A clause that is only a pulled-out value isn't repeated.
  const dup = tidyBriefRules("Cut two videos from the footage, Arabic captions, logo end card", base.units);
  assert.deepEqual(dup.bullets, ["Deliverables: 2 videos", "Language: Arabic captions", "Logo end card"]);
});

check("rework", () => {
  const out = parseVoiceText("Rework of MO-6, client feedback, colour fix on the hero shot", base);
  assert.equal(out.intent, "rework");
  assert.equal(out.iteration, "rework");
  assert.equal(out.reworkOf, "MO-6");
  assert.equal(out.reworkSource, "external");
  assert.equal(parseVoiceText("Internal review", opts({ asking: "reworkSource", action: "create" })).reworkSource, "internal");
});

check("close", () => {
  const out = parseVoiceText("Close ENOC-13, the visual audit is done, two hours today.", base);
  assert.equal(out.intent, "close");
  assert.equal(out.taskCode, "ENOC-13");
  assert.equal(out.minutes, 120);
  assert.equal(out.note, "Visual audit is done");
  const ctx = parseVoiceText("close this, 2 hours, done", base);
  assert.equal(ctx.intent, "close");
  assert.equal(ctx.taskCode, undefined);
  assert.equal(ctx.minutes, 120);
  assert.equal(ctx.note, "Done");
  const link = parseVoiceText("https://drive.google.com/file/abc", opts({ asking: "final", action: "close" }));
  assert.equal(link.finalUrl, "https://drive.google.com/file/abc");
  assert.equal(link.note, undefined);
  const spoken = parseVoiceText("drive.google.com/x/y", opts({ asking: "final", action: "close" }));
  assert.equal(spoken.finalUrl, "https://drive.google.com/x/y");
  const range = parseVoiceText("from 10 to 12", opts({ asking: "time", action: "close" }));
  assert.equal(range.start, "2026-10-23T10:00");
  assert.equal(range.end, "2026-10-23T12:00");
  const note = parseVoiceText("Delivered the final cut, it's done", opts({ asking: "note", action: "close" }));
  assert.equal(note.note, "Delivered the final cut, it's done");
  assert.equal(note.intent, undefined);
});

check("log time", () => {
  const out = parseVoiceText("Log 45 minutes on ENOC-14 for the shoot setup.", base);
  assert.equal(out.intent, "log_time");
  assert.equal(out.taskCode, "ENOC-14");
  assert.equal(out.minutes, 45);
  assert.equal(out.note, "Shoot setup");
  const spaced = parseVoiceText("log 1h 30m on enoc 14", base);
  assert.equal(spaced.taskCode, "ENOC-14");
  assert.equal(spaced.minutes, 90);
  assert.equal(parseVoiceText("log 2 hours on EO26-7", base).taskCode, "EO26-7");
});

check("out of scope and cancel", () => {
  assert.equal(parseVoiceText("What's due today?", base).intent, "out_of_scope");
  assert.equal(parseVoiceText("Move my 4 hours from EO26-7 to EO26-8", base).intent, "out_of_scope");
  assert.equal(parseVoiceText("cancel", opts({ asking: "brief", action: "create" })).intent, "cancel");
});

console.log(`\n${passed} checks passed`);
