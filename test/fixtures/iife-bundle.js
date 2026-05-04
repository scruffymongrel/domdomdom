// Mimics what tsup/esbuild emit: top-level `var foo = (() => {...})()` that
// must end up on `window.foo`. The naive happy-dom path wraps the script body
// in `function anonymous(...)`, so `foo` becomes a local. Our extraction path
// runs this via page.evaluate() (Script.runInContext) so `foo` is a real
// window global.
var bundleResult = (() => {
  return { ok: true, version: '1.0.0' }
})()
