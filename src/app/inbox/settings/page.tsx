import { OperatorShell } from '@/components/OperatorShell';

export const dynamic = 'force-dynamic';

export default function InboxSettingsPage() {
  return (
    <OperatorShell active="inbox">
      <div className="max-w-2xl mx-auto w-full">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--op-text)' }}>Inbox settings</h1>
        <p className="text-sm mt-2" style={{ color: 'var(--op-text-2)' }}>
          Escalation timing and noise-filter controls will live here. Escalation is currently amber after 1h,
          red after 4h, with an end-of-day digest (America/New_York).
        </p>
      </div>
    </OperatorShell>
  );
}
