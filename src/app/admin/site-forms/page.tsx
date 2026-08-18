import SiteFormsAdminClient from './SiteFormsAdminClient';

// Non-lead website submissions (#195). Thin server wrapper; the data comes from
// /api/admin/site-forms, which enforces requireAdmin().
export default function SiteFormsAdminPage() {
  return <SiteFormsAdminClient />;
}
