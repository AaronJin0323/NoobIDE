/**
 * Rules 4–6 — script, image and stylesheet 404s (S22.2).
 *
 * Applies to resource records with status 404 whose type (or file extension) is a script, image or stylesheet.
 * With the project's file list it looks for the likely cause, worded as possibilities (PLAN §9 wireframe 3b):
 * a file whose name differs only in capitalisation, the same file in another folder, or a similarly named file.
 */
import type { MessageRef, ProblemAction, ProblemRecord } from '../../shared/problem';
import { msg, type DiagnosticsMessageKey } from '../messages';
import { baseName, dirName, editDistance, extension, samePath, samePathIgnoringCase, typoThreshold } from '../text';
import type { Rule, RuleContext } from './types';

type Kind = 'script' | 'image' | 'stylesheet';

const EXTENSIONS: Record<Kind, readonly string[]> = {
  script: ['js', 'mjs'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp'],
  stylesheet: ['css'],
};

const TITLES: Record<Kind, DiagnosticsMessageKey> = {
  script: 'notFound.title.script',
  image: 'notFound.title.image',
  stylesheet: 'notFound.title.stylesheet',
};

/**
 * The requested project-relative path, as resolved by the producer (S16.4), which knows the preview origin. A URL
 * on another origin is not a project path, so nothing is guessed from the URL here.
 */
export function requestedPath(record: ProblemRecord): string | undefined {
  return record.resource?.requestedPath || undefined;
}

/** Extension of the requested file, ignoring any query string or fragment in the URL. */
function requestedExtension(record: ProblemRecord, path: string | undefined): string {
  if (path) return extension(path);
  const url = record.resource?.requestedUrl ?? '';
  return extension(url.split(/[?#]/, 1)[0] ?? '');
}

function kindOf(record: ProblemRecord, path: string | undefined): Kind | undefined {
  const t = record.resource?.resourceType;
  if (t === 'script' || t === 'image' || t === 'stylesheet') return t;
  if (t && t !== 'other') return undefined; // fetch, font, media, document: not these rules
  const ext = requestedExtension(record, path);
  return (Object.keys(EXTENSIONS) as Kind[]).find((k) => EXTENSIONS[k].includes(ext));
}

function analyse(path: string, record: ProblemRecord, ctx: RuleContext) {
  const causes: MessageRef[] = [];
  const actions: ProblemAction[] = [];
  let pinpointed = false;
  const url = record.resource?.requestedUrl ?? '';
  if (/^file:/i.test(url) || /^[A-Za-z]:[\\/]/.test(path) || /^\/?[A-Za-z]:[\\/]/.test(path)) {
    causes.push(msg('notFound.cause.absolutePath'));
  }
  const files = ctx.projectFiles;
  if (files) {
    const name = baseName(path);
    const folder = dirName(path);
    const caseMatch = files.find((f) => samePathIgnoringCase(f, path) && !samePath(f, path));
    const elsewhere = caseMatch
      ? undefined
      : files.find((f) => samePathIgnoringCase(baseName(f), name) && !samePathIgnoringCase(dirName(f), folder));
    const max = typoThreshold(name.length);
    const similar =
      caseMatch || elsewhere
        ? undefined
        : files.find((f) => samePath(dirName(f), folder) && max > 0 && editDistance(baseName(f), name) <= max);
    const found = caseMatch ?? elsewhere ?? similar;
    if (caseMatch) causes.push(msg('notFound.cause.case', { actual: caseMatch }));
    if (elsewhere) {
      causes.push(msg('notFound.cause.otherFolder', { actual: elsewhere }));
      if (folder) causes.push(msg('notFound.cause.wrongFolder', { folder }));
    }
    if (similar) causes.push(msg('notFound.cause.similarName', { actual: similar }));
    if (!found) causes.push(msg('notFound.cause.missing'));
    pinpointed = found !== undefined;
    const revealFolder =
      found !== undefined ? dirName(found) : files.some((f) => samePath(dirName(f), folder)) ? folder : '';
    const reveal = revealFolder || found;
    if (reveal)
      actions.push({ kind: 'reveal-in-files', label: msg('action.revealInFiles', { path: reveal }), path: reveal });
  } else {
    causes.push(msg('notFound.cause.missing'));
  }
  return { causes, actions, pinpointed };
}

function notFoundRule(kind: Kind): Rule {
  return {
    id: `${kind}-not-found`,
    explain(record, ctx) {
      if (record.source !== 'resource' || record.resource?.status !== 404) return null;
      const path = requestedPath(record);
      if (kindOf(record, path) !== kind) return null;
      const shown = path ?? record.resource.requestedUrl;
      const { causes, actions, pinpointed } = analyse(shown, record, ctx);
      const initiator = record.resource.initiatorFile ?? record.file;
      return {
        certainty: pinpointed ? 'likely' : 'possible',
        title: msg(TITLES[kind], { path: shown }),
        explanation: msg('notFound.explanation'),
        causes,
        checks: [
          ...(initiator ? [msg('notFound.check.relative', { initiator })] : []),
          msg('notFound.check.compareName'),
        ],
        actions,
      };
    },
  };
}

export const scriptNotFoundRule = notFoundRule('script');
export const imageNotFoundRule = notFoundRule('image');
export const stylesheetNotFoundRule = notFoundRule('stylesheet');
