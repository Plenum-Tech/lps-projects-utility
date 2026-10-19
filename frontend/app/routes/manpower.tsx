import { Navigate, useSearchParams } from "react-router";

import type { Route } from "./+types/manpower";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Manpower plan | LPS" }];
}

/** The Manpower plan lives under Brands now; old links (emails, bookmarks) land there. */
export default function ManpowerRoute() {
  const [searchParams] = useSearchParams();
  const next = new URLSearchParams(searchParams);
  next.set("tab", "manpower");
  return <Navigate to={`/brands?${next.toString()}`} replace />;
}
