import { Navigate, useLocation } from "react-router";

/**
 * Client redirect for a moved page. Keeps the old URL working (bookmarks,
 * emails) and carries over the query string, merged with `search`.
 */
export function RedirectTo({ to, search }: { to: string; search?: Record<string, string> }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(search ?? {})) {
    if (!params.has(key)) params.set(key, value);
  }
  const query = params.toString();
  return <Navigate to={`${to}${query ? `?${query}` : ""}${location.hash}`} replace />;
}
