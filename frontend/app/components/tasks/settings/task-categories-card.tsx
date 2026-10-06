import { useState, type FormEvent } from "react";
import {
  LuCheck,
  LuCircleAlert,
  LuFolder,
  LuLoaderCircle,
  LuPencil,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
  LuX,
} from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useCreateTaskCategory,
  useDeleteTaskCategory,
  useTaskCategories,
  useUpdateTaskCategory,
} from "@/hooks/use-task-meta";
import { getErrorMessage } from "@/lib/api";
import type { TaskCategory } from "@/types";

/** Admin CRUD for task categories. */
export function TaskCategoriesCard() {
  const categories = useTaskCategories();
  const create = useCreateTaskCategory();
  const [name, setName] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value || value.length > 60) return;
    create.mutate(value, { onSuccess: () => setName("") });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuFolder aria-hidden className="size-4 text-muted-foreground" />
          Categories
        </CardTitle>
        <CardDescription>One category per task, e.g. Operations, Hiring, Finance.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            placeholder="New category name"
            aria-label="New category name"
            disabled={create.isPending}
          />
          <Button type="submit" disabled={create.isPending || name.trim() === ""}>
            {create.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuPlus aria-hidden />
            )}
            Add
          </Button>
        </form>

        {categories.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading categories">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : categories.isError ? (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t load categories</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(categories.error)}
              <Button variant="outline" size="sm" onClick={() => void categories.refetch()}>
                <LuRefreshCw aria-hidden />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : categories.data.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center">
            <LuFolder aria-hidden className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No categories yet</p>
            <p className="text-xs text-muted-foreground">Add one above to group related tasks.</p>
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {categories.data.map((category) => (
              <CategoryRow key={category._id} category={category} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CategoryRow({ category }: { category: TaskCategory }) {
  const update = useUpdateTaskCategory();
  const remove = useDeleteTaskCategory();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [confirming, setConfirming] = useState(false);

  function save(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value || value.length > 60) return;
    if (value === category.name) {
      setEditing(false);
      return;
    }
    update.mutate({ id: category._id, name: value }, { onSuccess: () => setEditing(false) });
  }

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      {editing ? (
        <form onSubmit={save} className="flex flex-1 items-center gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            aria-label={`Rename ${category.name}`}
            autoFocus
            disabled={update.isPending}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setName(category.name);
                setEditing(false);
              }
            }}
          />
          <Button type="submit" size="icon-sm" disabled={update.isPending} aria-label="Save">
            {update.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuCheck aria-hidden />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setName(category.name);
              setEditing(false);
            }}
            aria-label="Cancel"
          >
            <LuX aria-hidden />
          </Button>
        </form>
      ) : (
        <>
          <span className="flex-1 truncate text-sm text-foreground">{category.name}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setEditing(true)}
            aria-label={`Rename ${category.name}`}
          >
            <LuPencil aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${category.name}`}
          >
            <LuTrash2 aria-hidden />
          </Button>
        </>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{category.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Tasks in this category keep everything else; their category is cleared.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(category._id, { onSuccess: () => setConfirming(false) })
              }
            >
              {remove.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
