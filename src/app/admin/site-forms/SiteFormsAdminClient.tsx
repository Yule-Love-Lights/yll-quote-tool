'use client';

// Operator view of non-lead website submissions (#195).
//
// Deliberately separate from /admin/leads: these are not sales leads and should
// never sit in a queue that implies "call this person back". A nomination in
// particular is someone else's neighbour, so the row shows a plain reminder
// that the nominated person has not been contacted.

import { useEffect, useState } from 'react';

type Submission = {
  id: string;
  created_at: string;
  form_type: 'newsletter' | 'careers' | 'intern' | 'nomination';
  form_variant: string;
  name: string | null;
  email: string;
  phone: string | null;
  payload: Record<string, string> | null;
  resume_url: string | null;
  resume_error: string | null;
  consent: boolean;
  landing_url: string | null;
  sync_status: string;
  sync_error: string | null;
  ghl_contact_id: string | null;
  is_test: boolean;
};

const TABS: Array<{ key: string; label: string }> = [
  { key: '', label: 'All' },
  { key: 'newsletter', label: 'Newsletter' },
  { key: 'careers', label: 'Job applications' },
  { key: 'intern', label: 'Intern applications' },
  { key: 'nomination', label: 'Light Up For Hope' },
];

const FIELD_LABELS: Record<string, string> = {
  holidayMemory: 'Favorite holiday memory',
  role: 'Role',
  message: 'Message',
  nomineeName: 'Nominee',
  nomineeAddress: 'Nominee address',
  nomineeEmail: 'Nominee email',
  nomineePhone: 'Nominee phone',
  relationship: 'Relationship',
  story: 'Story',
};

export default function SiteFormsAdminClient() {
  const [type, setType] = useState('');
  const [rows, setRows] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Fetch on mount and whenever the tab changes. State is only touched AFTER
  // an await, so this never sets state synchronously inside the effect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/site-forms${type ? `?type=${type}` : ''}`);
        const json = (await res.json()) as { submissions?: Submission[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || 'Could not load submissions');
          setRows([]);
        } else {
          setRows(json.submissions ?? []);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load submissions');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [type]);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Website form submissions</h1>
      <p style={{ color: '#666', marginBottom: 20, fontSize: 14 }}>
        Newsletter signups, job and intern applications, and Light Up For Hope nominations. These
        are not sales leads: none of them create a pipeline opportunity or enter a text campaign.
        Sales leads live on <a href="/admin/leads">the leads page</a>.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setLoading(true); setType(t.key); }}
            style={{
              padding: '8px 14px',
              borderRadius: 50,
              border: '1px solid #ddd',
              background: type === t.key ? '#1C2230' : '#fff',
              color: type === t.key ? '#fff' : '#1C2230',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <p>Loading...</p>}
      {error && <p style={{ color: '#B00020' }}>{error}</p>}
      {!loading && !error && rows.length === 0 && <p style={{ color: '#666' }}>Nothing yet.</p>}

      <div style={{ display: 'grid', gap: 12 }}>
        {rows.map((row) => (
          <div
            key={row.id}
            style={{
              border: '1px solid #e5e5e5',
              borderRadius: 12,
              padding: 16,
              background: '#fff',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                {/* On every other tab the bold name IS the person the row is
                    about. On a nomination it is the person who SENT it, so say
                    so: mixing the two up means contacting the wrong household. */}
                {row.form_type === 'nomination' && (
                  <span style={{ color: '#666', fontSize: 13 }}>Nominated by </span>
                )}
                <strong style={{ fontSize: 15 }}>{row.name || row.email}</strong>
                <span style={{ color: '#666', fontSize: 13 }}>
                  {' '}
                  · {TABS.find((t) => t.key === row.form_type)?.label ?? row.form_type}
                  {row.is_test ? ' · TEST' : ''}
                </span>
              </div>
              <span style={{ color: '#888', fontSize: 13 }}>
                {new Date(row.created_at).toLocaleString()}
              </span>
            </div>

            <div style={{ fontSize: 14, marginTop: 8, color: '#333' }}>
              <div>
                <a href={`mailto:${row.email}`}>{row.email}</a>
                {row.phone ? (
                  <>
                    {' · '}
                    <a href={`tel:${row.phone}`}>{row.phone}</a>
                  </>
                ) : null}
              </div>

              {/* The nominated household gets its own block with working links,
                  so the person who actually needs contacting is never buried in
                  a generic list of answers. */}
              {row.form_type === 'nomination' && row.payload?.nomineeName && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 12,
                    borderRadius: 10,
                    background: '#FBF7EF',
                    border: '1px solid #EADFC8',
                  }}
                >
                  <div style={{ color: '#666', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                    NOMINATED HOUSEHOLD
                  </div>
                  <strong style={{ fontSize: 15 }}>{row.payload.nomineeName}</strong>
                  {row.payload.nomineeAddress && <div>{row.payload.nomineeAddress}</div>}
                  <div>
                    {row.payload.nomineeEmail && (
                      <a href={`mailto:${row.payload.nomineeEmail}`}>{row.payload.nomineeEmail}</a>
                    )}
                    {row.payload.nomineeEmail && row.payload.nomineePhone ? ' · ' : ''}
                    {row.payload.nomineePhone && (
                      <a href={`tel:${row.payload.nomineePhone}`}>{row.payload.nomineePhone}</a>
                    )}
                  </div>
                </div>
              )}

              {row.payload &&
                Object.entries(row.payload)
                  .filter(
                    ([k]) =>
                      !(
                        row.form_type === 'nomination' &&
                        ['nomineeName', 'nomineeAddress', 'nomineeEmail', 'nomineePhone'].includes(k)
                      ),
                  )
                  .map(([k, v]) => (
                    <div key={k} style={{ marginTop: 4 }}>
                      <span style={{ color: '#666' }}>{FIELD_LABELS[k] ?? k}: </span>
                      {v}
                    </div>
                  ))}

              {row.resume_url && (
                <div style={{ marginTop: 8 }}>
                  <a
                    href={row.resume_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'inline-block',
                      padding: '6px 14px',
                      borderRadius: 50,
                      background: '#CF0303',
                      color: '#fff',
                      textDecoration: 'none',
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    Download resume
                  </a>
                  <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
                    link expires in 5 minutes, refresh this page for a new one
                  </span>
                </div>
              )}

              {/* An applicant who attached a resume that failed to store looks
                  identical to one who attached nothing, unless we say so. */}
              {row.resume_error && (
                <p style={{ color: '#B00020', fontSize: 13, marginTop: 8, marginBottom: 0 }}>
                  This applicant attached a resume but it failed to save. Email them for a copy.
                </p>
              )}

              {row.form_type === 'nomination' && (
                <p style={{ color: '#666', fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                  The nominated person has not been contacted and is not in any campaign. Reach out
                  yourself if this goes ahead.
                </p>
              )}

              <div style={{ color: '#888', fontSize: 12, marginTop: 8 }}>
                Contact sync: {row.sync_status}
                {row.sync_error ? ` (${row.sync_error})` : ''}
                {row.landing_url ? ` · from ${row.landing_url}` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
