import { RedirectTo } from "@/components/layout/redirect-to";

/** Moved: leave management is the "Team requests" tab of /leaves. Kept for old links. */
export default function ManageLeavesRedirect() {
  return <RedirectTo to="/leaves" search={{ tab: "team" }} />;
}
