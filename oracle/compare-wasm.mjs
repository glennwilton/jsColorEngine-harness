#!/usr/bin/env node
/**
 * oracle/compare-wasm.mjs -- lcms-wasm against the Little CMS C references.
 *
 * Runs every file oracle/generate.js wrote back through lcms-wasm and reports
 * the difference. jsColorEngine is compared against the same files by
 * lcms_compat/run.js, so both have one source of truth.
 *
 * READ THE VERSIONS BEFORE READING THE NUMBERS. lcms-wasm ships an older Little
 * CMS than the C build may be on, and it has no 64-bit float path, so this runs
 * on float32. A small difference here can be either of those.
 *
 * Usage:
 *   node oracle/compare-wasm.mjs [--profiles dir] [--refs dir] [--filter text]
 *
 * 2-channel files are skipped: lcms-wasm has no float format for them.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPAT = path.join(HERE, '..', 'lcms_compat');
const require = createRequire(import.meta.url);
const parse = require(path.join(COMPAT, 'parse-cgats.js'));
const parseFile = (text) => { const table = parse.parseCGATS(text); return { fields: table.fields, rows: table.rows.map((row) => (Array.isArray(row) ? row : table.fields.map((field) => row[field]))) }; };

const option = (name, fallback) => {
    const at = process.argv.indexOf('--' + name);
    return at === -1 ? fallback : process.argv[at + 1];
};
const REFS = path.resolve(option('refs', path.join(COMPAT, 'reference')));
const PROFILES = path.resolve(option('profiles', path.join(COMPAT, 'profiles')));
const FILTER = option('filter', null);

const lcmsModule = await import(new URL('file:///' + path.join(HERE, '..', 'lcms-comparison', 'node_modules', 'lcms-wasm', 'dist', 'lcms.js').replace(/\\/g, '/')).href);
const lcms = await lcmsModule.instantiate();
const { cmsFLAGS_NOOPTIMIZE, cmsFLAGS_NOCACHE, cmsFLAGS_BLACKPOINTCOMPENSATION,
        FLOAT_SH, COLORSPACE_SH, CHANNELS_SH, BYTES_SH, PT_RGB, PT_CMYK, PT_GRAY, PT_Lab } = lcmsModule;

// lcms-wasm exports no *_FLT constants, so build them the way lcms2.h does.
const float32 = (space, channels) => FLOAT_SH(1) | COLORSPACE_SH(space) | CHANNELS_SH(channels) | BYTES_SH(4);
const TYPE_RGB_FLT = float32(PT_RGB, 3), TYPE_CMYK_FLT = float32(PT_CMYK, 4),
      TYPE_GRAY_FLT = float32(PT_GRAY, 1), TYPE_Lab_FLT = float32(PT_Lab, 3);

const MODES = [
    ['_Relative_BPC', 1, true], ['_Perceptual_BPC', 0, true],
    ['_Relative', 1, false], ['_Perceptual', 0, false], ['_Absolute', 3, false],
];

// Column prefix -> format, the divisor from column units to what lcms takes,
// and the unit the error is reported in.
const SPACES = {
    RGB:  { format: TYPE_RGB_FLT,  scale: 255, unit: 'LSB u8' },
    GRAY: { format: TYPE_GRAY_FLT, scale: 255, unit: 'LSB u8' },
    CMYK: { format: TYPE_CMYK_FLT, scale: 1,   unit: '% ink' },
    LAB:  { format: TYPE_Lab_FLT,  scale: 1,   unit: 'Lab' },
};

function indexProfiles(directory, into = new Map()) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) indexProfiles(full, into);
        else if (!into.has(entry.name)) into.set(entry.name, full);
    }
    return into;
}

const profileIndex = indexProfiles(PROFILES);
const opened = new Map();

function open(name) {
    if (opened.has(name)) return opened.get(name);
    let handle = null;
    if (name === 'srgb' || name === 'srgb_virt') handle = lcms.cmsCreate_sRGBProfile();
    else if (name === 'lab') handle = lcms.cmsCreateLab4Profile(null);
    else if (profileIndex.has(name)) {
        const bytes = new Uint8Array(fs.readFileSync(profileIndex.get(name)));
        handle = lcms.cmsOpenProfileFromMem(bytes, bytes.byteLength);
    }
    opened.set(name, handle);
    return handle;
}

const spaceOf = (fields, prefix) => {
    const column = fields.find((field) => field.startsWith(prefix) && field !== 'SAMPLE_ID');
    if (!column) return null;
    return column.slice(prefix.length).split('_')[0];
};

const directions = new Map();
let compared = 0, skipped = 0;

for (const file of fs.readdirSync(REFS).filter((name) => name.endsWith('.it8')).sort()) {
    if (FILTER && !file.includes(FILTER)) continue;
    const base = file.replace(/\.it8$/, '');
    const mode = MODES.find(([suffix]) => base.endsWith(suffix));
    if (!mode) { skipped++; continue; }
    const stem = base.slice(0, -mode[0].length);
    const split = stem.indexOf('_to_');
    const sourceName = stem.slice(0, split), destinationName = stem.slice(split + 4);

    const table = parseFile(fs.readFileSync(path.join(REFS, file), 'utf8'));
    const sourceSpace = SPACES[spaceOf(table.fields, 'IN_')];
    const destinationSpace = SPACES[spaceOf(table.fields, 'OUT_')];
    const source = open(sourceName), destination = open(destinationName);
    if (!sourceSpace || !destinationSpace || !source || !destination) { skipped++; continue; }

    const flags = cmsFLAGS_NOOPTIMIZE | cmsFLAGS_NOCACHE | (mode[2] ? cmsFLAGS_BLACKPOINTCOMPENSATION : 0);
    const transform = lcms.cmsCreateTransform(source, sourceSpace.format, destination, destinationSpace.format, mode[1], flags);
    if (!transform) { skipped++; continue; }

    const inColumns = table.fields.map((field, column) => (field.startsWith('IN_') ? column : -1)).filter((column) => column >= 0);
    const outColumns = table.fields.map((field, column) => (field.startsWith('OUT_') ? column : -1)).filter((column) => column >= 0);
    const rows = table.rows.length;
    const input = new Float32Array(rows * inColumns.length);
    table.rows.forEach((row, r) => inColumns.forEach((column, c) => { input[r * inColumns.length + c] = row[column] / sourceSpace.scale; }));

    const output = lcms.cmsDoTransform(transform, input, rows);
    lcms.cmsDeleteTransform(transform);

    let worst = 0, total = 0;
    table.rows.forEach((row, r) => outColumns.forEach((column, c) => {
        const difference = Math.abs(output[r * outColumns.length + c] * destinationSpace.scale - row[column]);
        total += difference;
        if (difference > worst) worst = difference;
    }));

    const key = sourceName + ' → ' + destinationName;
    const entry = directions.get(key) || { unit: destinationSpace.unit, worst: 0, total: 0, values: 0 };
    entry.worst = Math.max(entry.worst, worst);
    entry.total += total;
    entry.values += rows * outColumns.length;
    directions.set(key, entry);
    compared++;
}

console.log('lcms-wasm against the Little CMS C references (float32 path)\n');
const ranked = [...directions.entries()].sort((a, b) => b[1].worst - a[1].worst);
for (const [key, entry] of ranked) {
    console.log('  ' + key.padEnd(58) + entry.worst.toFixed(4).padStart(10) + '  mean ' + (entry.total / entry.values).toFixed(5) + '  ' + entry.unit);
}
console.log('\n' + compared + ' files compared, ' + skipped + ' skipped.');
