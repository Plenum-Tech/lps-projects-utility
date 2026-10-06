import { useParams } from "react-router";

import { SettingsLayout } from "@/components/settings/settings-layout";

import type { Route } from "./+types/settings";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Settings | Employee Management System" }];
}

/** /settings and /settings/:section — see components/settings/*. */
export default function SettingsPage() {
  const { section } = useParams();
  return <SettingsLayout sectionId={section} />;
}
