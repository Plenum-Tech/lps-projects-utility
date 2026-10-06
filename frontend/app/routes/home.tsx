import type { Route } from "./+types/home";
import { LoginPage } from "../components/auth/login-page";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Sign in | LPS" },
    {
      name: "description",
      content: "Sign in to LPS – Projects Utility by Plenum Tech.",
    },
  ];
}

export default function Home() {
  return <LoginPage />;
}
