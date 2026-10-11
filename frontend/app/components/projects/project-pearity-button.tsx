import { useState } from "react";
import { LuLoaderCircle, LuSparkles } from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { PEARITY_OFF_MESSAGE } from "@/components/tasks/pearity";
import { Button } from "@/components/ui/button";
import { startProjectPearityGenerate, usePearityStatus, useProjectPearityGenerate } from "@/hooks/use-pearity";
import { useToast } from "@/hooks/use-toast";
import type { Project } from "@/types";

/**
 * "Generate on Pearity" for a project: opens the Production Engine with the
 * project tag and details. The first time asks to confirm, because the tag is
 * frozen from then on (like a task tag).
 */
export function ProjectPearityButton({ project }: { project: Pick<Project, "_id" | "tag" | "pearityGeneratedAt"> }) {
  const status = usePearityStatus();
  const generate = useProjectPearityGenerate();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  function run() {
    startProjectPearityGenerate(generate, project._id);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (status.data !== true) toast.info(PEARITY_OFF_MESSAGE);
          else if (project.pearityGeneratedAt) run();
          else setConfirming(true);
        }}
        disabled={generate.isPending}
      >
        {generate.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSparkles aria-hidden />}
        Generate on Pearity
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Send the project tag to Pearity?"
        description={
          <>
            This opens Pearity&apos;s Production Engine with the project tag{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground">{project.tag ?? "…"}</code> and
            the project&apos;s details. From then on the project tag won&apos;t change, so it always matches Pearity.
          </>
        }
        confirmLabel="Send & open"
        icon={<LuSparkles aria-hidden />}
        pending={generate.isPending}
        onConfirm={() => {
          run();
          setConfirming(false);
        }}
      />
    </>
  );
}
