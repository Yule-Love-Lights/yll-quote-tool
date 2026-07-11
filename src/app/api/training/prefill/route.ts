import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getQuoteRaw } from '@/lib/quotes';
import { getDesignByQuote } from '@/lib/designs';
import { sceneToFewShotPieces, sceneAuxiliaryC9Lines } from '@/lib/design/sceneToFewShot';

// #109 Phase 1: operator-only pre-fill for /training/new. When the photographed
// job was quoted in the tool, this projects its APPROVED design scene into the
// exact few-shot markup shape the training page already writes (the same
// vocabulary sceneToFewShotPieces feeds the AI-detect corpus) plus the quote's
// roofline footage/difficulty inputs. It's a DRAFT the operator reconciles
// against the completed-install photo — never returned as authoritative, and
// never auto-applied (the page only calls this on an explicit operator click).
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TrainingDifficulty = 'easy' | 'medium' | 'hard';
const DIFFICULTIES = new Set<TrainingDifficulty>(['easy', 'medium', 'hard']);

// Stored quote inputs are jsonb (not compile-time verified) and the form layer
// allows a 'custom' difficulty choice that never actually persists to the DB
// (buildQuoteInputs resolves 'custom' down to its preset fallback before
// saving — see quoteForm.ts toWireRate) — but a legacy/malformed row could
// still carry something unexpected. Guard the few-shot corpus the same way
// /api/training's own sanitizer does.
function asTrainingDifficulty(v: unknown, fallback: TrainingDifficulty): TrainingDifficulty {
  return typeof v === 'string' && DIFFICULTIES.has(v as TrainingDifficulty) ? (v as TrainingDifficulty) : fallback;
}

export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;

  const quoteId = req.nextUrl.searchParams.get('quoteId');
  if (!quoteId || !UUID_RE.test(quoteId)) {
    return NextResponse.json({ error: 'A valid quoteId is required' }, { status: 400 });
  }

  const quote = await getQuoteRaw(quoteId);
  if (!quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  const design = await getDesignByQuote(quoteId);
  if (!design || !design.photoW || !design.photoH) {
    return NextResponse.json({ error: 'This quote has no design to pre-fill from' }, { status: 404 });
  }

  const pieces = sceneToFewShotPieces(design.scene, design.photoW, design.photoH);
  const aux = sceneAuxiliaryC9Lines(design.scene, design.photoW, design.photoH);

  const i = quote.inputs ?? {};
  return NextResponse.json({
    markup: {
      santasLines: pieces.santasLines,
      gingerbreadLines: pieces.gingerbreadLines,
      c9Lines: aux.c9Lines,
      stakeLines: aux.stakeLines,
      miniLightDetections: pieces.miniLightDetections,
      wreathDetections: pieces.wreathDetections,
      spritzerDetections: pieces.spritzerDetections,
      garlandDetections: pieces.garlandDetections,
    },
    inputs: {
      santasFootage: i.santasFootage ?? 0,
      santasDifficulty: asTrainingDifficulty(i.santasDifficulty, 'medium'),
      gingerbreadFootage: i.gingerbreadFootage ?? 0,
      gingerbreadDifficulty: asTrainingDifficulty(i.gingerbreadDifficulty, 'medium'),
      winterWonderlandFootage: i.winterWonderlandFootage ?? 0,
      winterWonderlandDifficulty: asTrainingDifficulty(i.winterWonderlandDifficulty, 'medium'),
      stakeLightingFootage: i.stakeLightingFootage ?? 0,
      stakeLightingDifficulty: asTrainingDifficulty(i.stakeLightingDifficulty, 'easy'),
    },
    address: quote.customer_address ?? undefined,
  });
}
