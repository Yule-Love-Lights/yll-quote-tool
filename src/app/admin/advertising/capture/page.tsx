import { redirect } from 'next/navigation';

import { getOperator } from '@/lib/auth/supabaseServer';
import CameraScreen from '@/components/advertising/simplecrew/CameraScreen';

export const dynamic = 'force-dynamic';

// The ADMIN camera (Simple Crew replica: owners shoot too). Submits through
// the shared capture pipeline under the admin's auto-provisioned worker
// row; their signs flow through the same review + pay rules as anyone's.
export default async function AdminCapturePage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { campaign } = await searchParams;
  // ONE auth call, deliberately: the role check and the id that scopes the
  // campaign memory come from the same response, so they cannot diverge.
  // Two calls meant a transient failure on the second could leave every
  // admin sharing one memory bucket, which is the bug this scoping exists
  // to prevent (delta-verify HIGH).
  const operator = await getOperator();
  if (operator?.role !== 'admin') redirect('/');

  return (
    <CameraScreen
      campaignsUrl="/api/admin/advertising/campaigns"
      submitUrl="/api/admin/advertising/capture"
      noteBase="/api/admin/advertising/placements"
      backHref="/admin/advertising"
      memoryScope={`admin:${operator.id}`}
      fromPageCampaignId={campaign ?? null}
    />
  );
}
