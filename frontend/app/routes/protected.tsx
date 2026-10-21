import { AppShell } from "@/components/layout/app-shell";
import { RequireAuth } from "@/components/auth/require-auth";
import { MandatoryTrainingPrompt } from "@/components/training/mandatory-training-prompt";
import { BrandMappingPrompt } from "@/components/projects/brand-mapping-prompt";
import { UpdateBanner } from "@/components/globals/update-banner";
import { useCurrentUser } from "@/hooks/use-auth";

/**
 * Pathless layout wrapping every protected route. The auth guard runs before
 * any child renders; signed-out users are redirected to the login page.
 */
export default function ProtectedLayout() {
  const { data: user } = useCurrentUser();
  // Outside guests have no trainings or brands to deal with.
  const staff = Boolean(user && !user.isGuest);
  return (
    <RequireAuth>
      <AppShell />
      {staff && <MandatoryTrainingPrompt />}
      {staff && <BrandMappingPrompt />}
      <UpdateBanner />
    </RequireAuth>
  );
}
