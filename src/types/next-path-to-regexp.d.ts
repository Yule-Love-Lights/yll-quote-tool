// Next bundles its own copy of path-to-regexp and ships no types for it.
//
// src/lib/qrLinkHost.test.ts compiles the link-host redirect's `source` string
// with THIS copy on purpose: it is the exact matcher Next will use at runtime, so
// the test measures the real behaviour of the pattern instead of asserting the
// config's shape. Declaring the one function we call is what keeps that honest
// without loosening types anywhere else.
declare module 'next/dist/compiled/path-to-regexp' {
  export interface PathToRegexpOptions {
    sensitive?: boolean;
    strict?: boolean;
    delimiter?: string;
  }
  export function pathToRegexp(path: string, keys?: unknown[], options?: PathToRegexpOptions): RegExp;
}
