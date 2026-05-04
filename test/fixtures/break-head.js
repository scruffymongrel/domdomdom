Object.defineProperty(document.head, 'appendChild', {
  value: () => { throw new Error('appendChild blocked by test') },
  configurable: true,
})
