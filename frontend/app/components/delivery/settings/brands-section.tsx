import { useEffect, useState, type FormEvent } from "react";
import { LuLoaderCircle, LuPencil, LuPlus, LuTags, LuTrash2 } from "react-icons/lu";

import { BrandDot } from "@/components/delivery/brand-dot";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import { ColorTokenPicker } from "@/components/projects/settings/color-token-picker";
import { TextField } from "@/components/settings/sections/company-section";
import { errorField, errorMessage } from "@/components/settings/use-settings-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/hooks/use-auth";
import { useBrands, useCreateBrand, useDeleteBrand, useUpdateBrand } from "@/hooks/use-brands";
import { BrandFlowDialog } from "@/components/brands/brand-flow-dialog";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Brand, BrandColor } from "@/types";

/** Settings → Brands (admin): create, rename, colour, deactivate, project counts. */
export function BrandsSection() {
  const brands = useBrands();
  const { data: user } = useCurrentUser();
  // New brands: brand creators only (Nazeer); leadership approves them.
  const brandCreator = Boolean(user?.access?.brandCreator);
  const [editing, setEditing] = useState<Brand | "new" | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  const [deleting, setDeleting] = useState<Brand | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuTags aria-hidden className="size-4 text-muted-foreground" />
          Brands
        </CardTitle>
        <CardDescription>
          The clients projects belong to. A task&apos;s brand is its project&apos;s brand. Brands in use can&apos;t be deleted —
          deactivate them instead so they can&apos;t be picked for new projects.
        </CardDescription>
        {brandCreator && (
          <CardAction>
            <Button size="sm" onClick={() => setFlowOpen(true)}>
              <LuPlus aria-hidden />
              New brand
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {brands.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading brands">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : brands.isError ? (
          <QueryError
            title="Couldn't load brands"
            error={brands.error}
            onRetry={() => void brands.refetch()}
            retrying={brands.isFetching}
          />
        ) : brands.data.length === 0 ? (
          <EmptyState icon={LuTags} title="No brands yet" description="Add your first client brand, then pick it on projects.">
            {brandCreator && (
              <Button size="sm" onClick={() => setFlowOpen(true)}>
                <LuPlus aria-hidden />
                New brand
              </Button>
            )}
          </EmptyState>
        ) : (
          <ul className="divide-y rounded-lg border">
            {brands.data.map((brand) => (
              <BrandRow key={brand._id} brand={brand} onEdit={() => setEditing(brand)} onDelete={() => setDeleting(brand)} />
            ))}
          </ul>
        )}
      </CardContent>

      <BrandDialog
        brand={editing === "new" ? null : editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      />
      <DeleteBrandDialog brand={deleting} onClose={() => setDeleting(null)} />
      <BrandFlowDialog open={flowOpen} onOpenChange={setFlowOpen} />
    </Card>
  );
}

function BrandRow({ brand, onEdit, onDelete }: { brand: Brand; onEdit: () => void; onDelete: () => void }) {
  const update = useUpdateBrand();
  return (
    <li className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5", !brand.active && "bg-muted/30")}>
      <BrandDot color={brand.color} className="size-3" />
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-sm font-medium", !brand.active && "text-muted-foreground")}>
          {brand.name}
          {brand.shortName && <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">{brand.shortName}</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {/* Open projects; archived ones listed apart (they still keep the brand from being deleted). */}
          {(() => {
            const open = brand.openProjectCount ?? brand.projectCount;
            const archived = brand.archivedProjectCount ?? 0;
            return `${open} ${open === 1 ? "project" : "projects"}${archived ? ` · ${archived} archived` : ""}`;
          })()}
          {!brand.active && " · inactive"}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <label className="mr-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={brand.active}
            disabled={update.isPending}
            onCheckedChange={(active) => update.mutate({ id: brand._id, active })}
            aria-label={`${brand.name} active`}
          />
          Active
        </label>
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${brand.name}`}>
          <LuPencil aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`Delete ${brand.name}`}>
          <LuTrash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}

function BrandDialog({
  brand,
  open,
  onOpenChange,
}: {
  brand: Brand | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateBrand();
  const update = useUpdateBrand();
  const mutation = brand ? update : create;
  // Renaming an existing brand: admins only (not the brand creators), applied at once.
  const { data: user } = useCurrentUser();
  const nameLocked = Boolean(brand) && !user?.access?.brandRename;
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [color, setColor] = useState<BrandColor>("chart-1");
  const [active, setActive] = useState(true);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(brand?.name ?? "");
    setShortName(brand?.shortName ?? "");
    setColor(brand?.color ?? "chart-1");
    setActive(brand?.active ?? true);
    setSubmitted(false);
    create.reset();
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, brand]);

  const trimmed = name.trim();
  const nameError = !trimmed ? "A name is required." : trimmed.length > 80 ? "Max 80 characters." : null;
  const shortError = shortName.trim().length > 20 ? "Max 20 characters." : null;
  const serverField = mutation.isError ? errorField(mutation.error) : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (nameError || shortError) return;
    const done = { onSuccess: () => onOpenChange(false) };
    if (brand) {
      const input: { id: string; name?: string; shortName?: string; color?: BrandColor; active?: boolean } = { id: brand._id };
      if (trimmed !== brand.name) input.name = trimmed;
      if (shortName.trim() !== brand.shortName) input.shortName = shortName.trim();
      if (color !== brand.color) input.color = color;
      if (active !== brand.active) input.active = active;
      if (Object.keys(input).length === 1) return onOpenChange(false);
      update.mutate(input, done);
    } else {
      create.mutate({ name: trimmed, shortName: shortName.trim() || undefined, color, active }, done);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>{brand ? `Edit ${brand.name}` : "New brand"}</DialogTitle>
            <DialogDescription>The colour is used for the brand&apos;s dot in tables and charts.</DialogDescription>
          </DialogHeader>
          {nameLocked ? (
            <div className="space-y-1.5">
              <Label>Name</Label>
              <p className="text-sm font-medium">{brand?.name}</p>
              <p className="text-xs text-muted-foreground">Only an admin can rename a brand.</p>
            </div>
          ) : (
            <TextField
              id="brand-name"
              label="Name"
              required
              value={name}
              onChange={setName}
              maxLength={80}
              error={(submitted && nameError) || (serverField === "name" ? errorMessage(mutation.error) : null)}
            />
          )}
          <TextField
            id="brand-short"
            label="Short name"
            value={shortName}
            onChange={setShortName}
            maxLength={20}
            placeholder="Optional, e.g. EMR"
            error={(submitted && shortError) || (serverField === "shortName" ? errorMessage(mutation.error) : null)}
          />
          <div className="space-y-1.5">
            <Label>Colour</Label>
            <ColorTokenPicker value={color} onChange={setColor} label="Brand colour" />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
            <span>
              <span className="block font-medium">Active</span>
              <span className="block text-xs text-muted-foreground">Inactive brands can&apos;t be picked for new projects.</span>
            </span>
            <Switch checked={active} onCheckedChange={setActive} />
          </label>
          {mutation.isError && serverField !== "name" && serverField !== "shortName" && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(mutation.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              {brand ? "Save" : "Add brand"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteBrandDialog({ brand, onClose }: { brand: Brand | null; onClose: () => void }) {
  const remove = useDeleteBrand();
  const update = useUpdateBrand();
  const inUse = (brand?.projectCount ?? 0) > 0;

  useEffect(() => {
    if (brand) remove.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand]);

  return (
    <AlertDialog open={Boolean(brand)} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{inUse ? `“${brand?.name}” is in use` : `Delete “${brand?.name}”?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? `${brand?.projectCount} ${brand?.projectCount === 1 ? "project uses" : "projects use"} this brand${brand?.archivedProjectCount ? ` (${brand.archivedProjectCount} archived)` : ""}, so it can't be deleted. Deactivate it instead — existing projects keep it, new ones can't pick it.`
              : "This can't be undone. It's also removed from the delivery settings (same-day list and team map)."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError && (
          <Alert variant="destructive">
            <AlertDescription>{getErrorMessage(remove.error)}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {inUse ? (
            brand?.active && (
              <Button
                disabled={update.isPending}
                onClick={() => brand && update.mutate({ id: brand._id, active: false }, { onSuccess: onClose })}
              >
                {update.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
                Deactivate
              </Button>
            )
          ) : (
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => brand && remove.mutate(brand._id, { onSuccess: onClose })}
            >
              {remove.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              Delete
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

