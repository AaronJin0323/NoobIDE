/**
 * Editor model registry (S09.1, PLAN §7): exactly one text model per file URI. Switching tabs reuses the model, so
 * its undo stack survives; the editor's view state (cursor, selections, scroll position, folding) is kept per URI
 * and restored when the file is shown again. Closing a tab disposes its model and forgets its view state.
 *
 * Monaco-free so it can be unit-tested: the editor passes a {@link ModelHost} built on monaco.editor.
 */
export interface DisposableModel {
  dispose(): void;
  isDisposed(): boolean;
}

export interface ModelSpec {
  /** Stable model key: the file's `file://` URI, or an `inmemory://` URI for the sample. */
  readonly uri: string;
  readonly text: string;
  readonly language: string;
  readonly eol?: '\n' | '\r\n' | undefined;
}

export interface ModelHost<M extends DisposableModel> {
  /** A model Monaco already holds for this URI (e.g. created by another component), or null. */
  find(uri: string): M | null;
  create(spec: ModelSpec): M;
  /** Disposes a released model. Default: `model.dispose()`. */
  discard?(model: M): void;
}

export class ModelRegistry<M extends DisposableModel, V = unknown> {
  private readonly models = new Map<string, M>();
  private readonly viewStates = new Map<string, V>();

  constructor(private readonly host: ModelHost<M>) {}

  /** Returns the model of `spec.uri`, creating it from `spec` only the first time. Text of a reused model wins. */
  acquire(spec: ModelSpec): M {
    const known = this.models.get(spec.uri);
    if (known && !known.isDisposed()) return known;
    const model = this.host.find(spec.uri) ?? this.host.create(spec);
    this.models.set(spec.uri, model);
    return model;
  }

  get(uri: string): M | undefined {
    const model = this.models.get(uri);
    return model && !model.isDisposed() ? model : undefined;
  }

  has(uri: string): boolean {
    return this.get(uri) !== undefined;
  }

  uris(): string[] {
    return [...this.models.keys()].filter((uri) => this.has(uri));
  }

  saveViewState(uri: string, state: V | null | undefined): void {
    if (state === null || state === undefined) this.viewStates.delete(uri);
    else if (this.models.has(uri)) this.viewStates.set(uri, state);
  }

  viewState(uri: string): V | undefined {
    return this.viewStates.get(uri);
  }

  /** Disposes the model of a closed file. Its undo stack and view state are gone afterwards, by design. */
  release(uri: string): void {
    const model = this.models.get(uri);
    this.models.delete(uri);
    this.viewStates.delete(uri);
    if (model && !model.isDisposed()) {
      if (this.host.discard) this.host.discard(model);
      else model.dispose();
    }
  }

  /** Releases every model whose URI is not in `keep` (tabs closed elsewhere, e.g. when a project closes). */
  retainOnly(keep: Iterable<string>): string[] {
    const wanted = new Set(keep);
    const released = [...this.models.keys()].filter((uri) => !wanted.has(uri));
    for (const uri of released) this.release(uri);
    return released;
  }
}
