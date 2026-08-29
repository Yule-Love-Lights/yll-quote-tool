import { redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';
import CameraScreen from '@/components/advertising/simplecrew/CameraScreen';

export const dynamic = 'force-dynamic';

// The ADMIN camera (Simple Crew replica: owners shoot too). Submits through
// the shared capture pipeline under the admin's auto-provisioned worker
// row; their signs flow through the same review + pay rules as anyone's.
export default async function AdminCapturePage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    <CameraScreen
      campaignsUrl="/api/admin/advertising/campaigns"
      submitUrl="/api/admin/advertising/capture"
      noteBase="/api/admin/advertising/placements"
      backHref="/admin/advertising"
    />
  );
}
