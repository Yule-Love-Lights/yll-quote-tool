// Telegram settings (Settings → Telegram) — per-audience outbound chat
// routing. Broadcast-to-all is why the Jobs and Inventory group chats were
// getting lead pings alongside their own; this page lets staff assign each
// env-allowlisted chat to the audiences (leads/jobs/inventory/ops) it should
// receive, backed by telegramRouting.ts.

import { redirect } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { authGateEngaged, getOperator } from '@/lib/auth/supabaseServer';
import { isTelegramBotEnabled, isTelegramConfigured } from '@/lib/integrations/telegram';
import { TELEGRAM_AUDIENCES, TELEGRAM_AUDIENCE_LABELS } from '@/lib/integrations/telegramRouting';
import { TelegramRoutingManager } from '@/components/settings/TelegramRoutingManager';

export const dynamic = 'force-dynamic';

export default async function TelegramSettingsPage() {
  // #81 defense-in-depth — engaged by default; dormant only on the explicit
  // AUTH_GATE_ENABLED=false opt-out (ledger #347), same as the other operator
  // settings pages.
  if (authGateEngaged() && !(await getOperator())) {
    redirect('/login?from=/settings/telegram');
  }

  const configured = isTelegramBotEnabled() && isTelegramConfigured();

  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="telegram" />
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Telegram</h1>
          <p className="text-sm text-gray-500 mt-1">
            Choose which chats get which outbound Telegram notifications — new leads, job prep pings,
            low-stock/purchase-order alerts, and the morning ops digest.
          </p>
        </div>

        {configured ? (
          <TelegramRoutingManager audiences={TELEGRAM_AUDIENCES} labels={TELEGRAM_AUDIENCE_LABELS} />
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
            <p className="font-medium text-gray-900">Telegram bot is not configured</p>
            <p className="mt-1 leading-relaxed">
              Set <code className="text-xs">TELEGRAM_BOT_ENABLED</code>, <code className="text-xs">TELEGRAM_BOT_TOKEN</code>,
              and <code className="text-xs">TELEGRAM_ALLOWED_CHATS</code> first, then reload this page to assign chat
              routing.
            </p>
          </div>
        )}
      </main>
    </OperatorShell>
  );
}
