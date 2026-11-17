# hex.dance

A hex viewer, editor and file analyser that runs entirely in your browser. Files never leave your device.

**[hex.dance](https://hex.dance/)**

## What it does

- **Hex view and editor** that stays fast on large files, with keyboard navigation, go-to, undo and redo.
- **Understands 39 formats**, including ELF, PE, Mach-O, WebAssembly, ZIP, tar, PNG, JPEG, PDF and SQLite: fields decoded and described, symbols for executables, listings for archives.
- **Tools:** strings, search, hashes, entropy, embedded-file scan, compare, preview, byte visualisations, a printable poster, and the bytes played as sound.
- **Learn:** guided challenges on files made for the purpose.

## Develop

Needs Node 22.

```bash
npm install
npm run dev      # local server
npm test         # unit tests
npm run lint
npm run build
npm run deploy   # publish dist/ to GitHub Pages
```

React and Vite, plain JavaScript, no runtime dependencies beyond React. A format is one module in `src/formats/`; a panel is one folder in `src/panels/`.
