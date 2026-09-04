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

  // The delete gate reads the SAME unfiltered count the server's delete
  // guard uses, so the button and the guard cannot disagree. The count that
  // the display uses excludes test and voided rows, and gating on that made
  // Delete appear for campaigns the server would always refuse.
  // countCampaignPlacements throws rather than guessing, which is right for
  // the delete guard and wrong for a page render: the function it replaced
  // never threw, so a transient count failure would now take the whole
  // campaign screen down instead of just hiding one button (delta-verify).
  // null means unknown, and the sheet then refuses to offer deleting.
  const { countCampaignPlacements } = await import('@/lib/advertising/campaigns');
  let placementTotal: number | null = null;
  try {
    placementTotal = await countCampaignPlacements(campaign.id);
  } catch (error) {
    console.error('campaign detail: counting placements for the delete gate:', error);
  }

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
        placementTotal,
      }}
      placementsUrl={`/api/admin/advertising/campaigns/${campaign.id}/placements`}
      backHref="/admin/advertising"
      captureHref={`/admin/advertising/capture?campaign=${encodeURIComponent(campaign.id)}`}
      reviewUrl="/api/admin/advertising/review"
      editUrl="/api/admin/advertising/campaigns"
    />
  );
}
