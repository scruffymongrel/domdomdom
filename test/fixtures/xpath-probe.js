// Records DOM XPath availability at script-parse time — i.e. the moment a
// page's own <script src> runs, which is when htmx 4 instantiates
// XPathEvaluator. Used by test/xpath.test.ts to pin down *when* the polyfill
// is installed, not just that it eventually is.
window.__xpathAtParseTime = {
  evaluator: typeof XPathEvaluator,
  evaluate: typeof document.evaluate,
}
