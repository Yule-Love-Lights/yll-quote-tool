// Plain server-rendered answer for a login the population lock admits but
// the worker table cannot serve (deactivated, or not yet linked).
export default function BlockedNote({ reason }: { reason: 'inactive' | 'no_worker_row' }) {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-3 bg-[#0B140F] px-6 text-center text-[#F4EFE6]">
      <h1 className="text-xl font-semibold">
        {reason === 'inactive' ? 'This account is switched off' : 'Almost set up'}
      </h1>
      <p className="max-w-sm text-sm text-[#C9D3CB]">
        {reason === 'inactive'
          ? 'Your sign-crew account is not active right now. Talk to the office if that seems wrong.'
          : 'Your login works, but the office has not finished setting up your worker profile yet. Give them a call.'}
      </p>
    </main>
  );
}
