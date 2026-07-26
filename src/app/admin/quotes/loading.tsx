export default function Loading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="mx-auto w-full max-w-none px-6 py-8"
    >
      <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
      <div className="mb-4 h-10 w-full animate-pulse rounded-md bg-black/10" />
      <div className="space-y-2">
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
      </div>
    </div>
  );
}
