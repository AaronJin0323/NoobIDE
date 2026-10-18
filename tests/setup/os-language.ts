/**
 * Vitest setup (vitest.config.ts setupFiles): pins the OS language the unit and integration tests see to zh-CN.
 *
 * S59.2: with no saved choice the workbench starts in the OS language (`navigator.languages`, mapped by
 * shared/os-locale). Node 21+ has a global `navigator` whose languages come from the machine running the tests, so
 * without this pin a test that renders <I18nProvider> would expect Chinese on a Chinese machine and English on CI.
 * zh-CN keeps the expectations written before S59.2 valid. Tests of the mapping itself pass explicit language lists.
 */
const OS_LANGUAGES: readonly string[] = Object.freeze(['zh-CN']);

if (typeof globalThis.navigator === 'object' && globalThis.navigator !== null) {
  Object.defineProperty(globalThis.navigator, 'languages', { configurable: true, get: () => OS_LANGUAGES });
  Object.defineProperty(globalThis.navigator, 'language', { configurable: true, get: () => OS_LANGUAGES[0] });
}
