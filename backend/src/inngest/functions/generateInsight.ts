import { inngest } from "../client.js";

// ---------------------------------------------------------------------------
// Gemini API helper
// ---------------------------------------------------------------------------

interface GeminiInsightResult {
  title: string;
  summary: string;
  content: string;
}

/**
 * Calls the Gemini API to generate organizational insights.
 * Returns parsed JSON or throws on failure.
 */
async function callGemini(prompt: string): Promise<GeminiInsightResult> {
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
        maxOutputTokens: 4096,
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

  if (
    typeof parsed.title !== "string" ||
    typeof parsed.summary !== "string" ||
    typeof parsed.content !== "string"
  ) {
    throw new Error("Gemini response missing required fields (title, summary, content)");
  }

  return {
    title: parsed.title,
    summary: parsed.summary,
    content: parsed.content,
  };
}

// ---------------------------------------------------------------------------
// Build the prompt for Gemini
// ---------------------------------------------------------------------------

function buildInsightPrompt(data: {
  scope: string;
  departmentName: string;
  period: string;
  attendance: {
    totalEmployees: number;
    avgRate: number;
    present: number;
    absent: number;
    late: number;
    halfDay: number;
    onLeave: number;
    lowestRate: { name: string; rate: number } | null;
    highestRate: { name: string; rate: number } | null;
  };
  leaves: {
    total: number;
    approved: number;
    rejected: number;
    pending: number;
    byType: Array<{ type: string; count: number }>;
    highestUsage: { name: string; days: number } | null;
  };
  tasks: {
    total: number;
    completed: number;
    inProgress: number;
    inReview: number;
    overdue: number;
    todo: number;
    rejected: number;
    completionRate: number;
  };
  reviews: {
    total: number;
    avgScore: number;
    distribution: Record<number, number>;
  };
  feedback: {
    total: number;
    suggestions: number;
    complaints: number;
    praises: number;
    resolved: number;
    open: number;
  };
}): string {
  const scopeLabel =
    data.scope === "organization"
      ? "Organization-wide"
      : `Department: ${data.departmentName}`;

  const distributionText = Object.entries(data.reviews.distribution)
    .map(([score, count]) => `${score}★ (${count})`)
    .join(" | ");

  const leavesByType = data.leaves.byType
    .map((t) => `${t.type}: ${t.count}`)
    .join(", ");

  return `You are an expert HR analytics consultant. Analyze the following ${scopeLabel.toLowerCase()} data and provide actionable insights.

## Period
${data.period}

## Attendance Data
- Total employees: ${data.attendance.totalEmployees}
- Average attendance rate: ${data.attendance.avgRate}%
- Present: ${data.attendance.present} days | Absent: ${data.attendance.absent} days | Late: ${data.attendance.late} days | Half-day: ${data.attendance.halfDay} | On leave: ${data.attendance.onLeave}
${data.attendance.lowestRate ? `- Lowest attendance: ${data.attendance.lowestRate.name} at ${data.attendance.lowestRate.rate}%` : ""}
${data.attendance.highestRate ? `- Highest attendance: ${data.attendance.highestRate.name} at ${data.attendance.highestRate.rate}%` : ""}

## Leave Data
- Total requests: ${data.leaves.total} (Approved: ${data.leaves.approved}, Rejected: ${data.leaves.rejected}, Pending: ${data.leaves.pending})
- By type: ${leavesByType || "No data"}
${data.leaves.highestUsage ? `- Highest leave usage: ${data.leaves.highestUsage.name} with ${data.leaves.highestUsage.days} days` : ""}

## Task Data
- Total tasks: ${data.tasks.total}
- Completed: ${data.tasks.completed} | In Progress: ${data.tasks.inProgress} | In Review: ${data.tasks.inReview} | To Do: ${data.tasks.todo} | Rejected: ${data.tasks.rejected}
- Overdue: ${data.tasks.overdue}
- Completion rate: ${data.tasks.completionRate}%

## Performance Reviews
- Total reviews: ${data.reviews.total}
- Average score: ${data.reviews.avgScore}/5
- Score distribution: ${distributionText || "No data"}

## Feedback
- Total submissions: ${data.feedback.total}
- Suggestions: ${data.feedback.suggestions} | Complaints: ${data.feedback.complaints} | Praises: ${data.feedback.praises}
- Resolution rate: ${data.feedback.total > 0 ? Math.round((data.feedback.resolved / data.feedback.total) * 100) : 0}% (${data.feedback.resolved} resolved, ${data.feedback.open} open)

## Instructions
Provide a comprehensive analysis with the following sections:
1. **Executive Summary** — 2-3 sentence overview of organizational/departmental health
2. **Key Findings** — 3-5 bullet points highlighting the most significant patterns
3. **Employee Development Recommendations** — specific actions for improving employee growth
4. **Team Dynamics Insights** — observations about collaboration, workload, and engagement
5. **Attendance & Productivity Analysis** — patterns in attendance and task completion
6. **Action Items** — 3-5 prioritized, actionable recommendations

Be data-driven, specific, and constructive. Reference actual numbers from the data.
Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "title": "<short descriptive title, e.g. 'Q1 2026 Organizational Health Report'>",
  "summary": "<one-line summary of key takeaway>",
  "content": "<full formatted markdown content with all 6 sections using ## headers>"
}`;
}

