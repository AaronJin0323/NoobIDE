import type { DiagnosticsMessageKey } from './zh-CN';

/** Problem explanation texts, English (required locale). Must define exactly the keys of zh-CN.ts. */
export const en: Record<DiagnosticsMessageKey, string> = {
  // Location and headings
  'location.fileLine': '{file}, line {line}: ',
  'location.file': '{file}: ',
  'heading.possibleCauses': 'Possible causes:',
  'heading.checks': 'Things to check:',
  'certainty.certain': 'Cause confirmed',
  'certainty.likely': 'Likely cause',
  'certainty.possible': 'Possible cause',
  'certainty.unknown': 'Cause not certain',

  // Actions
  'action.goToCode': 'Go to code',
  'action.showOriginal': 'Show original error',
  'action.revealInFiles': 'Show {path} in the file tree',
  'action.replaceWith': 'Change to {name}',

  // Fallback (no rule matched)
  'fallback.title.static': 'The code check found a problem.',
  'fallback.title.runtime': 'An error happened while the page was running.',
  'fallback.title.resource': 'A file did not load.',
  'fallback.title.console': 'The page printed an error to the console.',
  'fallback.explanation':
    'NoobIDE cannot tell the cause yet. The original error is what the browser reported; the names or files it mentions may be the clue.',
  'fallback.check.goToCode': 'Click “Go to code” and look at the line where it happened.',
  'fallback.check.readOriginal':
    'Expand “Show original error” and look for variable names, file names or line numbers in it.',

  // Rule 1 — misspelled / undefined variable
  'undefinedName.title': 'Cannot find the variable {name}.',
  'undefinedName.explanation': 'The name may be misspelled, or it may not be defined yet.',
  'undefinedName.check.matchWithLine':
    'Check whether its spelling matches {candidate} (line {line}) where it was defined.',
  'undefinedName.check.match': 'Check whether its spelling matches {candidate} where it was defined.',
  'undefinedName.check.matchSeveral': 'Check whether its spelling matches one of these defined names: {candidates}.',
  'undefinedName.check.caseOnly': 'JavaScript is case-sensitive: {name} and {candidate} are two different names.',
  'undefinedName.check.spelling': 'Check that the spelling and capitalisation match the definition exactly.',
  'undefinedName.check.declare': 'If the variable has not been defined yet, declare it first.',
  'undefinedName.check.otherFile':
    'If it is defined in another .js file, check that the HTML loads that file with a <script> before this one.',

  // Rule 2 — brackets and other syntax errors
  'syntax.title.endOfInput': 'The code ends before it is finished (unexpected end of input).',
  'syntax.title.missingParen': 'A function call is missing its closing ).',
  'syntax.title.unexpected': 'Unexpected {token} here.',
  'syntax.title.expected': 'A {token} is expected here.',
  'syntax.title.invalidToken': 'This line has a character the browser cannot read.',
  'syntax.title.generic': 'The code is not written correctly (syntax error).',
  'syntax.explanation.unclosed':
    'An opening {, ( or [ is likely never closed, so the browser reached the end still looking for its partner.',
  'syntax.explanation.bracket': 'A bracket is likely unmatched: every (, [ and { needs a matching ), ] and }.',
  'syntax.explanation.invalidToken':
    'A quote may not be closed, or full-width (Chinese) punctuation may have been used.',
  'syntax.explanation.generic':
    'The browser cannot read how this is written. A comma, an operator or a bracket may be missing.',
  'syntax.cause.extraClose': 'There may be one {token} too many, or the opening bracket before it may be missing.',
  'syntax.cause.unclosedQuote': 'A quote (\' or ") may not be closed.',
  'syntax.cause.fullWidth': 'This line contains the full-width punctuation {char}; code needs ASCII punctuation.',
  'syntax.cause.previousLine':
    'The problem may be on the line before, for example a missing comma or bracket at its end.',
  'syntax.check.countBrackets': 'From the error line upwards, check that every {, ( and [ has a matching }, ) and ].',
  'syntax.check.bracketHighlight': 'Put the cursor next to a bracket: the editor highlights its partner.',
  'syntax.check.quotes': 'Check that the quotes on this line come in pairs.',
  'syntax.check.englishPunctuation': 'Switch to an English keyboard layout and retype the punctuation on this line.',
  'syntax.check.previousLine': 'Also check the one or two lines before the error position.',

  // Rule 3 — DOM element not found (null)
  'nullElement.title': 'The page element was not found (it is null), so {property} cannot be used.',
  'nullElement.explanation': 'getElementById or querySelector may not have found the element and returned null.',
  'nullElement.cause.idMissing': 'The HTML may have no element with the id “{id}”.',
  'nullElement.cause.idSimilar':
    'The HTML has a similar id, “{candidate}”; the spelling or capitalisation may not match.',
  'nullElement.cause.idHash': "getElementById does not take a #: it may need to be getElementById('{id}').",
  'nullElement.cause.selector': 'The selector “{selector}” may not match any element.',
  'nullElement.cause.tooEarly':
    'The script may run before the element exists: the <script> is in <head> or above the element.',
  'nullElement.check.compare':
    'Compare with the HTML: check the spelling and capitalisation of the id or selector (# means id, . means class).',
  'nullElement.check.scriptPosition': 'Move the <script> to just before </body>, or add defer to it.',

  // Rules 4–6 — script, image and stylesheet not found (404)
  'notFound.title.script': 'The script {path} did not load (404); its code will not run.',
  'notFound.title.image': 'The image {path} did not load (404).',
  'notFound.title.stylesheet': 'The stylesheet {path} did not load (404); its styles will not apply.',
  'notFound.explanation':
    'The page asked for this file, but it was not found in the project. The path or file name may be wrong.',
  'notFound.cause.case':
    'The capitalisation of the file name differs: the project has {actual}. This works on Windows but may not on a Mac or a website.',
  'notFound.cause.otherFolder': 'The file may be in another folder: the project has {actual}.',
  'notFound.cause.wrongFolder': 'The file is not in the {folder} folder.',
  'notFound.cause.similarName': 'The file name may be misspelled: the project has a similar file, {actual}.',
  'notFound.cause.missing': 'The file may not be in the project yet, or its name may be misspelled.',
  'notFound.cause.absolutePath':
    'The path may point to a location on this computer (such as C:\\ or file://); webpages can only use relative paths inside the project.',
  'notFound.check.relative':
    'The path starts from the folder that contains {initiator}; to go up one folder, write ../.',
  'notFound.check.compareName':
    'Find the file in the file tree and compare its name and extension, including capitalisation.',

  // Rule 7 — misspelled CSS property
  'cssProperty.title': 'The browser does not know the CSS property {property}; this style is ignored.',
  'cssProperty.explanation.one': 'It may be a misspelling of {candidate}.',
  'cssProperty.explanation.several': 'It may be misspelled; similar properties are: {candidates}.',
  'cssProperty.explanation.none': 'It may be misspelled, or the property may not exist.',
  'cssProperty.check.spelling': 'Correct the property name and save; the preview will update.',
  'cssProperty.check.reference': 'If you are not sure of the name, look it up in the CSS property list in Help.',

  // Rule 8 — module import failures
  'module.bare.title': 'The module "{specifier}" could not be loaded.',
  'module.bare.explanation':
    'Browsers load modules by path only. "{specifier}" does not start with ./, ../ or /, so it looks like the name of an npm package, and NoobIDE does not support npm packages yet.',
  'module.bare.check.relative':
    'If it is a file in the project, write a path starting with ./ and include the .js extension.',
  'module.bare.check.download': 'If it is a library, put its .js file in the project and import it with a ./ path.',
  'module.notModule.title': 'This script uses import or export but was not loaded as a module.',
  'module.notModule.explanation': 'The <script> tag in the HTML is likely missing type="module".',
  'module.notModule.check.type': 'Add type="module" to this <script> tag in the HTML.',
  'module.missingExport.title': '{module} has no export named {name}.',
  'module.missingExport.explanation':
    'This code imports {name}, but {module} does not export anything with that name. The name may be misspelled, or the export may be missing there.',
  'module.missingExport.check.export':
    'Open {module} and check that it says export, with exactly the same spelling and capitalisation.',
  'module.missingExport.check.default':
    'If that file uses export default, import it here without curly braces: import name from …',
  'module.loadFailed.title': 'A module file did not load.',
  'module.loadFailed.explanation':
    'The module file may not exist or the path may be wrong: the server did not send back a JavaScript file.',
  'module.loadFailed.check.path':
    'Check the path and file name in the import, including capitalisation and the .js extension.',
};
