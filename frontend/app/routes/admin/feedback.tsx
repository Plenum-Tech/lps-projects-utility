import { RedirectTo } from "@/components/layout/redirect-to";

/** Moved: the feedback inbox is the "All feedback" tab of /feedback. Kept for old links. */
export default function ManageFeedbackRedirect() {
  return <RedirectTo to="/feedback" search={{ tab: "all" }} />;
}
