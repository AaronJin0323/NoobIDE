/**
 * Comment toggling inside an HTML page's `<script>` and `<style>` (S53.4). Monaco's own toggle uses the page's HTML
 * comments there (`<!-- … -->`), which is wrong for JavaScript and CSS; these use `//` and `/* … *\/` instead. Pure;
 * the Monaco glue (authoring-monaco.ts) applies the result as one edit. Everywhere else Monaco's toggle is right.
 */
export type EmbeddedKind = 'script' | 'style';

const indentOf = (line: string) => /^\s*/.exec(line)?.[0] ?? '';

/**
 * Toggles a line comment on each line: `// ` in scripts, `/* … *\/` around the line in styles (CSS has no line
 * comment). Lines are uncommented when every non-blank line is commented already; blank lines are left alone.
 */
export function toggleLineComments(lines: readonly string[], kind: EmbeddedKind): string[] {
  const content = lines.filter((line) => line.trim() !== '');
  if (content.length === 0) return [...lines];
  if (kind === 'script') {
    const commented = content.every((line) => line.trimStart().startsWith('//'));
    if (commented) return lines.map((line) => line.replace(/^(\s*)\/\/ ?/, '$1'));
    const indent = Math.min(...content.map((line) => indentOf(line).length));
    return lines.map((line) => (line.trim() === '' ? line : `${line.slice(0, indent)}// ${line.slice(indent)}`));
  }
  const wrapped = (line: string) => /^\s*\/\*.*\*\/\s*$/.test(line);
  if (content.every(wrapped)) return lines.map((line) => line.replace(/^(\s*)\/\* ?(.*?) ?\*\/(\s*)$/, '$1$2$3'));
  return lines.map((line) => {
    if (line.trim() === '') return line;
    const indent = indentOf(line);
    return `${indent}/* ${line.slice(indent.length).trimEnd()} */`;
  });
}

/** Toggles a block comment around `selected` (both kinds use `/* … *\/`). */
export function toggleBlockComment(selected: string): string {
  const m = /^\/\* ?([\s\S]*?) ?\*\/$/.exec(selected);
  return m ? (m[1] ?? '') : `/* ${selected} */`;
}
