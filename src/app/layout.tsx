import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";

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
    { media: "(prefers-color-scheme: light)", color: "#f6f5f1" },
    { media: "(prefers-color-scheme: dark)", color: "#14161a" },
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
    <html lang="sv">
      <body>
        {children}
        <Toaster
          position="bottom-center"
          // Undo is the whole point of these toasts, and the app is used
          // one-handed while walking. Give it time to be tapped.
          duration={5000}
          toastOptions={{
            style: {
              background: "var(--color-ink)",
              color: "var(--color-paper)",
              border: "none",
            },
          }}
        />
      </body>
    </html>
  );
}
