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
      <body className="operator-surface min-h-full flex flex-col">{children}</body>
    </html>
  );
}
