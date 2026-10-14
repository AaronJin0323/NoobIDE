/**
 * Language-service configuration for HTML / CSS / JavaScript (S18.1, S19.2, PLAN §4 "Code assistance").
 *
 * Monaco-free (plain values plus a function that takes the defaults objects), so the configuration is unit-tested
 * without a browser. monaco-setup.ts applies it to Monaco's bundled services; nothing is fetched from a network.
 *
 * Beginner tuning (S19.2): JavaScript files are type-checked (`checkJs`) only so that undefined names (TS 2304 /
 * 2552) and redeclarations are reported. Diagnostics that are noise for plain browser JavaScript — type mismatches,
 * properties the DOM typings do not know, Node globals, implicit-any and similar — are switched off by code. Syntax
 * errors are always kept. The CSS linter keeps unknown properties and invalid values and drops style opinions.
 */

/** TypeScript ScriptTarget.ESNext / ModuleKind.ESNext / ModuleResolutionKind.NodeJs (numeric enums of the TS API). */
const ES_NEXT = 99;
const NODE_RESOLUTION = 2;

// A type alias (not an interface) so it is assignable to Monaco's index-signature CompilerOptions.
export type JsCompilerOptions = {
  readonly allowJs: boolean;
  readonly checkJs: boolean;
  readonly allowNonTsExtensions: boolean;
  readonly target: number;
  readonly module: number;
  readonly moduleResolution: number;
  readonly noEmit: boolean;
  readonly strict: boolean;
  readonly noImplicitAny: boolean;
};

export const JS_COMPILER_OPTIONS: JsCompilerOptions = {
  allowJs: true,
  checkJs: true,
  allowNonTsExtensions: true,
  target: ES_NEXT,
  module: ES_NEXT,
  moduleResolution: NODE_RESOLUTION,
  noEmit: true,
  strict: false,
  noImplicitAny: false,
};

/**
 * Codes that stay visible (S19.2). Every TypeScript syntax error (1xxx) is kept as well. Listed for documentation and
 * tests; the switch itself is {@link NOISY_TS_CODES}, because Monaco only supports an ignore list.
 */
export const KEPT_TS_CODES: readonly number[] = [
  2304, // Cannot find name 'x'.
  2552, // Cannot find name 'x'. Did you mean 'y'?
  2451, // Cannot redeclare block-scoped variable 'x'.
  2448, // Block-scoped variable 'x' used before its declaration.
];

/**
 * Semantic diagnostics that are noise in a beginner's plain JavaScript (S19.2). Each was seen on ordinary browser code
 * that runs fine: the DOM typings are stricter than the browser, and JS has no type annotations to satisfy.
 */
export const NOISY_TS_CODES: readonly number[] = [
  2307, // Cannot find module — files not loaded into the language service, query strings, absolute URLs
  2322, // Type 'x' is not assignable to type 'y' (el.style.width = 100)
  2339, // Property 'value' does not exist on type 'HTMLElement'
  2345, // Argument of type 'x' is not assignable to parameter of type 'y'
  2349, // This expression is not callable
  2351, // This expression is not constructable
  2362, // The left-hand side of an arithmetic operation must be of type 'any', 'number'…
  2363, // The right-hand side of an arithmetic operation must be …
  2365, // Operator '+' cannot be applied to types …
  2367, // This comparison appears to be unintentional …
  2531, // Object is possibly 'null'
  2532, // Object is possibly 'undefined'
  2554, // Expected 1 arguments, but got 0
  2555, // Expected at least 1 arguments …
  2556, // A spread argument must either have a tuple type …
  2580, // Cannot find name 'require' (Node)
  2591, // Cannot find name 'module' (Node)
  2683, // 'this' implicitly has type 'any'
  2695, // Left side of comma operator is unused and has no side effects
  2739, // Type 'x' is missing the following properties …
  2740, // Type 'x' is missing the following properties … (and more)
  2741, // Property 'x' is missing in type …
  2769, // No overload matches this call
  2774, // This condition will always return true since this function is always defined
  2801, // This condition will always return true since this 'Promise' is always defined
  2802, // Type 'x' can only be iterated through when using the '--downlevelIteration' flag
  7005, // Variable 'x' implicitly has an 'any' type
  7006, // Parameter 'x' implicitly has an 'any' type
  7009, // 'new' expression, whose target lacks a construct signature
  7027, // Unreachable code detected
  7028, // Unused label
  7034, // Variable 'x' implicitly has type 'any' in some locations
  7043, // Variable 'x' implicitly has an 'any[]' type, but a better type may be inferred
  7044, // Parameter 'x' implicitly has an 'any' type, but a better type may be inferred
  8006, // 'interface' declarations can only be used in TypeScript files
  8008, // Type aliases can only be used in TypeScript files
  8010, // Type annotations can only be used in TypeScript files
  80001, // File is a CommonJS module; it may be converted to an ES module (suggestion)
  80002, // This constructor function may be converted to a class declaration (suggestion)
  80004, // JSDoc types may be moved to TypeScript types (suggestion)
  80005, // 'require' call may be converted to an import (suggestion)
  80006, // This may be converted to an async function (suggestion)
  80007, // 'await' has no effect on the type of this expression (suggestion)
];

