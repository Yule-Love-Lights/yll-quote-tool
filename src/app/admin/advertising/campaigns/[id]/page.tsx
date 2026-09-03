import { notFound, redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';
import { getAdvertisingCampaign } from '@/lib/advertising/campaigns';
import CampaignDetailScreen from '@/components/advertising/simplecrew/CampaignDetailScreen';

export const dynamic = 'force-dynamic';

// Admin campaign detail (Simple Crew replica): the review surface. Every
// photo card carries the money actions — Accept stamps the campaign rate,
// Reject asks for the reason the worker will read — plus duplicate flags.
export default async function AdminCampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  const { id } = await params;
  const campaign = await getAdvertisingCampaign(id);
  if (!campaign) notFound();

  // The settings sheet needs both counts: photos decide whether deleting is
  // even offered, and photos still awaiting review decide what a rate change
  // is about to re-price.
  const { campaignActivitySummary } = await import('@/lib/advertising/placements');
  const activity = (await campaignActivitySummary([campaign.id])).get(campaign.id);

  return (
    <CampaignDetailScreen
      mode="admin"
      campaign={{
        id: campaign.id,
        name: campaign.name,
        kind: campaign.kind,
        notes: campaign.notes,
        rateCents: campaign.rateCents,
        active: campaign.active,
        photoCount: activity?.photoCount ?? 0,
        pendingCount: activity?.pendingCount ?? 0,
      }}
      placementsUrl={`/api/admin/advertising/campaigns/${campaign.id}/placements`}
      backHref="/admin/advertising"
      captureHref={`/admin/advertising/capture?campaign=${encodeURIComponent(campaign.id)}`}
      reviewUrl="/api/admin/advertising/review"
      editUrl="/api/admin/advertising/campaigns"
    />
  );
}
