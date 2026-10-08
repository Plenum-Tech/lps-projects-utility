import mongoose, { Schema } from "mongoose";

/** Named atomic sequences (`counters` collection), e.g. `{ _id: "task", seq: 42 }`. */
export interface ICounter {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { versionKey: false }
);

export const Counter = mongoose.model<ICounter>("Counter", counterSchema, "counters");

export const TASK_NUMBER_COUNTER = "task";
/** Employee ID sequence ("EMP-0001"), see lib/employeeIds.ts. */
export const EMPLOYEE_ID_COUNTER = "employee";
/** Pearity tag number sequence (tagNo 1, 2, 3, …), see lib/pearity.ts. */
export const PEARITY_TAG_COUNTER = "pearityTag";
