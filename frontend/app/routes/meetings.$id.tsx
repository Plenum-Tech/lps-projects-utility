import { MeetingDetailPage } from "@/components/meetings/meeting-detail";

import type { Route } from "./+types/meetings.$id";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meeting | Employee Management System" }];
}

/** Two-pane meeting workspace (`?seg=<idx>` jumps to a transcript line). */
export default function MeetingPage({ params }: Route.ComponentProps) {
  // Re-mount on navigation between meetings so per-meeting state resets.
  return <MeetingDetailPage key={params.id} meetingId={params.id} />;
}
