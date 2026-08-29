import { notFound, redirect } from 'next/navigation';

import { getAdvertisingCaller } from '@/lib/auth/advertisingAuth';
import { getAdvertisingCampaign } from '@/lib/advertising/campaigns';
import BlockedNote from '@/components/advertising/simplecrew/BlockedNote';
import CampaignDetailScreen from '@/components/advertising/simplecrew/CampaignDetailScreen';

// Worker campaign detail (Simple Crew replica): map + Description | Photos
// sheet, its own Map / Capture / My photos nav. The placements URL is the
// worker route, which is scoped to the SESSION worker — so "Photos" here is
// their own work in this campaign, like the reference app's My photos.
export default async function WorkerCampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const caller = await getAdvertisingCaller();
  if (!caller.ok) {
    if (caller.reason === 'unauthenticated') redirect('/login?from=%2Fadvertising');
    if (caller.reason === 'not_advertising') redirect('/');
    return <BlockedNote reason={caller.reason} />;
  }

  const { id } = await params;
  const campaign = await getAdvertisingCampaign(id);
  if (!campaign || !campaign.active) notFound();

  return (
    <CampaignDetailScreen
      mode="worker"
      campaign={{ id: campaign.id, name: campaign.name, kind: campaign.kind, notes: campaign.notes }}
      placementsUrl={`/api/advertising/placements?campaignId=${campaign.id}`}
      backHref="/advertising"
      captureHref="/advertising/capture"
    />
  );
}
