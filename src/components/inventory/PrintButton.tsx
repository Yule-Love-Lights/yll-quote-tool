'use client';

// Print / Save-PDF trigger for the work-order page (#82 Slice 3 follow-up).
// Browsers' "Save as PDF" in the print dialog IS the PDF export — no server-side
// PDF engine needed. Hidden in print output via the .no-print class.

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print rounded-md bg-[#1f7a4d] px-4 py-2 text-sm font-semibold text-white hover:bg-[#176039]"
    >
      Print / Save as PDF
    </button>
  );
}
