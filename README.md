# HEX.DANCE

Simple client-side binary analysis and hex dump viewer.

## Technical Details

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
