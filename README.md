# Waveform Plotter

`Waveform Plotter` is a VS Code extension for embedded debugging workflows. It resolves variables from ELF/debug info, samples values from the target, and renders them as live waveforms or FFT spectra inside the editor.

Author: `rccyuvyu`

## Highlights

- Plot scalar variables directly from a debug session
- Resolve variables from ELF, GDB, and composite expressions
- Expand `struct` / `class` trees and browse members in the side panel
- Live sampling through OpenOCD
- High-rate streaming through RTT
- Time-domain and FFT display modes
- Editable leaf values from the variable inspector
- CSV export for offline analysis
- Persistent workspace settings and tracked variables

## Data Sources

### Live Watch

Uses OpenOCD memory reads for direct polling.

- Best for quick bring-up and low-to-medium rate inspection
- Supports ELF symbol lookup and debugger-assisted fallback resolution
- Good when RTT is not available yet

### RTT

Uses OpenOCD RTT server plus target-side streaming.

- Best for higher sampling rates
- Lower overhead than repeated memory polling
- Recommended when you want stable high-frequency acquisition

## Main Features

- Passive sampling on debugger `stopped` events
- Real-time waveform plotting
- FFT view with windowing
- Variable tree with expand/collapse, filtering, and tracked-only view
- Per-channel colors and channel-limit protection
- Actual sampling-rate feedback in the panel
- OpenOCD RTT auto-init with RAM region scan and cache

## Typical Workflow

1. Start a debug session or load an ELF in the workspace
2. Add a variable from the input box or editor context menu
3. Expand composite nodes if needed
4. Check the leaf variables you want to plot
5. Choose `Telnet` or `RTT`
6. Start live mode and inspect the waveform or FFT

## Project Layout

- `src/extension.ts`: extension entry
- `src/controller.ts`: state, commands, view sync, source switching
- `src/services/`: ELF, GDB, Live Watch, RTT, OpenOCD, passive collection
- `src/ui/`: webview host
- `media/main.js`: panel logic and canvas renderer
- `media/styles.css`: panel styles

## Development

```bash
npm install
npm run compile
```

## Packaging

```bash
npx @vscode/vsce package --out waveform-plotter-vscode-<version>.vsix
```

In this repo, every release build should also bump the patch version in:

- `package.json`
- `package-lock.json`

## Notes

- `arm-none-eabi-nm` and `arm-none-eabi-gdb` are used for symbol/type resolution
- OpenOCD is required for Live Watch and RTT modes
- RTT mode depends on target firmware emitting CSV-style channel data
