import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Yule Love Lights",
  description: "Operator console for Yule Love Lights — quoting, customer portal, and dashboard.",
};

// viewportFit: 'cover' is what makes the iOS safe-area-inset env() vars resolve
// to non-zero on notch / home-indicator devices. Without it the customer
// portal's sticky Approve pill (and any safe-area padding) sat flush against
// the home indicator. Audit 2026-06 (mobile — no viewport meta / safe area).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0B140F",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Editor text-tool fonts (#46). The embedded design editor renders
            TextItems by literal family name (Konva canvas + the edit textarea),
            so these must load under their REAL names — next/font would hash them.
            Without this all four fell back to the same default (looked identical).
            Families mirror the standalone design tool's index.html. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- false positive: this is the app-router ROOT layout (the _document.js equivalent), so the font loads for every page; next/font is not an option because it hashes the literal family names the shared editor relies on. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;700&family=Oswald:wght@400;700&family=Pacifico&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="operator-surface min-h-full flex flex-col">{children}</body>
    </html>
  );
}