// ---------------------------------------------------------------------------
// Inngest function: generate-insight
// ---------------------------------------------------------------------------

export const generateInsightFunction = inngest.createFunction(
  {
    id: "generate-insight",
    triggers: [{ event: "ai/insight-generate" }],
    retries: 3,
  },
  async ({ event, step }) => {
    const { insightId } = event.data;

    // Step 1: Fetch the insight document and determine scope.
    const insightData = await step.run("fetch-insight", async () => {
      const { AiInsight } = await import("../../models/AiInsight.js");

      const insight = await AiInsight.findById(insightId).populate(
        "department",
        "name"
      );

      if (!insight) {
        throw new Error(`Insight ${insightId} not found`);
      }

      const dept = insight.department as unknown as
        | { name: string }
        | null;

      return {
        scope: insight.scope,
        departmentId: insight.department?.toString() ?? null,
        departmentName: dept?.name ?? "Organization",
        period: insight.period,
      };
    });

    // Step 2: Collect attendance data.
    const attendance = await step.run("collect-attendance", async () => {
      const { Attendance } = await import("../../models/Attendance.js");
      const { STAFF_FILTER, User } = await import("../../models/User.js");

      // Last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const deptId = insightData.departmentId ?? null;
      const userFilter: Record<string, unknown> = { role: { $ne: "admin" }, ...STAFF_FILTER };
      if (insightData.scope === "department" && deptId) {
        userFilter.department = deptId;
      }

      const employees = await User.find(userFilter)
        .select("name department")
        .lean();

      if (employees.length === 0) {
        return {
          totalEmployees: 0,
          avgRate: 0,
          present: 0,
          absent: 0,
          late: 0,
          halfDay: 0,
          onLeave: 0,
          lowestRate: null,
          highestRate: null,
        };
      }

      const employeeIds = employees.map(
        (e) => e._id
      );

      const records = await Attendance.find({
        user: { $in: employeeIds },
        date: { $gte: thirtyDaysAgo },
      })
        .select("user status")
        .lean();

      // Count statuses.
      const statusCounts = {
        present: 0,
        absent: 0,
        late: 0,
        half_day: 0,
        on_leave: 0,
      };
      for (const r of records) {
        statusCounts[r.status as keyof typeof statusCounts]++;
      }

      // Per-employee rates.
      const empMap = new Map<
        string,
        { present: number; late: number; half_day: number }
      >();
      for (const emp of employees) {
        empMap.set(emp._id.toString(), { present: 0, late: 0, half_day: 0 });
      }
      for (const r of records) {
        const entry = empMap.get(r.user.toString());
        if (entry && (r.status === "present" || r.status === "late" || r.status === "half_day")) {
          entry[r.status]++;
        }
      }

      const empRates = employees.map((emp) => {
        const entry = empMap.get(emp._id.toString())!;
        return {
          name: emp.name,
          rate: Math.round(((entry.present + entry.late + entry.half_day) / 30) * 100),
        };
      });

      empRates.sort((a, b) => a.rate - b.rate);

      const avgRate =
        empRates.length > 0
          ? Math.round(
              empRates.reduce((s, e) => s + e.rate, 0) / empRates.length
            )
          : 0;

      return {
        totalEmployees: employees.length,
        avgRate,
        present: statusCounts.present,
        absent: statusCounts.absent,
        late: statusCounts.late,
        halfDay: statusCounts.half_day,
        onLeave: statusCounts.on_leave,
        lowestRate: empRates.length > 0 ? empRates[0] : null,
        highestRate:
          empRates.length > 0 ? empRates[empRates.length - 1] : null,
      };
    });

    // Step 3: Collect leave data.
    const leaves = await step.run("collect-leaves", async () => {
      const { Leave } = await import("../../models/Leave.js");
      const { STAFF_FILTER, User } = await import("../../models/User.js");

      const deptId = insightData.departmentId ?? null;
      const userFilter: Record<string, unknown> = { role: { $ne: "admin" }, ...STAFF_FILTER };
      if (insightData.scope === "department" && deptId) {
        userFilter.department = deptId;
      }

      const employees = await User.find(userFilter).select("_id name").lean();
      const employeeIds = employees.map((e) => e._id);

      if (employeeIds.length === 0) {
        return {
          total: 0,
          approved: 0,
          rejected: 0,
          pending: 0,
          byType: [],
          highestUsage: null,
        };
      }

      const records = await Leave.find({
        user: { $in: employeeIds },
      })
        .select("user leaveType status days")
        .lean();

      let approved = 0;
      let rejected = 0;
      let pending = 0;
      const typeMap = new Map<string, number>();
      const userDays = new Map<string, { name: string; days: number }>();

      for (const emp of employees) {
        userDays.set(emp._id.toString(), { name: emp.name, days: 0 });
      }

      for (const r of records) {
        if (r.status === "approved") approved++;
        else if (r.status === "rejected") rejected++;
        else if (r.status === "pending") pending++;

        typeMap.set(r.leaveType, (typeMap.get(r.leaveType) ?? 0) + 1);

        const entry = userDays.get(r.user.toString());
        if (entry && r.status === "approved") {
          entry.days += r.days;
        }
      }

      const byType = Array.from(typeMap.entries()).map(([type, count]) => ({
        type,
        count,
      }));

      const sortedUsers = Array.from(userDays.values()).sort(
        (a, b) => b.days - a.days
      );

      return {
        total: records.length,
        approved,
        rejected,
        pending,
        byType,
        highestUsage:
          sortedUsers.length > 0 && sortedUsers[0] && sortedUsers[0].days > 0
            ? sortedUsers[0]
            : null,
      };
    });

    // Step 4: Collect task data.
    const tasks = await step.run("collect-tasks", async () => {
      const { Task } = await import("../../models/Task.js");
      const { STAFF_FILTER, User } = await import("../../models/User.js");

      const deptId = insightData.departmentId ?? null;
      const userFilter: Record<string, unknown> = { role: { $ne: "admin" }, ...STAFF_FILTER };
      if (insightData.scope === "department" && deptId) {
        userFilter.department = deptId;
      }

      const employees = await User.find(userFilter).select("_id").lean();
      const employeeIds = employees.map((e) => e._id);

      if (employeeIds.length === 0) {
        return {
          total: 0,
          completed: 0,
          inProgress: 0,
          inReview: 0,
          overdue: 0,
          todo: 0,
          rejected: 0,
          completionRate: 0,
        };
      }

      const records = await Task.find({
        $or: [
          { assignees: { $in: employeeIds } },
          { assignedBy: { $in: employeeIds } },
        ],
      })
        .select("status dueDate")
        .lean();

      const now = new Date();
      let completed = 0;
      let inProgress = 0;
      let inReview = 0;
      let overdue = 0;
      let todo = 0;
      let rejected = 0;

      for (const r of records) {
        switch (r.status) {
          case "completed":
            completed++;
            break;
          case "in_progress":
            inProgress++;
            break;
          case "in_review":
            inReview++;
            break;
          case "todo":
            todo++;
            break;
          case "rejected":
            rejected++;
            break;
        }
        if (
          r.status !== "completed" &&
          r.dueDate &&
          new Date(r.dueDate) < now
        ) {
          overdue++;
        }
      }

      const total = records.length;
      const completionRate =
        total > 0 ? Math.round((completed / total) * 100) : 0;

      return {
        total,
        completed,
        inProgress,
        inReview,
        overdue,
        todo,
        rejected,
        completionRate,
      };
    });

    // Step 5: Collect performance review data.
    const reviews = await step.run("collect-reviews", async () => {
      const { PerformanceReview } = await import(
        "../../models/PerformanceReview.js"
      );
      const { STAFF_FILTER, User } = await import("../../models/User.js");

      const deptId = insightData.departmentId ?? null;
      const userFilter: Record<string, unknown> = { role: { $ne: "admin" }, ...STAFF_FILTER };
      if (insightData.scope === "department" && deptId) {
        userFilter.department = deptId;
      }

      const employees = await User.find(userFilter).select("_id").lean();
      const employeeIds = employees.map((e) => e._id);

      if (employeeIds.length === 0) {
        return { total: 0, avgScore: 0, distribution: {} };
      }

      const records = await PerformanceReview.find({
        employee: { $in: employeeIds },
        overallScore: { $exists: true, $ne: null },
      })
        .select("overallScore")
        .lean();

      if (records.length === 0) {
        return { total: 0, avgScore: 0, distribution: {} };
      }

      const distribution: Record<number, number> = {
        1: 0,
        2: 0,
        3: 0,
        4: 0,
        5: 0,
      };
      let totalScore = 0;

      for (const r of records) {
        const score = Math.round(r.overallScore!);
        distribution[score] = (distribution[score] ?? 0) + 1;
        totalScore += r.overallScore!;
      }

      return {
        total: records.length,
        avgScore: Math.round((totalScore / records.length) * 10) / 10,
        distribution,
      };
    });

    // Step 6: Collect feedback data.
    const feedback = await step.run("collect-feedback", async () => {
      const { Feedback } = await import("../../models/Feedback.js");
      const { STAFF_FILTER, User } = await import("../../models/User.js");

      const deptId = insightData.departmentId ?? null;
      const userFilter: Record<string, unknown> = { role: { $ne: "admin" }, ...STAFF_FILTER };
      if (insightData.scope === "department" && deptId) {
        userFilter.department = deptId;
      }

      const employees = await User.find(userFilter).select("_id").lean();
      const employeeIds = employees.map((e) => e._id);

      if (employeeIds.length === 0) {
        return {
          total: 0,
          suggestions: 0,
          complaints: 0,
          praises: 0,
          resolved: 0,
          open: 0,
        };
      }

      const records = await Feedback.find({
        author: { $in: employeeIds },
      })
        .select("category status")
        .lean();

      let suggestions = 0;
      let complaints = 0;
      let praises = 0;
      let resolved = 0;
      let open = 0;

      for (const r of records) {
        if (r.category === "suggestion") suggestions++;
        else if (r.category === "complaint") complaints++;
        else if (r.category === "praise") praises++;

        if (r.status === "resolved") resolved++;
        else if (r.status === "open") open++;
      }

      return {
        total: records.length,
        suggestions,
        complaints,
        praises,
        resolved,
        open,
      };
    });

    // Step 7: Call Gemini AI to generate insights.
    const aiResult = await step.run("generate-ai-insights", async () => {
      const prompt = buildInsightPrompt({
        scope: insightData.scope,
        departmentName: insightData.departmentName,
        period: insightData.period,
        attendance: {
          totalEmployees: attendance.totalEmployees,
          avgRate: attendance.avgRate,
          present: attendance.present,
          absent: attendance.absent,
          late: attendance.late,
          halfDay: attendance.halfDay,
          onLeave: attendance.onLeave,
          lowestRate: attendance.lowestRate ?? null,
          highestRate: attendance.highestRate ?? null,
        },
        leaves: {
          total: leaves.total,
          approved: leaves.approved,
          rejected: leaves.rejected,
          pending: leaves.pending,
          byType: leaves.byType,
          highestUsage: leaves.highestUsage ?? null,
        },
        tasks,
        reviews,
        feedback,
      });

      return callGemini(prompt);
    });

    // Step 8: Save results to the insight document and notify the user.
    await step.run("save-insight", async () => {
      const { AiInsight } = await import("../../models/AiInsight.js");
      const { pushToClient, createEvent } = await import("../../lib/sse.js");

      await AiInsight.findByIdAndUpdate(insightId, {
        title: aiResult.title,
        summary: aiResult.summary,
        content: aiResult.content,
        status: "completed",
      });

      // Real-time SSE push to the user who triggered the insight
      const insight = await AiInsight.findById(insightId).select("createdBy");
      if (insight) {
        pushToClient(insight.createdBy.toString(), createEvent("insight-ready", {
          insightId,
          title: aiResult.title,
          summary: aiResult.summary,
        }));
      }
    });

    return {
      insightId,
      title: aiResult.title,
      summary: aiResult.summary,
      status: "completed",
    };
  }
);
