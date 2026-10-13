import { Check, Monitor, Moon, MoonStar, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEME_LABELS, THEMES, useTheme, type ThemeChoice } from "@/lib/theme";

const ICONS: Record<ThemeChoice, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
  black: MoonStar,
};

const HINTS: Record<ThemeChoice, string> = {
  system: "Follow this device's setting",
  light: "Light background",
  dark: "Dark grey background",
  black: "Pure black (OLED)",
};

/** Sidebar footer: choose the colour theme (saved on this device). */
export function ThemeMenu() {
  const [theme, setTheme] = useTheme();
  const Icon = ICONS[theme];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
            aria-label={`Theme: ${THEME_LABELS[theme]}`}
          />
        }
      >
        <Icon />
        <span className="group-data-[collapsible=icon]:hidden">Theme: {THEME_LABELS[theme]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          {THEMES.map((choice) => {
            const ItemIcon = ICONS[choice];
            return (
              <DropdownMenuItem key={choice} onClick={() => setTheme(choice)}>
                <ItemIcon aria-hidden />
                <span className="flex-1">
                  {THEME_LABELS[choice]}
                  <span className="block text-xs text-muted-foreground">{HINTS[choice]}</span>
                </span>
                {choice === theme && <Check aria-hidden className="text-primary" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
