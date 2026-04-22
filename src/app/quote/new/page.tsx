'use client';

import { useState, useRef } from 'react';
import type {
  QuoteResult,
  MiniLightItem,
  Spritzer,
  Wreath,
  GarlandItem,
} from '@/lib/pricing/pricingEngine';

// ─── Shared CSS constants ────────────────────────────────────────────────────

const inp = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';
const sel = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500';
const lbl = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';
const addBtn = 'mt-1 text-sm text-green-700 hover:text-green-900 font-medium border border-green-300 hover:border-green-500 rounded-md px-3 py-1.5 transition-colors';
const rmBtn = 'text-red-400 hover:text-red-600 font-bold text-xl leading-none mt-0.5';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-4">
      <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-4 pb-2 border-b border-gray-100">
        {title}
      </h2>
      {children}
    </div>
  );
}

// ─── Form state ──────────────────────────────────────────────────────────────

type Customer = { name: string; address: string; phone: string; email: string };

type RooflineDifficulty = 'easy' | 'medium' | 'hard';

type FormData = {
  customer: Customer;
  santasFootage: number;
  santasDifficulty: RooflineDifficulty;
  gingerbreadFootage: number;
  gingerbreadDifficulty: RooflineDifficulty;
  winterWonderlandFootage: number;
  winterWonderlandDifficulty: RooflineDifficulty;
  miniLightItems: MiniLightItem[];
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: GarlandItem[];
  takedown: 'included' | 'premium';
  rushFee: boolean;
  discountEnabled: boolean;
  discountType: 'percentage' | 'flat';
  discountAmount: number;
};

const initial: FormData = {
  customer: { name: '', address: '', phone: '', email: '' },
  santasFootage: 0,
  santasDifficulty: 'medium',
  gingerbreadFootage: 0,
  gingerbreadDifficulty: 'medium',
  winterWonderlandFootage: 0,
  winterWonderlandDifficulty: 'medium',
  miniLightItems: [],
  spritzers: [],
  wreaths: [],
  garland: [],
  takedown: 'included',
  rushFee: false,
  discountEnabled: false,
  discountType: 'percentage',
  discountAmount: 0,
};

// ─── Page component ───────────────────────────────────────────────────────────

