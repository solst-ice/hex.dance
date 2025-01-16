# HEX.DANCE

Basic client-side binary and file analysis and hex dump viewer and editor.

## Features

- Privacy: Runs fully client-side in the browser (files are never sent to a server)
- Hex dump viewer and editor
- Basic file and binary analysis
- Basic Mach-O parser

## Details

HEX.DANCE is built with:
- React + Vite for the frontend
- Custom Mach-O binary parser
- CSS animations for visual effects
- No backend required - all processing happens in the browser

### Supported Binary Types

- Mach-O 32-bit (`MH_MAGIC`: 0xfeedface)
- Mach-O 64-bit (`MH_MAGIC_64`: 0xfeedfacf)
- Universal binaries (`FAT_MAGIC`: 0xcafebabe)
- Handles both native and byte-swapped variants
- Images (JPG, PNG, GIF)
- PDF
- Zip files with content listing
