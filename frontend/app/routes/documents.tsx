import { DocumentsPage } from "@/components/documents/documents-page";

import type { Route } from "./+types/documents";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Documents | LPS" }];
}

export default function Documents() {
  return <DocumentsPage />;
}
