import { redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';
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
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');
  // Scope the campaign memory to THIS admin: several of us may share a
  // device, and the memory must not carry one person's campaign into
  // another's session (technical + staff lens MED).
  const operator = await getOperator();

  return (
    <CameraScreen
      campaignsUrl="/api/admin/advertising/campaigns"
      submitUrl="/api/admin/advertising/capture"
      noteBase="/api/admin/advertising/placements"
      backHref="/admin/advertising"
      memoryScope={`admin:${operator?.id ?? "unknown"}`}
      fromPageCampaignId={campaign ?? null}
    />
  );
}
