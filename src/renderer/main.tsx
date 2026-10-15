import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n/I18nProvider';
import { ThemeProvider } from './theme/ThemeProvider';
import { Workbench } from './workbench/Workbench';
import './styles.css';
import './glass.css'; // S40 Liquid Glass layer, after the base styles

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('missing #root');

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <Workbench />
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);

// Packaged-app self-test (src/main/self-test.ts): only when main loaded us with ?selftest=1.
if (new URLSearchParams(window.location.search).get('selftest') === '1') {
  void import('./editor/self-test-run').then(async ({ runSelfTest }) => {
    const result = await runSelfTest();
    console.info(`NOOBIDE_SELFTEST ${JSON.stringify(result)}`);
  });
}
