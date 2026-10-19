import mongoose from "mongoose";
import { runPitchMissedReminders } from "../lib/pitches.js";

// Go-live: records every pitch date that is ALREADY missed as handled, without
// emailing anyone, so the hourly check only emails dates missed from now on.
// They still show as missed ("missed before go-live") in Pitch & Growth.
// Safe to re-run. Usage: MONGO_URI=... bun src/scripts/markPitchMissesSilent.ts

const uri = process.env.MONGO_URI;
if (!uri) throw new Error("MONGO_URI is required");
await mongoose.connect(uri);
const result = await runPitchMissedReminders(new Date(), { silent: true });
console.log(`Pitches checked: ${result.checked}; missed steps: ${result.missed}; recorded silently now: ${result.notified} (date ${result.date})`);
await mongoose.disconnect();
