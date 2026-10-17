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
  // A link to a page that does not exist (the page itself is the 404)
  'notFound.title.page': 'The page {path} does not exist (404): a link leads to a missing page.',
  'notFound.explanation.page':
    'A link (<a href>) probably opened this page, but the project has no such file, so the preview shows “Page not found”. Use “Back to entry page” in the preview toolbar to go back.',
  'notFound.check.link': 'Check the href of the link in {initiator}: the file name, its extension and capital letters.',
  'notFound.check.createPage': 'If the page is still to be written, create it in the file list with exactly this name.',

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

  // Rule 9 — unhandled promise rejection
  'rejection.title': 'A promise failed and no code handled the error.',
  'rejection.explanation':
    'An asynchronous operation (such as a fetch or an awaited result) may have failed, and there is no .catch() or try…catch to handle it. The original error may say why it failed.',
  'rejection.check.catch': 'Add .catch(error => { … }) to the promise, or put the await inside try { … } catch { … }.',
  'rejection.check.reason': 'Expand “Show original error” to see why it failed.',

  // Rule 10 — fetch failures
  'fetch.failed.title': 'The request was not sent or got no response (Failed to fetch).',
  'fetch.status.title': 'The request for {path} failed: the server answered {status}.',
  'fetch.network.title': 'The request for {path} failed ({netError}).',
  'fetch.explanation':
    'The address may be wrong, the file may not exist, or the other server may not be running or may not allow access.',
  'fetch.cause.notFound': 'The file at that address may not exist, or the path may be wrong.',
  'fetch.cause.cors':
    'If the console also shows an error mentioning “CORS”, the other website may not allow this page to read its data.',
  'fetch.cause.offline': 'If the address is on the internet, this computer may be offline.',
  'fetch.cause.serverDown': 'If the address is another server on this computer, that server may not be running.',
  'fetch.check.url':
    "Check the address in fetch; files in the project use relative paths, for example fetch('data.json').",
  'fetch.check.console': 'Look in the console for other errors at the same time.',

  // Rule 11 — CORS
  'cors.title': 'The browser blocked this page from reading data from {url} (CORS).',
  'cors.titleGeneric': 'The browser blocked this page from reading data from another website (CORS).',
  'cors.explanation':
    'That website does not allow other pages to read its data; this is a browser security rule. NoobIDE will not turn this check off, and other browsers behave the same way.',
  'cors.check.local':
    "If you only need some data, save it as a .json file in the project and read it with fetch('name.json').",
  'cors.check.api':
    'If you want to use an online API, check its documentation to confirm that webpages may call it directly (it supports CORS).',

  // Rule 12 — JSON parse errors
  'json.title': 'This text could not be parsed as JSON.',
  'json.html.explanation':
    'What arrived is likely a webpage (starting with <), not JSON. A common cause is a wrong address, so the server sent back a “not found” page.',
  'json.empty.explanation': 'The text to parse may be empty or cut off.',
  'json.quotes.explanation':
    'The JSON may be written incorrectly: property names and strings need double quotes, and there must be no comma after the last item.',
  'json.undefined.explanation':
    'JSON.parse was given undefined; the data may not exist yet (for example, the item is not in localStorage yet).',
  'json.generic.explanation': 'The text to parse may not be valid JSON.',
  'json.check.url': 'If the data comes from fetch, check the address and print the received text to the console.',
  'json.check.file':
    'If the data comes from a .json file in the project, open it and check the double quotes and commas.',

  // Rule 13 — "x is not a function"
  'notFunction.title': '{name} is not a function, so it cannot be called with ().',
  'notFunction.explanation.typo': 'It may be a misspelling: you may mean {candidate}.',
  'notFunction.explanation.several': 'It may be misspelled; similar names are: {candidates}.',
  'notFunction.explanation.notArray': '{object} may not be an array, so it has no {method} method.',
  'notFunction.explanation.generic':
    'This name may not be a function: it may be a plain value, misspelled, or called before it was assigned.',
  'notFunction.check.spelling':
    'Check the spelling and capitalisation (JavaScript is case-sensitive, e.g. the Id in getElementById).',
  'notFunction.check.log': 'Add console.log({name}) before this line to see what it really is.',
  'notFunction.check.array': 'Make sure {object} is an array, for example by checking it with console.log({object}).',

  // Rule 14 — unclosed HTML tag
  'htmlUnclosed.title': 'The <{tag}> tag has no matching </{tag}>.',
  'htmlUnclosed.explanation':
    'A </{tag}> is likely missing, so the content after it may be treated as part of this element and the layout may look wrong.',
  'htmlUnclosed.check.findFromLine': 'From line {line} downwards, add </{tag}> where the content of this element ends.',
  'htmlUnclosed.check.find': 'Add </{tag}> where the content of this element ends.',
  'htmlUnclosed.check.typo':
    'Check the spelling of the closing tag; a misspelled closing tag does not close the element.',
  'htmlUnclosed.check.indent': 'Keep the indentation tidy; it makes an unclosed tag easier to spot.',

  // S42.3 — an /ai prompt line that has not been run yet
  'aiPrompt.title': 'This /ai line is your request to the AI, not code yet.',
  'aiPrompt.explanation':
    'Until you run it or delete it, this line is saved into the file as plain text, so it shows up on your page or breaks your CSS or JavaScript.',
  'aiPrompt.check.runAtLine':
    'Put the cursor at the end of line {line} and press Ctrl+Enter (⌘Enter on a Mac) to let the AI write the code. Right after typing the /ai line, Enter works too.',
  'aiPrompt.check.run':
    'Put the cursor at the end of the /ai line and press Ctrl+Enter (⌘Enter on a Mac) to let the AI write the code. Right after typing the /ai line, Enter works too.',
  'aiPrompt.check.delete': 'If you no longer need it, delete the line.',

  // Rule 15 — selector does not match (guided checks)
  'selector.title': 'The selector {selector} may not match any element on the page.',
  'selector.titleGeneric': 'A style is not being applied.',
  'selector.explanation': 'NoobIDE cannot tell the cause for sure. Go through the checks below one by one.',
  'selector.cause.similarId': 'The HTML has a similar id, “{candidate}”; the spelling or capitalisation may not match.',
  'selector.cause.similarClass':
    'The HTML has a similar class, “{candidate}”; the spelling or capitalisation may not match.',
  'selector.cause.isId': '“{name}” is an id in the HTML, so the selector may need to be #{name}.',
  'selector.cause.isClass': '“{name}” is a class in the HTML, so the selector may need to be .{name}.',
  'selector.check.spelling':
    'Compare with the HTML: check that the class or id is spelled and capitalised exactly like the selector.',
  'selector.check.prefix': 'In a selector, . means class, # means id, and tag names have no symbol.',
  'selector.check.linked':
    'Make sure the <head> of the HTML includes this CSS file with <link rel="stylesheet" href="…"> and that the path is right.',
  'selector.check.override': 'Look for a later rule or a more specific selector that sets the same property.',
  'selector.check.saved': 'Save the file and make sure the preview has refreshed.',
  // S16.6 — opaque cross-origin "Script error."
  'crossOrigin.title': 'A script from another website failed, but the browser hid the details (Script error.).',
  'crossOrigin.explanation':
    'This error likely comes from a script on another website (such as a library from a CDN). For security reasons the browser does not give the page the details of such errors, so NoobIDE cannot show a file name or line number.',
  'crossOrigin.cause.script': 'The page loads a script from another website: {url}',
  'crossOrigin.check.download':
    "Put the library's .js file in the project and load it with a relative path; then the exact location is shown next time.",
  'crossOrigin.check.crossorigin':
    'If that website supports CORS, you can also add the crossorigin attribute to the <script> to see the error details.',
  'crossOrigin.check.console': 'Look in the console for other, more specific errors at the same time.',
  'crossOrigin.external.title': 'A script from another website reported an error: {url}',
  'crossOrigin.external.explanation':
    'The browser reported this error inside a script loaded from another website ({url}), not in a file of your project, so NoobIDE cannot take you to a line in your code. The page itself only receives "Script error." for it: browsers hide the details of errors in scripts from other websites.',
  'crossOrigin.external.check.calls':
    'Check the lines of your own code that use this library just before the error: the values you pass to it, and whether the page is ready (for example, the element exists).',
  // S55.2 rules 16–25 (docs/product/explanation-rules-16-25.md) and their quick-fix labels (S55.3)
  'action.usePath': 'Change the path to {path}',
  'action.createFile': 'Create the file {path}',
  'action.addAlt': 'Add alt="" to this <img>',
  'action.fixClosingTag': 'Change </{from}> to </{to}>',
  'action.useSelector': "Change '{from}' to '{to}'",
  // Rule 16 — broken relative path, found statically
  'brokenRef.title': 'No file in the project matches {attr}="{ref}".',
  'brokenRef.explanation':
    "NoobIDE did not find {path} in the project's file list, so this file may fail to load when the page runs. The file list can lag a moment behind the disk; if you just created the file, save and look again.",
  'brokenRef.cause.similar': 'The project has a similarly named file, {actual}; the path may be mistyped.',
  'brokenRef.cause.several': 'The project has several similarly named files ({candidates}); it may be one of them.',
  'brokenRef.cause.missing': 'The file may not exist yet, or it may be in another folder.',
  'brokenRef.check.relative': 'The path starts from the folder of {file}: ../ means one folder up.',
  'brokenRef.check.compare':
    'Find the file in the file tree and compare the path letter by letter (extension included).',
  // Rule 17 — duplicate id
  'dupId.title': 'The id “{id}” is used more than once in this file (first on line {firstLine}).',
  'dupId.explanation':
    'An id may be used only once per page. With two, getElementById("{id}") finds only the first element, while #{id} styles both.',
  'dupId.check.rename':
    'Give one of the elements a different id; if several elements should share a style, use a class instead.',
  'dupId.check.code': 'Check the JavaScript and CSS that use {id}, and which element they mean.',
  // Rule 18 — <img> without alt
  'imgAlt.title': 'This <img> has no alt attribute.',
  'imgAlt.explanation':
    'alt is the text description of an image: screen readers read it aloud, and it is shown when the image fails to load. An image that is only decoration can have alt="" (empty).',
  'imgAlt.check.describe':
    'Describe the image in a few words inside the quotes of alt="", for example alt="Site logo".',
  // Rule 19 — mismatched closing tag
  'mismatch.title': 'The closing tag </{tag}> has no matching start tag.',
  'mismatch.explanation.open':
    'The browser ignores this </{tag}>. The element open here is <{open}>, so you may have meant </{open}>, or this closing tag may be one too many.',
  'mismatch.explanation.none':
    'No <{tag}> is open here, so the browser ignores this closing tag. It may be one too many, or the start tag may be misspelled.',
  'mismatch.check.pair': 'Look upwards from this line for where <{open}> starts and where its closing tag belongs.',
  'mismatch.check.spelling': 'Check that the start tag and the closing tag are spelled exactly the same.',
  // Rule 20 — CSS length without unit
  'unitless.title': '{property}: {value} has no unit, so the browser ignores this declaration.',
  'unitless.explanation':
    'Apart from 0, lengths need a unit, such as {value}px, {value}%, {value}em or {value}rem. You may have meant {value}px, but the right unit depends on the effect you want.',
  'unitless.check.unit': 'Write the unit right after the number (no space), save and look at the preview.',
  // Rule 21 — inline handler calling an undefined function
  'inlineHandler.title': 'An on… attribute in the page calls {name}, but the browser cannot find that function.',
  'inlineHandler.explanation':
    'An attribute like onclick="{name}()" can only call global functions. When the click (or other event) happened, the browser did not find {name}; the possible causes are listed below.',
  'inlineHandler.cause.module':
    'The function may be in a <script type="module">: functions in a module are not global, so onclick cannot find them.',
  'inlineHandler.cause.notLoaded':
    'The .js file that defines it may not be included with <script src="…">, or its path may be wrong.',
  'inlineHandler.cause.spelling': 'The name in the attribute and the declared name may differ in spelling or case.',
  'inlineHandler.cause.nested': 'The function may be declared inside another function, where the page cannot see it.',
  'inlineHandler.check.compare':
    'Compare on…="{name}()" in the HTML with function {name} in the JavaScript, letter by letter.',
  'inlineHandler.check.listener':
    'You can also use addEventListener instead: find the element in JavaScript and add the event there.',
  // Rule 22 — script runs before the element it reads
  'scriptEarly.title': 'The script got null for #{id}, although the HTML does have an element with id="{id}".',
  'scriptEarly.explanation':
    'The element exists but was not found, so the likely cause is timing: the <script> comes before this element, and the browser ran it before it had read the element.',
  'scriptEarly.check.move': 'Move the <script> to just before </body>, or add defer: <script src="…" defer>.',
  'scriptEarly.check.dynamic': 'If the element is added to the page later by JavaScript, look it up after adding it.',
  'scriptEarly.check.page': 'Make sure the page with the error is the HTML file that has id="{id}".',
  // Rule 23 — selector-prefix mistakes
  'selPrefix.title.byIdHash': "getElementById('{selector}') has an extra {prefix}.",
  'selPrefix.title.queryBare': "querySelector('{selector}') is missing a # or a dot.",
  'selPrefix.explanation.byIdHash':
    'getElementById takes the id itself, without # or a dot, so it likely finds no element here and returns null.',
  'selPrefix.explanation.queryBare':
    'querySelector takes a CSS selector: {selector} without a symbol means a <{selector}> tag. In the page, “{selector}” is an id or a class, so it likely needs to be #{selector} or .{selector}.',
  'selPrefix.cause.isId': 'The project’s HTML has id="{name}".',
  'selPrefix.cause.isClass': 'The project’s HTML has class="{name}".',
  'selPrefix.check.prefix': 'Remember: getElementById("name"), but querySelector("#name") or querySelector(".name").',
  // Rule 24 — reference differs only in letter case
  'refCase.title': '{attr}="{ref}" differs from the project file {actual} only in letter case.',
  'refCase.explanation':
    'On Windows and most Macs the file may still open, but it may fail on another system or a web server that tells capital and small letters apart.',
  'refCase.check.match': 'Write every letter of the path exactly like the file name (case and extension included).',
  // Rule 25 — assignment in an if/while condition
  'assignCond.title': 'The {keyword} condition contains a single =.',
  'assignCond.explanation':
    'A single = assigns: it changes the variable, then the condition tests the new value. You may have meant to compare the two values, which is written ===.',
  'assignCond.check.compare':
    'To compare, change = to ===; if you really want to assign, do it on the line before the condition.',
};
