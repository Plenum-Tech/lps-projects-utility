// ---------------------------------------------------------------------------
// Natural, case-insensitive sort keys for aggregation pipelines (no ICU options).
// Azure Cosmos DB for MongoDB vCore rejects ICU sort options, so instead of
// { locale: "en", numericOrdering: true, strength: 2 } list sorts add a computed
// key: the value lowercased with every digit run left-padded with zeros, so a
// plain binary $sort orders "PEAR-2" < "PEAR-12" and "alpha" == "Alpha".
// Uses only basic operators ($reduce/$range/$substrCP/$strLenCP) that both
// MongoDB and Cosmos vCore support.
// ---------------------------------------------------------------------------

const DIGIT_WIDTH = 12;
const ZEROS = "0".repeat(DIGIT_WIDTH);

/** Left-pads a (possibly empty) digit-run expression to DIGIT_WIDTH. */
function padRun(run: string): Record<string, unknown> {
  return {
    $cond: [
      { $eq: [run, ""] },
      "",
      {
        $concat: [{ $substrCP: [ZEROS, 0, { $max: [0, { $subtract: [DIGIT_WIDTH, { $strLenCP: run }] }] }] }, run],
      },
    ],
  };
}

/**
 * Aggregation expression for the natural sort key of `expr` (e.g. "$title").
 * Missing/null sort as "" (first ascending — same as MongoDB's null ordering).
 */
export function naturalSortKey(expr: unknown): Record<string, unknown> {
  return {
    $let: {
      vars: { s: { $toLower: { $ifNull: [expr, ""] } } },
      in: {
        $let: {
          vars: {
            acc: {
              $reduce: {
                input: { $range: [0, { $strLenCP: "$$s" }] },
                initialValue: { out: "", run: "" },
                in: {
                  $let: {
                    vars: { c: { $substrCP: ["$$s", "$$this", 1] } },
                    in: {
                      $cond: [
                        { $and: [{ $gte: ["$$c", "0"] }, { $lte: ["$$c", "9"] }] },
                        { out: "$$value.out", run: { $concat: ["$$value.run", "$$c"] } },
                        { out: { $concat: ["$$value.out", padRun("$$value.run"), "$$c"] }, run: "" },
                      ],
                    },
                  },
                },
              },
            },
          },
          in: { $concat: ["$$acc.out", padRun("$$acc.run")] },
        },
      },
    },
  };
}
