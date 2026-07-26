export default function Loading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="mx-auto w-full max-w-6xl px-6 py-8"
    >
      <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
      <div className="mb-4 h-96 animate-pulse rounded-lg bg-black/10" />
      <div className="grid grid-cols-3 gap-4">
        <div className="h-24 animate-pulse rounded-lg bg-black/10" />
        <div className="h-24 animate-pulse rounded-lg bg-black/10" />
        <div className="h-24 animate-pulse rounded-lg bg-black/10" />
      </div>
    </div>
  );
}
