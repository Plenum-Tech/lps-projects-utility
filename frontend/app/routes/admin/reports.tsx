import { useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Building2,
  CalendarCheck,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  Users,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useDepartmentActivitiesReport,
  useEmployeePerformanceReport,
  useLeaveStatisticsReport,
} from "@/hooks/use-reports";
import { useDepartments } from "@/hooks/use-departments";
import { getErrorMessage } from "@/lib/api";
import {
  exportDepartmentActivitiesExcel,
  exportDepartmentActivitiesPDF,
  exportEmployeePerformanceExcel,
  exportEmployeePerformancePDF,
  exportLeaveStatisticsExcel,
  exportLeaveStatisticsPDF,
} from "@/lib/report-export";
import { startOfMonthString, todayString } from "@/lib/attendance";
import type { Route } from "./+types/reports";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Reports | LPS" }];
}

export default function Reports() {
  const [from, setFrom] = useState(startOfMonthString());
  const [to, setTo] = useState(todayString());
  const [department, setDepartment] = useState<string>("all");
  const [activeTab, setActiveTab] = useState("performance");

  const { data: departmentsData } = useDepartments();
  const departments = departmentsData?.departments ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Reports
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate and export reports on employee performance, leave statistics,
          and department activities.
        </p>
      </header>

      {/* Filters */}
      <div className="mt-8 flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="report-from" className="text-xs">
            From
          </Label>
          <Input
            id="report-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-to" className="text-xs">
            To
          </Label>
          <Input
            id="report-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-dept" className="text-xs">
            Department
          </Label>
          <select
            id="report-dept"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="flex h-9 w-48 items-center rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
          >
            <option value="all">All departments</option>
            {departments.map((dept) => (
              <option key={dept._id} value={dept._id}>
                {dept.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-6">
        <TabsList>
          <TabsTrigger value="performance">
            <BarChart3 className="mr-1.5 size-4" />
            Employee Performance
          </TabsTrigger>
          <TabsTrigger value="leaves">
            <CalendarCheck className="mr-1.5 size-4" />
            Leave Statistics
          </TabsTrigger>
          <TabsTrigger value="departments">
            <Building2 className="mr-1.5 size-4" />
            Department Activities
          </TabsTrigger>
        </TabsList>

        <TabsContent value="performance">
          <PerformanceTab
            from={from}
            to={to}
            department={department === "all" ? undefined : department}
          />
        </TabsContent>
        <TabsContent value="leaves">
          <LeaveStatsTab
            from={from}
            to={to}
            department={department === "all" ? undefined : department}
          />
        </TabsContent>
        <TabsContent value="departments">
          <DepartmentActivitiesTab from={from} to={to} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// =========================================================================
// Employee Performance Tab
// =========================================================================

function PerformanceTab({
  from,
  to,
  department,
}: {
  from: string;
  to: string;
  department?: string;
}) {
  const {
    data: report,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useEmployeePerformanceReport({ from, to, department });

  const handleExportPDF = () => {
    if (report) exportEmployeePerformancePDF(report);
  };
  const handleExportExcel = () => {
    if (report) exportEmployeePerformanceExcel(report);
  };

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Attendance rates, leave usage, and performance metrics per employee.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPDF}
            disabled={!report || isPending}
          >
            <FileText />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportExcel}
            disabled={!report || isPending}
          >
            <Download />
            Export Excel
          </Button>
        </div>
      </div>

      {isPending ? (
        <PerformanceSkeleton />
      ) : isError ? (
        <ReportError error={error} onRetry={() => void refetch()} isRefetching={isRefetching} />
      ) : report && report.employees.length > 0 ? (
        <>
          <PerformanceSummaryCards report={report} />
          <PerformanceChart report={report} />
          <PerformanceTable report={report} />
        </>
      ) : (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BarChart3 />
            </EmptyMedia>
            <EmptyTitle>No performance data</EmptyTitle>
            <EmptyDescription>
              No employee data is available for the selected date range and
              department. Adjust the filters or mark attendance first.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function PerformanceSummaryCards({
  report,
}: {
  report: NonNullable<ReturnType<typeof useEmployeePerformanceReport>["data"]>;
}) {
  const avgRate =
    report.employees.reduce((sum, e) => sum + e.attendance.rate, 0) /
    report.employees.length;
  const totalLeaves = report.employees.reduce(
    (sum, e) => sum + e.leaves.total,
    0
  );

  const cards = [
    {
      label: "Total Employees",
      value: report.employees.length,
      icon: Users,
      color: "text-muted-foreground",
    },
    {
      label: "Avg Attendance",
      value: `${avgRate.toFixed(1)}%`,
      icon: BarChart3,
      color:
        avgRate >= 80
          ? "text-emerald-600"
          : avgRate >= 60
            ? "text-amber-600"
            : "text-destructive",
    },
    {
      label: "Total Leaves Taken",
      value: totalLeaves,
      icon: CalendarCheck,
      color: "text-muted-foreground",
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">
                {card.label}
              </p>
              <card.icon className={`size-4 ${card.color}`} />
            </div>
            <p className="mt-1 font-heading text-2xl font-semibold tracking-tight text-foreground">
              {card.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function PerformanceChart({
  report,
}: {
  report: NonNullable<ReturnType<typeof useEmployeePerformanceReport>["data"]>;
}) {
  const chartData = report.employees.map((emp) => ({
    name: emp.user.name.split(" ")[0],
    rate: emp.attendance.rate,
  }));

  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="font-heading text-lg font-semibold text-foreground">
          Attendance Rate Distribution
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Per-employee attendance rate across the selected period.
        </p>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="rate" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function PerformanceTable({
  report,
}: {
  report: NonNullable<ReturnType<typeof useEmployeePerformanceReport>["data"]>;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 pt-4">
          <h2 className="font-heading text-lg font-semibold text-foreground">
            Employee Details
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Detailed breakdown of attendance and leave metrics per employee.
          </p>
        </div>
        <div className="mt-3 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Department</TableHead>
                <TableHead className="text-center">Att. Rate</TableHead>
                <TableHead className="text-center">Present</TableHead>
                <TableHead className="text-center">Absent</TableHead>
                <TableHead className="text-center">Late</TableHead>
                <TableHead className="text-center">Leaves</TableHead>
                <TableHead className="text-center">Leave Approval</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.employees.map((emp) => (
                <TableRow key={emp.user._id}>
                  <TableCell>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {emp.user.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {emp.user.email}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {emp.departmentName ?? "Unassigned"}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge
                      variant={
                        emp.attendance.rate >= 80
                          ? "default"
                          : emp.attendance.rate >= 60
                            ? "secondary"
                            : "destructive"
                      }
                    >
                      {emp.attendance.rate}%
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {emp.attendance.present}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {emp.attendance.absent}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {emp.attendance.late}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {emp.leaves.total}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {emp.leaves.approvalRate}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function PerformanceSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading performance report">
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-4 h-64 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// =========================================================================
// Leave Statistics Tab
// =========================================================================

const PIE_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--chart-2, 142 76% 36%))",
  "hsl(var(--chart-3, 47 100% 50%))",
  "hsl(var(--chart-4, 0 84% 60%))",
];

function LeaveStatsTab({
  from,
  to,
  department,
}: {
  from: string;
  to: string;
  department?: string;
}) {
  const {
    data: report,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useLeaveStatisticsReport({ from, to, department });

  const handleExportPDF = () => {
    if (report) exportLeaveStatisticsPDF(report);
  };
  const handleExportExcel = () => {
    if (report) exportLeaveStatisticsExcel(report);
  };

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Leave request breakdowns by type, department, and month.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPDF}
            disabled={!report || isPending}
          >
            <FileText />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportExcel}
            disabled={!report || isPending}
          >
            <Download />
            Export Excel
          </Button>
        </div>
      </div>

      {isPending ? (
        <LeaveStatsSkeleton />
      ) : isError ? (
        <ReportError error={error} onRetry={() => void refetch()} isRefetching={isRefetching} />
      ) : report && report.summary.total > 0 ? (
        <>
          <LeaveSummaryCards report={report} />
          <div className="grid gap-6 lg:grid-cols-2">
            <LeaveTypePieChart report={report} />
            <MonthlyTrendChart report={report} />
          </div>
          <LeaveByDepartmentTable report={report} />
        </>
      ) : (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarCheck />
            </EmptyMedia>
            <EmptyTitle>No leave data</EmptyTitle>
            <EmptyDescription>
              No leave requests have been submitted for the selected date range
              and department.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function LeaveSummaryCards({
  report,
}: {
  report: NonNullable<ReturnType<typeof useLeaveStatisticsReport>["data"]>;
}) {
  const approvalRate =
    report.summary.total > 0
      ? Math.round((report.summary.approved / report.summary.total) * 100)
      : 0;

  const cards = [
    {
      label: "Total Requests",
      value: report.summary.total,
      icon: CalendarCheck,
      color: "text-muted-foreground",
    },
    {
      label: "Approval Rate",
      value: `${approvalRate}%`,
      icon: BarChart3,
      color:
        approvalRate >= 70
          ? "text-emerald-600"
          : approvalRate >= 40
            ? "text-amber-600"
            : "text-destructive",
    },
    {
      label: "Pending",
      value: report.summary.pending,
      icon: Users,
      color: "text-amber-600",
    },
    {
      label: "Approved",
      value: report.summary.approved,
      icon: BarChart3,
      color: "text-emerald-600",
    },
    {
      label: "Rejected",
      value: report.summary.rejected,
      icon: BarChart3,
      color: "text-destructive",
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">
                {card.label}
              </p>
              <card.icon className={`size-4 ${card.color}`} />
            </div>
            <p className="mt-1 font-heading text-2xl font-semibold tracking-tight text-foreground">
              {card.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function LeaveTypePieChart({
  report,
}: {
  report: NonNullable<ReturnType<typeof useLeaveStatisticsReport>["data"]>;
}) {
  const pieData = report.byType
    .filter((t) => t.count > 0)
    .map((t) => ({
      name: t.type.charAt(0).toUpperCase() + t.type.slice(1),
      value: t.count,
    }));

  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="font-heading text-lg font-semibold text-foreground">
          Leave by Type
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Distribution of leave requests across different types.
        </p>
        <div className="mt-4 h-64">
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={4}
                  dataKey="value"
                >
                  {pieData.map((_, index) => (
                    <rect
                      key={`cell-${index}`}
                      fill={PIE_COLORS[index % PIE_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No leave data
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MonthlyTrendChart({
  report,
}: {
  report: NonNullable<ReturnType<typeof useLeaveStatisticsReport>["data"]>;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="font-heading text-lg font-semibold text-foreground">
          Monthly Trend
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Leave requests over time within the selected period.
        </p>
        <div className="mt-4 h-64">
          {report.monthlyTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={report.monthlyTrend}>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar
                  dataKey="approved"
                  stackId="a"
                  fill="hsl(142 76% 36%)"
                  name="Approved"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="rejected"
                  stackId="a"
                  fill="hsl(0 84% 60%)"
                  name="Rejected"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No trend data
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LeaveByDepartmentTable({
  report,
}: {
  report: NonNullable<ReturnType<typeof useLeaveStatisticsReport>["data"]>;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 pt-4">
          <h2 className="font-heading text-lg font-semibold text-foreground">
            Leave by Department
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Leave request counts broken down by department.
          </p>
        </div>
        <div className="mt-3 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department</TableHead>
                <TableHead className="text-center">Total</TableHead>
                <TableHead className="text-center">Approved</TableHead>
                <TableHead className="text-center">Rejected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.byDepartment.map((dept) => (
                <TableRow key={dept.department}>
                  <TableCell className="text-sm font-medium">
                    {dept.department}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {dept.total}
                  </TableCell>
                  <TableCell className="text-center text-sm text-emerald-600">
                    {dept.approved}
                  </TableCell>
                  <TableCell className="text-center text-sm text-destructive">
                    {dept.rejected}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function LeaveStatsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading leave statistics">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="mt-4 h-64 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="mt-4 h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// =========================================================================
// Department Activities Tab
// =========================================================================

function DepartmentActivitiesTab({
  from,
  to,
}: {
  from: string;
  to: string;
}) {
  const {
    data: report,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useDepartmentActivitiesReport({ from, to });

  const handleExportPDF = () => {
    if (report) exportDepartmentActivitiesPDF(report);
  };
  const handleExportExcel = () => {
    if (report) exportDepartmentActivitiesExcel(report);
  };

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Activity summary across all departments including attendance, leave
          usage, and activity counts.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPDF}
            disabled={!report || isPending}
          >
            <FileText />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportExcel}
            disabled={!report || isPending}
          >
            <Download />
            Export Excel
          </Button>
        </div>
      </div>

      {isPending ? (
        <DepartmentSkeleton />
      ) : isError ? (
        <ReportError error={error} onRetry={() => void refetch()} isRefetching={isRefetching} />
      ) : report && report.departments.length > 0 ? (
        <>
          <DepartmentChart report={report} />
          <DepartmentTable report={report} />
        </>
      ) : (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Building2 />
            </EmptyMedia>
            <EmptyTitle>No departments</EmptyTitle>
            <EmptyDescription>
              No departments have been created yet. Create departments to see
              activity reports here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function DepartmentChart({
  report,
}: {
  report: NonNullable<ReturnType<typeof useDepartmentActivitiesReport>["data"]>;
}) {
  const chartData = report.departments.map((dept) => ({
    name: dept.name.length > 12 ? dept.name.slice(0, 12) + "…" : dept.name,
    attendance: dept.avgAttendanceRate,
    activities: dept.recentActivities,
  }));

  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="font-heading text-lg font-semibold text-foreground">
          Department Comparison
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Attendance rates and activity counts across departments.
        </p>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" domain={[0, 100]} tick={{ fontSize: 12 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar
                yAxisId="left"
                dataKey="attendance"
                fill="hsl(var(--primary))"
                name="Attendance %"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                yAxisId="right"
                dataKey="activities"
                fill="hsl(var(--chart-2, 142 76% 36%))"
                name="Activities"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function DepartmentTable({
  report,
}: {
  report: NonNullable<ReturnType<typeof useDepartmentActivitiesReport>["data"]>;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 pt-4">
          <h2 className="font-heading text-lg font-semibold text-foreground">
            Department Details
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Detailed metrics for each department.
          </p>
        </div>
        <div className="mt-3 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department</TableHead>
                <TableHead className="text-center">Members</TableHead>
                <TableHead className="text-center">Avg Attendance</TableHead>
                <TableHead className="text-center">Leave Days Used</TableHead>
                <TableHead className="text-center">Activities</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.departments.map((dept) => (
                <TableRow key={dept._id}>
                  <TableCell className="text-sm font-medium">
                    {dept.name}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {dept.memberCount}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge
                      variant={
                        dept.avgAttendanceRate >= 80
                          ? "default"
                          : dept.avgAttendanceRate >= 60
                            ? "secondary"
                            : "destructive"
                      }
                    >
                      {dept.avgAttendanceRate}%
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {dept.leaveDaysUsed}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {dept.recentActivities}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function DepartmentSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading department activities">
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-4 h-64 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// =========================================================================
// Shared
// =========================================================================

function ReportError({
  error,
  onRetry,
  isRefetching,
}: {
  error: unknown;
  onRetry: () => void;
  isRefetching: boolean;
}) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" />
      <AlertTitle>Couldn&apos;t load report</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {getErrorMessage(error)}
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={isRefetching}
        >
          {isRefetching ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
