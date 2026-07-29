import type { Metadata, Viewport } from "next";
import { Familjen_Grotesk } from "next/font/google";
import { Toaster } from "sonner";
import { ServiceWorkerRegistrar } from "@/components/service-worker";
import "./globals.css";

/**
 * Familjen Grotesk is self-hosted by next/font — no runtime request to Google,
 * which matters twice here: the app has to boot in a shop basement, and it sits
 * behind Authelia where a third-party font request is one more thing to explain
 * to a proxy. The woff2 lands under /_next/static, which the service worker
 * caches opportunistically on first load; until it does, the system stack in
 * `--font-sans` renders instead, so a cold offline start is never text-less.
 */
const familjen = Familjen_Grotesk({
  subsets: ["latin", "latin-ext"],
  weight: "variable",
  display: "swap",
  variable: "--font-familjen",
});

export const metadata: Metadata = {
  title: "Recipus",
  description: "Handlingslistan för hushållet",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Recipus",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f2" },
    { media: "(prefers-color-scheme: dark)", color: "#131512" },
  ],
  width: "device-width",
  initialScale: 1,
  // The tile grid is sized for thumbs; letting it zoom turns a mis-tap into a
  // zoomed-in list you have to fix one-handed while holding a basket.
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sv" className={familjen.variable}>
      <body>
        <ServiceWorkerRegistrar />
        {children}
        <Toaster
          position="bottom-center"
          // Undo is the whole point of these toasts, and the app is used
          // one-handed while walking. Give it time to be tapped.
          duration={5000}
          // The toast is the only surface that inverts against the page, which
          // is what makes it read as a passing message rather than new UI.
          toastOptions={{
            style: {
              background: "var(--color-ink)",
              color: "var(--color-surface)",
              border: "none",
              borderRadius: "var(--radius-card)",
              fontFamily: "var(--font-sans)",
              fontSize: "0.875rem",
            },
          }}
        />
      </body>
    </html>
  );
}
