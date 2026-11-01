#!/usr/bin/env node
/**
 * oracle/generate.js -- build the reference set from a folder of profiles.
 *
 * Step one of two. Point it at any folder of ICC profiles: it reads each
 * header, skips what it cannot test and says why, and writes one CGATS file per
 * conversion using the Little CMS C build. Step two is compare: lcms_compat/run.js
 * for jsColorEngine and oracle/compare-wasm.mjs for lcms-wasm. Both check against
 * these files, so Little CMS C is the single source of truth.
 *
 * It also writes a manifest of what it saw. Licensed profiles cannot ship here,
 * so the manifest is how two people find out they ran the same files: a result
 * only counts as the same as ours if the hashes match.
 *
 * Usage:
 *   node oracle/generate.js [--profiles dir] [--out dir] [--only text]
 *
 * Some conversions are pinned to an older Little CMS, see oracle/pins.json. Each
 * file records the version that wrote it, and why when it was pinned.
 *
 * Reads no jsColorEngine code on purpose. The source of truth should not depend
 * on the thing it is judging.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const COMPAT = path.join(HERE, '..', 'lcms_compat');
const option = (name, fallback) => {
    const at = process.argv.indexOf('--' + name);
    return at === -1 ? fallback : process.argv[at + 1];
};

const PROFILES = path.resolve(option('profiles', path.join(COMPAT, 'profiles')));
const OUT = path.resolve(option('out', path.join(COMPAT, 'reference')));
const ONLY = option('only', null);
const STIMULI = path.join(COMPAT, 'stimuli');

const STIMULUS_FOR = {
    'GRAY': 'gray_input.it8', '2CLR': '2col_input.it8',
    'RGB ': 'rgb_input.it8', 'CMYK': 'cmyk_input.it8',
};
const PINS = JSON.parse(fs.readFileSync(path.join(HERE, 'pins.json'), 'utf8')).pins;
const TESTABLE_CLASSES = ['prtr', 'mntr', 'scnr', 'spac'];
const MODES = [
    { suffix: 'Absolute',       intent: 3, bpc: 0 },
    { suffix: 'Perceptual',     intent: 0, bpc: 0 },
    { suffix: 'Perceptual_BPC', intent: 0, bpc: 1 },
    { suffix: 'Relative',       intent: 1, bpc: 0 },
    { suffix: 'Relative_BPC',   intent: 1, bpc: 1 },
];

function readHeader(file) {
    const bytes = fs.readFileSync(file);
    const text = (from, length) => bytes.toString('latin1', from, from + length);
    if (bytes.length < 132 || text(36, 4) !== 'acsp') return { bytes, invalid: true };
    return {
        bytes,
        version: bytes[8] + '.' + (bytes[9] >> 4),
        profileClass: text(12, 4),
        space: text(16, 4),
        pcs: text(20, 4),
    };
}

function listProfiles(directory) {
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...listProfiles(full));
        else if (/\.ic[cm]$/i.test(entry.name)) found.push(full);
    }
    return found.sort();
}

/** On Windows the C build lives in WSL, which sees C:\x as /mnt/c/x. */
function toolPath(file) {
    if (process.platform !== 'win32') return file;
    const resolved = path.resolve(file).replace(/\\/g, '/');
    return '/mnt/' + resolved[0].toLowerCase() + resolved.slice(2);
}

function pinFor(space, mode) {
    return PINS.find((pin) => pin.space === space && (pin.bpc === undefined || pin.bpc === mode.bpc)) || null;
}

function runGenerator(stimulus, source, destination, mode, output, version, note) {
    const named = (name) => (name.startsWith('*') ? name : toolPath(name));
    const args = [toolPath(path.join(STIMULI, stimulus)), named(source), named(destination),
                  String(mode.intent), String(mode.bpc), toolPath(output)];
    if (note) args.push(note);
    const tool = toolPath(path.join(HERE, 'it8gen-' + version));
    const result = process.platform === 'win32'
        ? spawnSync('wsl.exe', ['-d', process.env.HARNESS_WSL_DISTRO || 'Ubuntu', '--', tool, ...args], { encoding: 'utf8' })
        : spawnSync(tool, args, { encoding: 'utf8' });
    return { status: result.status, message: (result.stderr || '').trim() };
}

function littleCmsVersion() {
    const versions = fs.readdirSync(path.join(HERE, '..', 'lcms_c'))
        .map((name) => /^lcms2-([\d.]+)$/.exec(name)).filter(Boolean).map((match) => match[1]);
    return versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() || 'unknown';
}

fs.mkdirSync(OUT, { recursive: true });

const manifest = {
    littleCMS: littleCmsVersion(),
    generated: new Date().toISOString(),
    pins: PINS,
    profiles: [],
    skipped: [],
};
let written = 0, refused = 0;

const write = (stimulus, source, sourceLabel, destination, destinationLabel, space) => {
    for (const mode of MODES) {
        const output = path.join(OUT, sourceLabel + '_to_' + destinationLabel + '_' + mode.suffix + '.it8');
        const pin = space ? pinFor(space, mode) : null;
        const version = pin ? pin.lcms : manifest.littleCMS;
        const result = runGenerator(stimulus, source, destination, mode, output, version, pin ? pin.reason : null);
        if (result.status === 0) { written++; continue; }
        refused++;
        manifest.skipped.push({
            conversion: sourceLabel + ' to ' + destinationLabel + ' ' + mode.suffix,
            reason: result.message || ('exit ' + result.status),
        });
    }
};

write('rgb_input.it8', '*sRGB', 'srgb_virt', '*Lab4', 'lab');
write('lab_input.it8', '*Lab4', 'lab', '*sRGB', 'srgb_virt');

for (const file of listProfiles(PROFILES)) {
    const name = path.basename(file);
    if (ONLY && !name.includes(ONLY)) continue;
    const header = readHeader(file);

    if (header.invalid) { manifest.skipped.push({ file: name, reason: 'not an ICC profile' }); continue; }
    if (!TESTABLE_CLASSES.includes(header.profileClass)) {
        manifest.skipped.push({ file: name, reason: 'class ' + header.profileClass.trim() + ' has no device side to test' });
        continue;
    }
    const stimulus = STIMULUS_FOR[header.space];
    if (!stimulus) {
        manifest.skipped.push({ file: name, reason: 'no stimuli for colour space ' + header.space.trim() });
        continue;
    }

    manifest.profiles.push({
        file: name,
        bytes: header.bytes.length,
        sha256: crypto.createHash('sha256').update(header.bytes).digest('hex'),
        version: header.version,
        class: header.profileClass.trim(),
        space: header.space.trim(),
        pcs: header.pcs.trim(),
    });

    console.log(name);
    const space = header.space.trim();
    write(stimulus, file, name, '*Lab4', 'lab', space);
    write(stimulus, file, name, '*sRGB', 'srgb', space);
    write('lab_input.it8', '*Lab4', 'lab', file, name, space);
    write('rgb_input.it8', '*sRGB', 'srgb', file, name, space);
}

fs.writeFileSync(path.join(COMPAT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('\n' + written + ' references written from Little CMS ' + manifest.littleCMS + ', '
    + refused + ' refused, ' + manifest.skipped.length + ' entries skipped. See lcms_compat/manifest.json.');
