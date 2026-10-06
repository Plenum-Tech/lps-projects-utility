import { inngest } from "../client.js";

// ---------------------------------------------------------------------------
// Gemini API helper
// ---------------------------------------------------------------------------

interface GeminiRating {
  category: string;
  score: number;
  comment: string;
}

interface GeminiReviewResult {
  overallScore: number;
  strengths: string;
  improvements: string;
  summary: string;
}

/**
 * Calls the Gemini API to generate a structured performance review.
 * Returns parsed JSON or throws on failure.
 */
async function callGemini(prompt: string): Promise<GeminiReviewResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  // Extract JSON from the response (may be wrapped in markdown code blocks).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Gemini response did not contain valid JSON");
  }

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

  // Validate required fields.
  if (
    typeof parsed.overallScore !== "number" ||
    typeof parsed.strengths !== "string" ||
    typeof parsed.improvements !== "string" ||
    typeof parsed.summary !== "string"
  ) {
    throw new Error("Gemini response missing required fields");
  }

  const overallScore = Math.min(5, Math.max(1, parsed.overallScore));

  return {
    overallScore,
    strengths: parsed.strengths,
    improvements: parsed.improvements,
    summary: parsed.summary,
  };
}

// ---------------------------------------------------------------------------
// Build the prompt for Gemini
// ---------------------------------------------------------------------------

function buildReviewPrompt(params: {
  employeeName: string;
  department: string;
  period: string;
  ratings: GeminiRating[];
  previousReviews: string;
}): string {
  const ratingsText = params.ratings
    .map(
      (r) =>
        `- ${r.category}: ${r.score}/5${r.comment ? ` — "${r.comment}"` : ""}`,
    )
    .join("\n");

  return `You are an expert HR performance review analyst. Generate a comprehensive performance review based on the following data.

## Employee Information
- Name: ${params.employeeName}
- Department: ${params.department}
- Review Period: ${params.period}

## Category Ratings
${ratingsText}

${params.previousReviews}

## Instructions
Based on the ratings and any available history, generate a structured performance review. Be specific, constructive, and professional.

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "overallScore": <number 1-5, weighted average based on category importance>,
  "strengths": "<2-3 sentence paragraph highlighting the employee's key strengths based on their high-scoring areas>",
  "improvements": "<2-3 sentence paragraph with specific, actionable improvement suggestions based on lower-scoring areas>",
  "summary": "<3-4 sentence overall narrative that ties together performance across all categories, suitable for a formal review document>"
}

Rules:
- overallScore should be a thoughtful weighted average (not just a simple mean), considering that technical skills and leadership may carry different weight depending on the department
- Be specific to the employee's actual scores — don't give generic feedback
- Keep the tone professional and constructive
- Do NOT include any text outside the JSON object`;
}

// ---------------------------------------------------------------------------
// Inngest function: generate-review
// ---------------------------------------------------------------------------

export const generateReviewFunction = inngest.createFunction(
  {
    id: "generate-review",
    triggers: [{ event: "performance/generate-review" }],
    retries: 3,
  },
  async ({ event, step }) => {
    const { reviewId } = event.data;

    // Step 1: Fetch the review document with populated references.
    const reviewData = await step.run("fetch-review", async () => {
      const { PerformanceReview } =
        await import("../../models/PerformanceReview.js");
      const { User } = await import("../../models/User.js");

      const review = await PerformanceReview.findById(reviewId)
        .populate("employee", "name email department")
        .populate("reviewer", "name email");

      if (!review) {
        throw new Error(`Review ${reviewId} not found`);
      }

      const employee = review.employee as unknown as {
        _id: { toString(): string };
        name: string;
        email: string;
        department?: { name: string } | null;
      };

      const departmentName =
        employee.department && typeof employee.department === "object"
          ? employee.department.name
          : "Unassigned";

      return {
        employeeName: employee.name,
        department: departmentName,
        period: review.period,
        ratings: review.ratings.map((r) => ({
          category: r.category,
          score: r.score,
          comment: r.comment || "",
        })),
      };
    });

    // Step 2: Fetch previous reviews for context.
    const previousReviews = await step.run(
      "fetch-previous-reviews",
      async () => {
        const { PerformanceReview } =
          await import("../../models/PerformanceReview.js");

        const employee = await (
          await import("../../models/PerformanceReview.js")
        ).PerformanceReview.findById(reviewId).select("employee");

        if (!employee) return "";

        const past = await PerformanceReview.find({
          employee: employee.employee,
          _id: { $ne: reviewId },
          summary: { $exists: true, $ne: "" },
        })
          .sort({ createdAt: -1 })
          .limit(3)
          .select("period overallScore summary")
          .lean();

        if (past.length === 0) return "";

        const historyText = past
          .map(
            (r) =>
              `- ${r.period}: Overall ${r.overallScore ?? "N/A"}/5 — "${r.summary}"`,
          )
          .join("\n");

        return `\n## Previous Review History\n${historyText}`;
      },
    );

    // Step 3: Call Gemini AI to generate the review.
    const aiResult = await step.run("generate-ai-review", async () => {
      const prompt = buildReviewPrompt({
        employeeName: reviewData.employeeName,
        department: reviewData.department,
        period: reviewData.period,
        ratings: reviewData.ratings,
        previousReviews,
      });

      return callGemini(prompt);
    });

    // Step 4: Fill the draft with AI-written text. The review stays a draft so
    // the reviewer can check and edit it before sending it to the employee.
    const saved = await step.run("save-review", async () => {
      const { PerformanceReview } =
        await import("../../models/PerformanceReview.js");

      const review = await PerformanceReview.findById(reviewId);
      // Skip if it was deleted or already sent while the AI was working.
      if (!review || review.status !== "draft") return false;

      // Only fill what the reviewer left blank — never overwrite their words.
      if (!review.strengths) review.strengths = aiResult.strengths;
      if (!review.improvements) review.improvements = aiResult.improvements;
      if (!review.summary) review.summary = aiResult.summary;
      // Ratings drive the score when present; otherwise use the AI's estimate.
      if (review.ratings.length === 0) review.overallScore = aiResult.overallScore;
      review.aiGenerated = true;
      await review.save();
      return true;
    });

    // Step 5: Tell the reviewer the AI draft is ready to review.
    if (saved) {
      await step.run("notify-reviewer", async () => {
        const { PerformanceReview } =
          await import("../../models/PerformanceReview.js");
        const { pushToUsers, createEvent } = await import("../../lib/sse.js");

        const review = await PerformanceReview.findById(reviewId).populate(
          "employee",
          "name",
        );
        if (!review) return;
        const employee = review.employee as unknown as { name: string };

        pushToUsers(
          [review.reviewer.toString()],
          createEvent("review-ready", {
            reviewId,
            period: review.period,
            overallScore: review.overallScore,
            employeeName: employee.name,
          })
        );
      });
    }

    return {
      reviewId,
      drafted: saved,
    };
  },
);
