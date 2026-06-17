// Custom-graphic resolver (task #32 Phase 3). The vendored editor + portal
// renderer (editor-core/custom.ts) load a custom item's image from
// `/photos/<imagePath>`. This route maps that path to the public Supabase
// object URL and redirects — so the editor-core convention "just works" with no
// editor-core change. (The custom-uploads bucket is public, so URLs are stable.)

import { NextResponse } from 'next/server';
import { resolvePublicUrl } from '@/lib/customUploads';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const objectPath = (path ?? []).join('/');
  const url = resolvePublicUrl(objectPath);
  if (!url) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.redirect(url, 307);
}
