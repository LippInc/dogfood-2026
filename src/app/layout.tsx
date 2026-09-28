import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { NavProgress } from "@/components/nav-progress";
import { Toaster } from "@/components/ui/sonner";
import { archivo, jetbrains, plex, sourceSerif } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Dogfood portal", template: "%s · Dogfood portal" },
  description: "A self-hostable hackathon submission and judging portal.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The mode cookie lets the server paint the chosen mode first; with no cookie the
  // page follows the operating system (color-scheme: light dark).
  const mode = (await cookies()).get("mode")?.value;
  const dataMode = mode === "light" || mode === "dark" ? mode : undefined;
  return (
    <html
      lang="en"
      data-mode={dataMode}
      className={`${plex.variable} ${sourceSerif.variable} ${jetbrains.variable} ${archivo.variable}`}
      suppressHydrationWarning
    >
      {/* The work tokens on body are the fallback for portals (dialogs, toasts) that render outside a page's .work or .public frame. */}
      <body className="work">
        {/* the loading line for a page the reader asked for (it reads the address, so it waits for it in its own boundary) */}
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
