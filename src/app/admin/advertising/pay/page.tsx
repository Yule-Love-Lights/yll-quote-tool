import { redirect } from 'next/navigation';

// Pay merged into Settings (Naldo's device round, 2026-08-29: "the
// settings and the pay area should be the same exact thing"). This route
// stays as a redirect so old links and habits keep working.
export default function AdminPayPage() {
  redirect('/admin/advertising/settings');
}
