import { monaco, startedWorkers } from './monaco-setup';

/**
 * Proves the language workers really run (S02.4): a CSS lint warning and a JavaScript syntax error can only appear
 * as markers after a round trip to the CSS and TypeScript workers. Used by the packaged-app self-test.
 */
export interface ProbeResult {
  pass: boolean;
  css: number;
  js: number;
  workers: string[];
  ms: number;
}

export async function probeMonacoWorkers(timeoutMs = 30_000): Promise<ProbeResult> {
  const started = performance.now();
  const cssUri = monaco.Uri.parse('inmemory://noobide-probe/probe.css');
  const jsUri = monaco.Uri.parse('inmemory://noobide-probe/probe.js');
  const cssModel = monaco.editor.createModel('a { colr: red; }\n', 'css', cssUri);
  const jsModel = monaco.editor.createModel('let = ;\n', 'javascript', jsUri);
  const count = (uri: monaco.Uri) => monaco.editor.getModelMarkers({ resource: uri }).length;

  try {
    await new Promise<void>((resolve) => {
      const check = () => {
        if ((count(cssUri) > 0 && count(jsUri) > 0) || performance.now() - started > timeoutMs) {
          sub.dispose();
          clearInterval(poll);
          resolve();
        }
      };
      const sub = monaco.editor.onDidChangeMarkers(check);
      const poll = setInterval(check, 250);
      check();
    });
    const css = count(cssUri);
    const js = count(jsUri);
    return {
      pass: css > 0 && js > 0,
      css,
      js,
      workers: [...new Set(startedWorkers)],
      ms: Math.round(performance.now() - started),
    };
  } finally {
    cssModel.dispose();
    jsModel.dispose();
  }
}
