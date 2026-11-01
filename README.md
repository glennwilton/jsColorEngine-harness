# jsColorEngine harness

Checks that [jsColorEngine](https://github.com/glennwilton/jsColorEngine) gets the
right answers, and measures how fast it gets them. It is separate from the engine
so the engine stays small, and so the C code and benchmark dependencies here have
nothing to do with what ships on npm.

## Setup

The harness runs against the engine's source, so clone it inside the engine:

```bash
git clone https://github.com/glennwilton/jsColorEngine
cd jsColorEngine
git clone https://github.com/glennwilton/jsColorEngine-harness harness
```

The engine ignores the `harness/` folder, so the two stay separate repositories.

## Testing against Little CMS

Little CMS is compiled from source and used as the reference. Both jsColorEngine
and `lcms-wasm` are compared against the files it writes.

Little CMS is strong evidence rather than the final word. When an engine
disagrees with it, the ICC specification decides where it has an answer.

**1. Build the reference tool.** This needs gcc, so on Windows run it in WSL.

```bash
cd lcms_c && ./fetch-lcms2.sh 2.20 && ./fetch-lcms2.sh 2.16
cd ../oracle && ./build.sh 2.20 && ./build.sh 2.16
```

**2. Put profiles in a folder.** Subfolders are fine. `lcms_compat/profiles/README.md`
lists the set we test and where to get each one. No ICC profiles ship here, because
most are licensed, but any profiles of your own will work.

**3. Generate references.**

```bash
node oracle/generate.js --profiles path/to/profiles
```

This reads each header, skips what it cannot test and says why, and writes a CGATS
file for every conversion: to and from Lab and sRGB, in five intent and BPC
combinations. It uses `lcms_compat/stimuli/`.

**4. Compare.**

```bash
node lcms_compat/run.js --profiles path/to/profiles   # jsColorEngine
cd lcms-comparison && npm install && cd ..
node oracle/compare-wasm.mjs --profiles path/to/profiles   # lcms-wasm
```

### Comparing your results with ours

`lcms_compat/manifest.json` lists each profile we ran with its SHA-256 and the Little
CMS version. A result only counts as the same as ours if the hashes match. With
different profiles, you are testing your own set, which is equally valid.

### Pinned versions

`oracle/pins.json` keeps some conversions on an older Little CMS and says why. Every
reference file records the version that wrote it in `LCMS_VERSION`, with the reason
in `NOTE` if it was pinned.

## Speed

`node reproduce.js` runs the full comparison and throughput session and writes to
`results/`. It takes about 30 minutes, and the native phases need WSL on Windows.
The engine's `scripts/release_snapshot.js` drives it for a release.

`node ../bench/mpx_summary.js` is the quick throughput gate, and it stays in the
engine repository.

## What else is here

| Folder | What it is |
|---|---|
| `lcms_compat/` | Comparison runner, stimuli, stage-level pixel probe |
| `oracle/` | Reference generator and the `lcms-wasm` comparison |
| `lcms-comparison/` | Image-path accuracy and speed against `lcms-wasm` |
| `lcms_c/` | Native Little CMS speed harness |
| `release_matrix/` | Full speed matrix behind the published tables |
| `*_poc/`, one-off scripts | Experiments the engine's deep-dive documents cite. Kept so their numbers can be reproduced, not maintained |

## License

MPL-2.0, the same as the engine. Little CMS is MIT licensed and is downloaded from
its own project, not included here.
