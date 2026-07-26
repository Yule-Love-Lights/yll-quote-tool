export default function Loading() {
  return (
    <main
      role="status"
      aria-busy="true"
      aria-label="Loading your quote"
      className="relative flex min-h-screen w-full flex-col items-center justify-center bg-slate-950 px-6 py-24 text-center text-slate-100"
    >
      <div className="relative mb-8 h-16 w-16">
        <div className="absolute inset-0 animate-pulse rounded-full bg-slate-800/60" />
        <div className="absolute inset-4 rounded-full bg-slate-700/60" />
      </div>
      <p className="text-lg text-slate-300">Loading your quote&hellip;</p>
      <p className="mt-3 text-sm text-slate-500">Yule Love Lights</p>
    </main>
  );
}
