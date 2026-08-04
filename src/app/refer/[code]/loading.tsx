// Route loading skeleton for /refer/[code] (#171c). Without this, the route
// fell back to the ROOT app/loading.tsx (light, dashboard-shaped) while
// refer/layout.tsx (the dark portal fonts + portal-dark.css) hadn't rendered
// yet either — a light flash before the page's actual near-black background
// (bg-[#060B0F], see page.tsx's <main>). Mirrors the portal's own dark
// loading.tsx (src/app/portal/[quoteId]/loading.tsx) shape, using the refer
// page's own palette instead of the portal's slate tones.
export default function Loading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="relative flex min-h-screen w-full flex-col items-center justify-center bg-[#060B0F] px-6 py-24 text-center"
    >
      <div className="relative mb-8 h-16 w-16">
        <div className="absolute inset-0 animate-pulse rounded-full bg-[#1F2A23]" />
        <div className="absolute inset-4 rounded-full bg-[#0D1519]" />
      </div>
      <p className="text-lg text-[#E0D7C1]">Loading&hellip;</p>
      <p className="mt-3 text-sm text-[#A89F87]">Yule Love Lights</p>
    </main>
  );
}
