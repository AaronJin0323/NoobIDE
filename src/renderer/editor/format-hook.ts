/**
 * Pre-format hook (S18.3): local history (S21) must be able to keep the text as it was right before a document is
 * formatted, whichever way formatting was started — the Format button, the shortcut, Monaco's context menu or its
 * command palette. Every path ends in a formatting provider, so the providers themselves are wrapped: when Monaco asks
 * a provider for formatting edits, the hook fires first with the document's current text, then the real provider runs.
 *
 * Monaco-free (structural types) so the wrapping is unit-tested; monaco-setup.ts installs it on `monaco.languages`
 * before any language registers its providers.
 */
export interface PreFormatEvent {
  /** Monaco model URI (`file:///…` for project files). */
  readonly uri: string;
  /** The whole document before formatting. In memory only; never logged. */
  readonly text: string;
  readonly languageId: string;
}

/** S53.4: how a document formatting request ended (no text: the outcome only). */
export interface FormatOutcomeEvent {
  readonly uri: string;
  readonly ok: boolean;
}

type Listener = (event: PreFormatEvent) => void;
type OutcomeListener = (event: FormatOutcomeEvent) => void;
const outcomeListeners = new Set<OutcomeListener>();

/** S53.4: subscribes to the outcome of document formatting (format on save tells a failure apart from success). */
export function onFormatOutcome(listener: OutcomeListener): () => void {
  outcomeListeners.add(listener);
  return () => outcomeListeners.delete(listener);
}

function emitOutcome(event: FormatOutcomeEvent): void {
  for (const listener of [...outcomeListeners]) {
    try {
      listener(event);
    } catch {
      // never blocks formatting
    }
  }
}

/** Reports when the provider's answer (a value or a promise) settles; returns the answer unchanged. */
function reportOutcome(uri: string, run: () => unknown): unknown {
  let answer: unknown;
  try {
    answer = run();
  } catch (error) {
    emitOutcome({ uri, ok: false });
    throw error;
  }
  if (answer && typeof (answer as PromiseLike<unknown>).then === 'function') {
    (answer as PromiseLike<unknown>).then(
      // No edits (null / []) means the document is formatted already: only a rejection is a failure.
      () => emitOutcome({ uri, ok: true }),
      () => emitOutcome({ uri, ok: false }),
    );
  } else emitOutcome({ uri, ok: true });
  return answer;
}
const listeners = new Set<Listener>();

/** Subscribes to pre-format events; returns the unsubscribe function. */
export function onBeforeFormat(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitBeforeFormat(event: PreFormatEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A failing subscriber must never block formatting.
    }
  }
}

interface ModelLike {
  readonly uri: { toString(): string };
  getValue(): string;
  getLanguageId(): string;
}

interface FormattingProvider {
  provideDocumentFormattingEdits(model: ModelLike, ...rest: never[]): unknown;
}
interface RangeFormattingProvider {
  provideDocumentRangeFormattingEdits(model: ModelLike, ...rest: never[]): unknown;
}

export interface FormattingRegistry<S> {
  registerDocumentFormattingEditProvider(selector: S, provider: FormattingProvider): unknown;
  registerDocumentRangeFormattingEditProvider(selector: S, provider: RangeFormattingProvider): unknown;
}

const INSTALLED = Symbol.for('noobide.formatHookInstalled');

const eventOf = (model: ModelLike): PreFormatEvent => ({
  uri: model.uri.toString(),
  text: model.getValue(),
  languageId: model.getLanguageId(),
});

/** Wraps the registry's formatting registrations so every provider emits the pre-format hook first. Idempotent. */
export function installFormatHook<S>(registry: FormattingRegistry<S>): void {
  const marked = registry as FormattingRegistry<S> & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  const registerDocument = registry.registerDocumentFormattingEditProvider.bind(registry);
  const registerRange = registry.registerDocumentRangeFormattingEditProvider.bind(registry);
  // Object.create keeps the provider's prototype (Monaco's providers are class instances with more members, such as
  // displayName); only the formatting method is overridden, and it calls the original with the original `this`.
  registry.registerDocumentFormattingEditProvider = (selector, provider) => {
    const wrapped = Object.create(provider) as FormattingProvider;
    wrapped.provideDocumentFormattingEdits = (model: ModelLike, ...rest: never[]) => {
      emitBeforeFormat(eventOf(model));
      return reportOutcome(model.uri.toString(), () => provider.provideDocumentFormattingEdits(model, ...rest));
    };
    return registerDocument(selector, wrapped);
  };
  registry.registerDocumentRangeFormattingEditProvider = (selector, provider) => {
    const wrapped = Object.create(provider) as RangeFormattingProvider;
    wrapped.provideDocumentRangeFormattingEdits = (model: ModelLike, ...rest: never[]) => {
      emitBeforeFormat(eventOf(model));
      return provider.provideDocumentRangeFormattingEdits(model, ...rest);
    };
    return registerRange(selector, wrapped);
  };
}
