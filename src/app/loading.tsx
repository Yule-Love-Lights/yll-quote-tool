export default function Loading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="mx-auto w-full max-w-6xl px-6 py-10"
    >
      <div className="mb-8 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="h-20 animate-pulse rounded-lg bg-black/10" />
        <div className="h-20 animate-pulse rounded-lg bg-black/10" />
        <div className="h-20 animate-pulse rounded-lg bg-black/10" />
        <div className="h-20 animate-pulse rounded-lg bg-black/10" />
      </div>
      <div className="space-y-3">
        <div className="h-16 animate-pulse rounded-lg bg-black/10" />
        <div className="h-16 animate-pulse rounded-lg bg-black/10" />
        <div className="h-16 animate-pulse rounded-lg bg-black/10" />
      </div>
    </div>
  );
}
