'use client';
import { useRouter } from 'next/navigation';
import { PipelineActionsMenu } from './PipelineActionsMenu';

/**
 * A PipelineActionsMenu for use inside a SERVER component. A server component
 * can't pass an onDone callback across the RSC boundary (functions aren't
 * serializable), so this thin client wrapper owns one that re-runs the server
 * render via router.refresh(). The row reflects the new status right after an
 * action — matching how the client-side /admin lists refresh (they re-fetch;
 * a server-rendered page re-renders instead).
 */
export function PipelineActionsMenuRefresh({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  return <PipelineActionsMenu quoteId={quoteId} onDone={() => router.refresh()} />;
}