export default function NewQuotePage() {
  const [form, setForm] = useState<FormData>(initial);
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Photo analysis
  type LineSegment = { points: [number, number][]; label: string };
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisNotes, setAnalysisNotes] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [santasLines, setSantasLines] = useState<LineSegment[]>([]);
  const [gingerbreadLines, setGingerbreadLines] = useState<LineSegment[]>([]);

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    setAnalysisNotes(null);
    setAnalysisError(null);
    setSantasLines([]);
    setGingerbreadLines([]);
  };

  const handleAnalyzePhoto = async () => {
    if (!photoFile) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisNotes(null);

    const fd = new FormData();
    fd.append('photo', photoFile);

    try {
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
      const r = data.result;
      setForm(f => ({
        ...f,
        santasFootage: r.santasFootage,
        santasDifficulty: r.santasDifficulty,
        gingerbreadFootage: r.gingerbreadFootage,
        gingerbreadDifficulty: r.gingerbreadDifficulty,
      }));
      setSantasLines(r.santasLines ?? []);
      setGingerbreadLines(r.gingerbreadLines ?? []);
      setAnalysisNotes(`${r.notes} (confidence: ${r.confidence})`);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const set = <K extends keyof FormData>(k: K, v: FormData[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const setCustomer = (k: keyof Customer, v: string) =>
    setForm(f => ({ ...f, customer: { ...f.customer, [k]: v } }));

  // Mini lights
  const addMiniLight = () =>
    set('miniLightItems', [...form.miniLightItems, { type: 'tree', wrapStyle: 'trunk', stringCount: 3 }]);
  const removeMiniLight = (i: number) =>
    set('miniLightItems', form.miniLightItems.filter((_, idx) => idx !== i));
  const updateMiniLight = (i: number, patch: Partial<MiniLightItem>) =>
    set('miniLightItems', form.miniLightItems.map((item, idx) => idx === i ? { ...item, ...patch } : item));

  // Spritzers
  const addSpritzer = () =>
    set('spritzers', [...form.spritzers, { size: '24' as const, quantity: 1 }]);
  const removeSpritzer = (i: number) =>
    set('spritzers', form.spritzers.filter((_, idx) => idx !== i));
  const updateSpritzer = (i: number, patch: Partial<Spritzer>) =>
    set('spritzers', form.spritzers.map((item, idx) => idx === i ? { ...item, ...patch } : item));

  // Wreaths
  const addWreath = () =>
    set('wreaths', [...form.wreaths, { size: '30noble' as const, tier: 'bow' as const, quantity: 1 }]);
  const removeWreath = (i: number) =>
    set('wreaths', form.wreaths.filter((_, idx) => idx !== i));
  const updateWreath = (i: number, patch: Partial<Wreath>) =>
    set('wreaths', form.wreaths.map((item, idx) => idx === i ? { ...item, ...patch } : item));

  // Garland
  const addGarland = () =>
    set('garland', [...form.garland, { length: '9ft' as const, type: 'noble' as const, tier: 'bow' as const, quantity: 1 }]);
  const removeGarland = (i: number) =>
    set('garland', form.garland.filter((_, idx) => idx !== i));
  const updateGarland = (i: number, patch: Partial<GarlandItem>) =>
    set('garland', form.garland.map((item, idx) => idx === i ? { ...item, ...patch } : item));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    const inputs = {
      santasFootage: form.santasFootage,
      santasDifficulty: form.santasDifficulty,
      gingerbreadFootage: form.gingerbreadFootage,
      gingerbreadDifficulty: form.gingerbreadDifficulty,
      winterWonderlandFootage: form.winterWonderlandFootage,
      winterWonderlandDifficulty: form.winterWonderlandDifficulty,
      miniLightItems: form.miniLightItems,
      spritzers: form.spritzers,
      wreaths: form.wreaths,
      garland: form.garland,
      takedown: form.takedown,
      rushFee: form.rushFee,
      ...(form.discountEnabled && {
        discount: { type: form.discountType, amount: form.discountAmount },
      }),
    };

    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: form.customer, inputs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setResult(data.result);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <p className="text-xs font-semibold text-green-600 uppercase tracking-widest mb-1">
            Yule Love Lights
          </p>
          <h1 className="text-2xl font-bold text-gray-900">New Quote</h1>
        </div>

        <form onSubmit={handleSubmit}>

          {/* ── Customer Info ── */}
          <Section title="Customer Info">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={lbl}>Name *</label>
                <input className={inp} required placeholder="Jane Smith"
                  value={form.customer.name} onChange={e => setCustomer('name', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Phone</label>
                <input className={inp} placeholder="(516) 555-0123"
                  value={form.customer.phone} onChange={e => setCustomer('phone', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Email</label>
                <input className={inp} type="email" placeholder="jane@example.com"
                  value={form.customer.email} onChange={e => setCustomer('email', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Property Address *</label>
                <input className={inp} required placeholder="123 Main St, Smithtown, NY 11787"
                  value={form.customer.address} onChange={e => setCustomer('address', e.target.value)} />
              </div>
            </div>
          </Section>

          {/* ── Photo Analysis ── */}
          <Section title="House Photo — Auto-Measure">
            <p className="text-xs text-gray-400 mb-3">Upload a photo of the front of the house. Claude will estimate gutterline + ridgeline footage and difficulty.</p>
            <div className="space-y-3">
              <input
                type="file"
                accept="image/*"
                onChange={handlePhotoSelect}
                className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
              />
              {photoPreview && (
                <div className="space-y-3">
                  <div className="relative inline-block max-w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photoPreview} alt="House preview" className="max-w-full h-auto rounded-md border border-gray-200 block" />
                    {(santasLines.length > 0 || gingerbreadLines.length > 0) && (
                      <svg
                        viewBox="0 0 1 1"
                        preserveAspectRatio="none"
                        className="absolute inset-0 w-full h-full pointer-events-none"
                      >
                        {santasLines.map((line, i) => (
                          <polyline
                            key={`s-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#ef4444"
                            strokeWidth="0.006"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                        {gingerbreadLines.map((line, i) => (
                          <polyline
                            key={`g-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#3b82f6"
                            strokeWidth="0.006"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                      </svg>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={handleAnalyzePhoto}
                      disabled={analyzing}
                      className="bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white font-medium py-2 px-4 rounded-md text-sm"
                    >
                      {analyzing ? 'Analyzing…' : 'Analyze with Claude'}
                    </button>
                    {(santasLines.length > 0 || gingerbreadLines.length > 0) && (
                      <div className="flex items-center gap-4 text-xs">
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-500"></span>Gutterline (Santa&apos;s)</span>
                        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-blue-500"></span>Ridgeline (Gingerbread)</span>
                      </div>
                    )}
                  </div>
                  {(santasLines.length > 0 || gingerbreadLines.length > 0) && (
                    <ul className="text-xs text-gray-600 space-y-0.5">
                      {santasLines.map((line, i) => (
                        <li key={`sl-${i}`}><span className="text-red-500 font-bold">■</span> {line.label}</li>
                      ))}
                      {gingerbreadLines.map((line, i) => (
                        <li key={`gl-${i}`}><span className="text-blue-500 font-bold">■</span> {line.label}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {analysisNotes && (
                <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-800">
                  <strong className="block mb-1">Analysis complete — form auto-filled below.</strong>
                  {analysisNotes}
                </div>
              )}
              {analysisError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
                  {analysisError}
                </div>
              )}
            </div>
          </Section>

          {/* ── Santa's — Gutterline ── */}
          <div className={`transition-opacity ${form.santasFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Santa's — Gutterline (C9 Bulbs)">
              <p className="text-xs text-gray-400 mb-3">Auto-measured from photo. Adjust if needed.</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.santasFootage || ''}
                    onChange={e => set('santasFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.santasDifficulty}
                    onChange={e => set('santasDifficulty', e.target.value as RooflineDifficulty)}>
                    <option value="easy">Easy — $8/ft</option>
                    <option value="medium">Medium — $10/ft</option>
                    <option value="hard">Hard — $12/ft</option>
                  </select>
                </div>
              </div>
              {form.santasFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>

          {/* ── Gingerbread — Ridgeline ── */}
          <div className={`transition-opacity ${form.gingerbreadFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Gingerbread — Ridgeline (C9 Bulbs)">
              <p className="text-xs text-gray-400 mb-3">Auto-measured from photo. Adjust if needed.</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.gingerbreadFootage || ''}
                    onChange={e => set('gingerbreadFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.gingerbreadDifficulty}
                    onChange={e => set('gingerbreadDifficulty', e.target.value as RooflineDifficulty)}>
                    <option value="easy">Easy — $8/ft</option>
                    <option value="medium">Medium — $10/ft</option>
                    <option value="hard">Hard — $12/ft</option>
                  </select>
                </div>
              </div>
              {form.gingerbreadFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>

          {/* ── Winter Wonderland — Non-Standard Features ── */}
          <div className={`transition-opacity ${form.winterWonderlandFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Winter Wonderland — Non-Standard Features (C9 Bulbs)">
              <p className="text-xs text-gray-400 mb-3">Enter manually — non-standard features only.</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.winterWonderlandFootage || ''}
                    onChange={e => set('winterWonderlandFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.winterWonderlandDifficulty}
                    onChange={e => set('winterWonderlandDifficulty', e.target.value as RooflineDifficulty)}>
                    <option value="easy">Easy — $8/ft</option>
                    <option value="medium">Medium — $10/ft</option>
                    <option value="hard">Hard — $12/ft</option>
                  </select>
                </div>
              </div>
              {form.winterWonderlandFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>

          {/* ── Trees / Bushes / Columns ── */}
          <Section title="Trees / Bushes / Columns — Mini Lights">
            {form.miniLightItems.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[1fr_1fr_72px_28px] gap-2 mb-1">
                  <span className={lbl}>Type</span>
                  <span className={lbl}>Wrap Style</span>
                  <span className={lbl}>Strings</span>
                  <span />
                </div>
                {form.miniLightItems.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_72px_28px] gap-2 mb-2 items-start">
                    <select className={sel} value={item.type}
                      onChange={e => updateMiniLight(i, { type: e.target.value as MiniLightItem['type'] })}>
                      <option value="tree">Tree</option>
                      <option value="bush">Bush</option>
                      <option value="column">Column</option>
                    </select>
                    <select className={sel} value={item.wrapStyle}
                      onChange={e => updateMiniLight(i, { wrapStyle: e.target.value as MiniLightItem['wrapStyle'] })}>
                      <option value="canopy">Canopy — $35/string</option>
                      <option value="trunk">Trunk — $45/string</option>
                    </select>
                    <input className={inp} type="number" min="1" value={item.stringCount}
                      onChange={e => updateMiniLight(i, { stringCount: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeMiniLight(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addMiniLight} className={addBtn}>
              + Add Tree / Bush / Column
            </button>
          </Section>

          {/* ── Spritzers ── */}
          <Section title="Spritzers">
            {form.spritzers.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[1fr_72px_28px] gap-2 mb-1">
                  <span className={lbl}>Size</span>
                  <span className={lbl}>Qty</span>
                  <span />
                </div>
                {form.spritzers.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_72px_28px] gap-2 mb-2 items-start">
                    <select className={sel} value={item.size}
                      onChange={e => updateSpritzer(i, { size: e.target.value as Spritzer['size'] })}>
                      <option value="16">16&quot; — $85 each</option>
                      <option value="24">24&quot; — $95 each</option>
                      <option value="32">32&quot; — $105 each</option>
                    </select>
                    <input className={inp} type="number" min="1" value={item.quantity}
                      onChange={e => updateSpritzer(i, { quantity: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeSpritzer(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addSpritzer} className={addBtn}>
              + Add Spritzer
            </button>
          </Section>

          {/* ── Wreaths ── */}
          <Section title="Wreaths">
            {form.wreaths.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[1fr_1fr_72px_28px] gap-2 mb-1">
                  <span className={lbl}>Size</span>
                  <span className={lbl}>Tier</span>
                  <span className={lbl}>Qty</span>
                  <span />
                </div>
                {form.wreaths.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_72px_28px] gap-2 mb-2 items-start">
                    <select className={sel} value={item.size}
                      onChange={e => updateWreath(i, { size: e.target.value as Wreath['size'] })}>
                      <option value="24noble">24&quot; Noble</option>
                      <option value="30noble">30&quot; Noble</option>
                      <option value="36noble">36&quot; Noble</option>
                      <option value="48noble">48&quot; Noble</option>
                      <option value="36oregon">36&quot; Oregon</option>
                    </select>
                    <select className={sel} value={item.tier}
                      onChange={e => updateWreath(i, { tier: e.target.value as Wreath['tier'] })}>
                      <option value="labor">Labor Only</option>
                      <option value="bow">With Bow</option>
                      <option value="fullDecor">Full Decor</option>
                    </select>
                    <input className={inp} type="number" min="1" value={item.quantity}
                      onChange={e => updateWreath(i, { quantity: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeWreath(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addWreath} className={addBtn}>
              + Add Wreath
            </button>
          </Section>

          {/* ── Garland ── */}
          <Section title="Garland">
            {form.garland.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[140px_1fr_72px_28px] gap-2 mb-1">
                  <span className={lbl}>Length</span>
                  <span className={lbl}>Tier</span>
                  <span className={lbl}>Qty</span>
                  <span />
                </div>
                {form.garland.map((item, i) => (
                  <div key={i} className="grid grid-cols-[140px_1fr_72px_28px] gap-2 mb-2 items-start">
                    <select className={sel} value={item.length}
                      onChange={e => updateGarland(i, { length: e.target.value as GarlandItem['length'] })}>
                      <option value="9ft">9ft Noble</option>
                      <option value="4.5ft">4.5ft Noble</option>
                    </select>
                    <select className={sel} value={item.tier}
                      onChange={e => updateGarland(i, { tier: e.target.value as GarlandItem['tier'] })}>
                      <option value="labor">Labor Only</option>
                      <option value="bow">With Bow</option>
                      <option value="fullDecor">Full Decor</option>
                    </select>
                    <input className={inp} type="number" min="1" value={item.quantity}
                      onChange={e => updateGarland(i, { quantity: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeGarland(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addGarland} className={addBtn}>
              + Add Garland
            </button>
          </Section>

          {/* ── Options ── */}
          <Section title="Options">

            {/* Takedown */}
            <div className="mb-5">
              <p className={lbl}>Takedown</p>
              <div className="flex gap-8 mt-1.5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="takedown" value="included"
                    checked={form.takedown === 'included'} onChange={() => set('takedown', 'included')} />
                  Included — Jan 9 – Feb 3
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="takedown" value="premium"
                    checked={form.takedown === 'premium'} onChange={() => set('takedown', 'premium')} />
                  Premium (+$150) — before Jan 9
                </label>
              </div>
            </div>

            {/* Rush fee */}
            <div className="mb-5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={form.rushFee}
                  onChange={e => set('rushFee', e.target.checked)} />
                Rush fee — add $150
              </label>
            </div>

            {/* Discount */}
            <div>
              <label className="flex items-center gap-2 text-sm cursor-pointer mb-3">
                <input type="checkbox" checked={form.discountEnabled}
                  onChange={e => set('discountEnabled', e.target.checked)} />
                Apply discount
              </label>
              {form.discountEnabled && (
                <div className="pl-6 flex flex-wrap items-center gap-5">
                  <div className="flex gap-5">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" name="discountType" value="percentage"
                        checked={form.discountType === 'percentage'}
                        onChange={() => set('discountType', 'percentage')} />
                      Percentage
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" name="discountType" value="flat"
                        checked={form.discountType === 'flat'}
                        onChange={() => set('discountType', 'flat')} />
                      Flat dollar
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min="0" step="0.01"
                      className="border border-gray-300 rounded-md px-3 py-2 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={form.discountAmount || ''}
                      placeholder={form.discountType === 'percentage' ? '0.20' : '100'}
                      onChange={e => set('discountAmount', Number(e.target.value))}
                    />
                    <span className="text-xs text-gray-400">
                      {form.discountType === 'percentage' ? 'e.g. 0.20 = 20% off' : 'e.g. 100 = $100 off'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors mb-6 text-base"
          >
            {loading ? 'Calculating…' : 'Calculate Quote'}
          </button>

        </form>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* ── Result ── */}
        {result && (
          <div ref={resultRef} className="bg-white border border-gray-200 rounded-lg p-6 mb-10">
            <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-4 pb-2 border-b border-gray-100">
              Quote Breakdown
            </h2>

            {/* Line items */}
            <div className="mb-4 space-y-1.5">
              {result.lineItems.map((item, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-gray-700">{item.label}</span>
                  <span className="font-medium tabular-nums">{usd(item.amount)}</span>
                </div>
              ))}
            </div>

            {/* Subtotals */}
            <div className="border-t border-gray-200 pt-3 space-y-1.5 text-sm text-gray-600">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span className="tabular-nums">{usd(result.subtotalBeforeDiscount)}</span>
              </div>
              {result.discountAmount > 0 && (
                <div className="flex justify-between text-green-600">
                  <span>Discount</span>
                  <span className="tabular-nums">−{usd(result.discountAmount)}</span>
                </div>
              )}
              {result.minimumApplied && (
                <p className="text-xs text-amber-600 italic">Minimum quote of $1,000 applied</p>
              )}
              {result.rushFeeAmount > 0 && (
                <div className="flex justify-between">
                  <span>Rush fee</span>
                  <span className="tabular-nums">{usd(result.rushFeeAmount)}</span>
                </div>
              )}
              {result.takedownAmount > 0 && (
                <div className="flex justify-between">
                  <span>Premium takedown</span>
                  <span className="tabular-nums">{usd(result.takedownAmount)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Tax (8.625% on {usd(result.taxableAmount)})</span>
                <span className="tabular-nums">{usd(result.taxAmount)}</span>
              </div>
            </div>

            {/* Total + split */}
            <div className="border-t border-gray-300 mt-3 pt-4">
              <div className="flex justify-between items-baseline">
                <span className="text-lg font-bold text-gray-900">Total</span>
                <span className="text-2xl font-bold text-gray-900 tabular-nums">{usd(result.total)}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="bg-green-50 border border-green-200 rounded-md p-3">
                  <p className="text-xs text-green-700 font-medium uppercase tracking-wide">Deposit Due Now</p>
                  <p className="text-xl font-bold text-green-800 tabular-nums mt-0.5">{usd(result.depositAmount)}</p>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
                  <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Balance at Install</p>
                  <p className="text-xl font-bold text-gray-700 tabular-nums mt-0.5">{usd(result.balanceDue)}</p>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
