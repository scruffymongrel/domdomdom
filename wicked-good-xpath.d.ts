// wicked-good-xpath ships no type declarations (last touched 2016, no @types
// package exists). We only call `install`, so declare that much rather than
// pull in a full ambient `any`.
declare module 'wicked-good-xpath' {
  const wgxpath: {
    install(target: object, force?: boolean): void
  }
  export default wgxpath
}
