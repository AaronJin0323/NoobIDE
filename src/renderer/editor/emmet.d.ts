/**
 * The part of the `emmet` package (decision 0039) NoobIDE uses. The package ships types, but its package.json
 * "exports" map does not point at them, so TypeScript's bundler resolution cannot find them.
 */
declare module 'emmet' {
  export interface ExpandConfig {
    readonly type?: 'markup' | 'stylesheet';
    readonly syntax?: string;
    readonly options?: Readonly<Record<string, unknown>>;
    readonly variables?: Readonly<Record<string, string>>;
  }
  export interface ExtractedAbbreviation {
    readonly abbreviation: string;
    readonly location: number;
    readonly start: number;
    readonly end: number;
  }
  export function extract(
    line: string,
    pos?: number,
    options?: { readonly type?: 'markup' | 'stylesheet'; readonly lookAhead?: boolean },
  ): ExtractedAbbreviation | undefined;
  export default function expand(abbreviation: string, config?: ExpandConfig): string;
}