export interface JsDiagnosticsOptions {
  readonly noSemanticValidation: boolean;
  readonly noSyntaxValidation: boolean;
  readonly noSuggestionDiagnostics: boolean;
  readonly diagnosticCodesToIgnore: number[];
}

export const JS_DIAGNOSTICS_OPTIONS: JsDiagnosticsOptions = {
  noSemanticValidation: false,
  noSyntaxValidation: false,
  // Suggestions ("may be converted to …") are refactoring hints, not problems; they would only add dotted underlines.
  noSuggestionDiagnostics: true,
  diagnosticCodesToIgnore: [...NOISY_TS_CODES],
};

type LintLevel = 'ignore' | 'warning' | 'error';

/** CSS lint (S19.2): real mistakes stay, style opinions go (empty rules appear constantly while typing). */
export const CSS_LINT: Readonly<Record<string, LintLevel>> = {
  compatibleVendorPrefixes: 'ignore',
  vendorPrefix: 'ignore',
  duplicateProperties: 'ignore',
  emptyRules: 'ignore',
  importStatement: 'ignore',
  boxModel: 'ignore',
  universalSelector: 'ignore',
  zeroUnits: 'ignore',
  fontFaceProperties: 'warning',
  hexColorLength: 'error',
  argumentsInColorFunction: 'error',
  unknownProperties: 'warning',
  ieHack: 'ignore',
  unknownVendorSpecificProperties: 'ignore',
  propertyIgnoredDueToDisplay: 'warning',
  important: 'ignore',
  float: 'ignore',
  idSelector: 'ignore',
};

/** The parts of Monaco's language defaults this module touches (structural, so tests pass plain fakes). */
export interface LanguageDefaults {
  readonly javascript: {
    setCompilerOptions(options: JsCompilerOptions): void;
    setDiagnosticsOptions(options: JsDiagnosticsOptions): void;
    setEagerModelSync(value: boolean): void;
  };
  readonly css: {
    setOptions(options: { validate: boolean; lint: Readonly<Record<string, LintLevel>> }): void;
  };
}

/** Applies the NoobIDE configuration. Idempotent; re-applying restarts the language workers (S18.4 recovery). */
export function configureLanguages(defaults: LanguageDefaults): void {
  defaults.javascript.setCompilerOptions(JS_COMPILER_OPTIONS);
  defaults.javascript.setDiagnosticsOptions(JS_DIAGNOSTICS_OPTIONS);
  // Keep every open JavaScript model in the TypeScript program, so names declared in another open script and relative
  // ES module imports are known before that file was ever shown (S18.4).
  defaults.javascript.setEagerModelSync(true);
  defaults.css.setOptions({ validate: true, lint: CSS_LINT });
}
