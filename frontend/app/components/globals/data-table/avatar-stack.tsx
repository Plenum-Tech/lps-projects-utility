import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { initials } from "@/lib/tasks";
import { cn } from "@/lib/utils";

interface StackUser {
  _id: string;
  name: string;
}

/**
 * Overlapping avatars (up to `max`, then "+N") with a tooltip listing every
 * name. Renders `empty` (default "--") when there's nobody.
 */
export function AvatarStack({
  users,
  max = 4,
  label = "People",
  empty = "--",
  className,
}: {
  users: StackUser[];
  max?: number;
  /** Prefix for the accessible name, e.g. "Assigned to". */
  label?: string;
  empty?: string;
  className?: string;
}) {
  if (users.length === 0) {
    return <span className="text-xs text-muted-foreground">{empty}</span>;
  }
  const visible = users.slice(0, max);
  const rest = users.length - visible.length;
  const names = users.map((user) => user.name);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <AvatarGroup
            tabIndex={0}
            aria-label={`${label}: ${names.join(", ")}`}
            className={cn("rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}
          />
        }
      >
        {visible.map((user) => (
          <Avatar key={user._id} size="sm">
            <AvatarFallback className="bg-primary/10 font-medium text-primary">
              {initials(user.name)}
            </AvatarFallback>
          </Avatar>
        ))}
        {rest > 0 && <AvatarGroupCount className="size-6 text-xs">+{rest}</AvatarGroupCount>}
      </TooltipTrigger>
      <TooltipContent>
        <ul className="space-y-0.5">
          {names.map((name, index) => (
            <li key={`${name}-${index}`}>{name}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
