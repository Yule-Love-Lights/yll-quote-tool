import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { listContactDuplicates } from '@/lib/dashboard/inbox/store';
import { DuplicatesList } from '@/components/dashboard/inbox/DuplicatesList';

export const dynamic = 'force-dynamic';

export default async function DuplicatesPage() {
  const res = await listContactDuplicates();

  return (
    <OperatorShell active="inbox">
      <div className="max-w-4xl mx-auto w-full">
        <header className="mb-6">
          <Link href="/inbox" className="text-sm" style={{ color: 'var(--op-text-2)' }}>
            ← Inbox
          </Link>
          <h1 className="text-2xl font-semibold mt-1" style={{ color: 'var(--op-text)' }}>
            Possible duplicate contacts
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-2)' }}>
            Contacts that share an email or phone — the ones the system won’t auto-merge. Pick which
            to keep; the other’s messages and follow-ups move onto it, then it’s removed.
          </p>
        </header>

        {res.ok ? (
          <DuplicatesList initialPairs={res.pairs} />
        ) : (
          <div
            className="rounded-md border p-4 text-sm"
            style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Not available yet — the dashboard tables haven’t been provisioned.
            <br />
            <span style={{ opacity: 0.7 }}>Details: {res.error}</span>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
