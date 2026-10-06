import { MeetingsWorkspace } from "@/components/meetings/meetings-workspace";

import type { Route } from "./+types/meetings";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Meetings | Employee Management System" }];
}

/** Meeting transcripts → action items → tasks. Filters live in the URL. */
export default function Meetings() {
  return <MeetingsWorkspace />;
}
