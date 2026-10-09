import "dotenv/config";
import { writeFileSync } from "node:fs";
import { taskEmailTemplate } from "../lib/email.js";

/**
 * `bun src/scripts/previewEmail.ts <out.html>` — writes a sample task email so the
 * layout can be checked in a browser without sending anything (no DB needed).
 */
const out = process.argv[2] ?? "email-preview.html";
const html = taskEmailTemplate({
  firstName: "Balasubramanian Rajendran",
  heading: "Your task has been updated",
  intro: "Just a quick heads-up: a task assigned to you has been updated.",
  taskId: "6ac8986c947f0a273b99fdd4",
  taskTitle: "HomesRus | Oct | STB Amends",
  taskCode: "HRUHSC-21",
  projectName: "Homes R Us - Hosting & Safa Campaign",
  startDate: "Oct 5, 2026",
  dueDate: "Oct 9, 2026",
  status: "In progress",
  priority: "high",
  quote: "Please use the revised storyboard from the client.",
  quoteAuthor: "Nazeer Aboobacker",
});
writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes)`);
