import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";
import { createQueryClient } from "./lib/query-client";
import { PRODUCT_DESCRIPTION, PRODUCT_NAME, PRODUCT_SHORT_NAME } from "./lib/brand";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
  { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

/** Fallback for routes without their own meta. */
export const meta: Route.MetaFunction = () => [
  { title: PRODUCT_NAME },
  { name: "description", content: PRODUCT_DESCRIPTION },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="application-name" content={PRODUCT_SHORT_NAME} />
        <meta name="apple-mobile-web-app-title" content={PRODUCT_SHORT_NAME} />
        <meta name="theme-color" content="#101820" />
        <Meta />
        <Links />
      </head>
      <body>
        <TooltipProvider>
          {children}
          <Toaster />
        </TooltipProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
