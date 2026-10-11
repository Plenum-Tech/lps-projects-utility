import { AppShell } from "@/components/layout/app-shell";
import { RequireAuth } from "@/components/auth/require-auth";
import { MandatoryTrainingPrompt } from "@/components/training/mandatory-training-prompt";
import { BrandMappingPrompt } from "@/components/projects/brand-mapping-prompt";

/**
 * Pathless layout wrapping every protected route. The auth guard runs before
 * any child renders; signed-out users are redirected to the login page.
 */
export default function ProtectedLayout() {
  return (
    <RequireAuth>
      <AppShell />
      <MandatoryTrainingPrompt />
      <BrandMappingPrompt />
    </RequireAuth>
  );
}
