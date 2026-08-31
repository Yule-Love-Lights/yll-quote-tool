import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Home-screen install metadata for the QUOTE TOOL app. Staff save this to their
// phones, and until this landed there was no manifest and no apple-touch-icon,
// so iOS fell back to a screenshot of the dark page: the "black logo" everyone
// saw. The advertising surface overrides all three of `manifest`, `icons` and
// `appleWebApp` in src/app/advertising/layout.tsx so it installs as its own app
// with its own icon; Next replaces a metadata field wholesale when a nested
// segment sets it, which is what makes that override work.
//
// The manifest is a static file in public/ rather than the app/manifest.ts file
// convention, because that convention only exists at the root and we need two.
// It is also allowlisted in operatorGate: a <link rel="manifest"> is fetched
// WITHOUT credentials, so a gated manifest would 401 even for a signed-in
// operator and the install would silently fall back to the black square again.
export const metadata: Metadata = {
  title: "Yule Love Lights",
  description: "Operator console for Yule Love Lights — quoting, customer portal, and dashboard.",
  applicationName: "YLL Quote Tool",
  manifest: "/manifest-quote.webmanifest",
  appleWebApp: {
    capable: true,
    // What iOS prints under the icon on the home screen.
    title: "YLL Quote",
    // Opaque black bar, which matches the app's own near-black chrome. Not
    // 'black-translucent': that pulls content up under the status bar and would
    // change every page's layout, which is not what this change is for.
    statusBarStyle: "black",
  },
  icons: {
    // Listed explicitly because setting `icons` at all replaces what Next infers
    // from the app/favicon.ico file convention, so the favicon has to be named
    // here or it disappears.
    icon: "/favicon.ico",
    apple: [{ url: "/icons/yll-quote-apple-touch.png", sizes: "180x180", type: "image/png" }],
  },
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
        {/* Next renders appleWebApp.capable as the modern `mobile-web-app-capable`
            only. This is the legacy Apple spelling, written by hand, and it is
            what makes an installed app open WITHOUT the Safari address bar on
            iOS versions that predate the alias. Harmless where both are read.
            Verified against the served HTML, not assumed: without this line the
            page ships mobile-web-app-capable and nothing else. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
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
      <body className="operator-surface min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
