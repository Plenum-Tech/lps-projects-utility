import { useParams, useSearchParams } from "react-router";

import { BrandPage } from "@/components/brands/brand-page";
import { thisMonth } from "@/components/brands/brands-dashboard";

import type { Route } from "./+types/brands.$id";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Brand | LPS" }];
}

/** /brands/:id — one brand's scope, documents, team, utilisation and projects. */
export default function BrandRoute() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(searchParams.get("month") ?? "") ? searchParams.get("month")! : thisMonth();
  return (
    <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
      <BrandPage
        id={id}
        month={month}
        onMonth={(m) =>
          setSearchParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              next.set("month", m);
              return next;
            },
            { replace: true },
          )
        }
      />
    </div>
  );
}
