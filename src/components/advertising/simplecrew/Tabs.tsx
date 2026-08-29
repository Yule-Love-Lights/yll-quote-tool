'use client';

// The two tab bars (Simple Crew replica). Worker: Campaigns, Camera,
// Profile, Settings. Admin: the same plus Manage Crew — exactly the split
// Naldo described from the reference app.

import { CameraIcon, CrewIcon, FeedIcon, GearIcon, PersonIcon } from './icons';
import { TabBar } from './ui';

export function WorkerTabs({ active }: { active: 'campaigns' | 'capture' | 'profile' | 'settings' }) {
  return (
    <TabBar
      items={[
        { key: 'campaigns', href: '/advertising', icon: <FeedIcon size={26} />, active: active === 'campaigns' },
        { key: 'capture', href: '/advertising/capture', icon: <CameraIcon size={26} />, active: active === 'capture' },
        { key: 'profile', href: '/advertising/profile', icon: <PersonIcon size={26} />, active: active === 'profile' },
        { key: 'settings', href: '/advertising/settings', icon: <GearIcon size={26} />, active: active === 'settings' },
      ]}
    />
  );
}

export function AdminTabs({
  active,
}: {
  active: 'campaigns' | 'crew' | 'capture' | 'settings';
}) {
  // Pay lives INSIDE Settings (Naldo's device round, 2026-08-29): one tab,
  // same screen. /admin/advertising/pay redirects there.
  return (
    <TabBar
      items={[
        { key: 'campaigns', href: '/admin/advertising', icon: <FeedIcon size={26} />, active: active === 'campaigns' },
        { key: 'crew', href: '/admin/advertising/crew', icon: <CrewIcon size={26} />, active: active === 'crew' },
        { key: 'capture', href: '/admin/advertising/capture', icon: <CameraIcon size={26} />, active: active === 'capture' },
        { key: 'settings', href: '/admin/advertising/settings', icon: <GearIcon size={26} />, active: active === 'settings' },
      ]}
    />
  );
}
