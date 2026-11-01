/*
 * it8gen -- write a CGATS reference file from stock Little CMS.
 *
 * Reads a CGATS stimulus file, runs every row through a Little CMS transform on
 * the floating point path, and writes the input and the output side by side.
 *
 * It replaces a patched transicc. Keeping this outside Little CMS means moving
 * to a new release is a recompile, not a patch to carry forward.
 *
 * Usage:
 *   it8gen <stimuli.it8> <source> <destination> <intent> <bpc> <output.it8> [note]
 *
 *   source, destination   a profile path, or *sRGB, or *Lab4
 *   intent                0 perceptual, 1 relative, 2 saturation, 3 absolute
 *   bpc                   0 or 1
 *   note                  optional, written to the header as NOTE
 *
 * Column units follow the stimuli: RGB and GRAY 0..255, CMYK 0..100, CH1/CH2
 * 0..1, Lab as Lab. Little CMS gets the same values transicc gave it.
 *
 * Exit status: 0 written, 2 usage or file error, 3 Little CMS refused the
 * transform (a profile with no table for that direction, for example).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lcms2.h"

#define MAX_CHANNELS 4

typedef struct {
    const char* fields[MAX_CHANNELS];
    double      scale;   /* device value = column / scale */
    int         count;
} ChannelSet;

static int channelsFor(cmsColorSpaceSignature space, ChannelSet* set)
{
    static const char* rgb[]  = { "RGB_R", "RGB_G", "RGB_B" };
    static const char* lab[]  = { "LAB_L", "LAB_A", "LAB_B" };
    static const char* cmyk[] = { "CMYK_C", "CMYK_M", "CMYK_Y", "CMYK_K" };
    static const char* gray[] = { "GRAY" };
    static const char* duo[]  = { "CH1", "CH2" };
    const char** names;
    int i;

    switch (space) {
        case cmsSigRgbData:    names = rgb;  set->count = 3; set->scale = 255.0; break;
        case cmsSigLabData:    names = lab;  set->count = 3; set->scale = 1.0;   break;
        case cmsSigCmykData:   names = cmyk; set->count = 4; set->scale = 1.0;   break;
        case cmsSigGrayData:   names = gray; set->count = 1; set->scale = 255.0; break;
        case cmsSig2colorData: names = duo;  set->count = 2; set->scale = 1.0;   break;
        default: return 0;
    }
    for (i = 0; i < set->count; i++) set->fields[i] = names[i];
    return 1;
}

static cmsHPROFILE openProfile(const char* name)
{
    if (strcmp(name, "*sRGB") == 0) return cmsCreate_sRGBProfile();
    if (strcmp(name, "*Lab4") == 0) return cmsCreateLab4Profile(NULL);
    return cmsOpenProfileFromFile(name, "r");
}

static int findColumn(cmsHANDLE it8, const char* field)
{
    char** names = NULL;
    char   wanted[64];
    int    count = cmsIT8EnumDataFormat(it8, &names);
    int    i;

    snprintf(wanted, sizeof(wanted), "IN_%s", field);
    for (i = 0; i < count; i++) {
        if (strcmp(names[i], wanted) == 0) return i;
    }
    return -1;
}

int main(int argc, char* argv[])
{
    ChannelSet   in, out;
    cmsHANDLE    stimuli;
    cmsHPROFILE  source, destination;
    cmsHTRANSFORM transform;
    cmsUInt32Number flags = cmsFLAGS_NOCACHE | cmsFLAGS_NOOPTIMIZE;
    int          columns[MAX_CHANNELS];
    int          sampleColumn, rows, row, c;
    FILE*        output;

    if (argc != 7 && argc != 8) {
        fprintf(stderr, "usage: it8gen stimuli.it8 source destination intent bpc output.it8 [note]\n");
        return 2;
    }
    if (atoi(argv[5]) != 0) flags |= cmsFLAGS_BLACKPOINTCOMPENSATION;

    stimuli = cmsIT8LoadFromFile(NULL, argv[1]);
    if (stimuli == NULL) { fprintf(stderr, "cannot read %s\n", argv[1]); return 2; }

    source = openProfile(argv[2]);
    destination = openProfile(argv[3]);
    if (source == NULL || destination == NULL) { fprintf(stderr, "cannot open profile\n"); return 2; }

    if (!channelsFor(cmsGetColorSpace(source), &in) ||
        !channelsFor(cmsGetColorSpace(destination), &out)) {
        fprintf(stderr, "unsupported colour space\n");
        return 3;
    }

    transform = cmsCreateTransform(source, cmsFormatterForColorspaceOfProfile(source, 0, TRUE),
                                   destination, cmsFormatterForColorspaceOfProfile(destination, 0, TRUE),
                                   (cmsUInt32Number) atoi(argv[4]), flags);
    if (transform == NULL) { fprintf(stderr, "no transform\n"); return 3; }

    rows = (int) cmsIT8GetPropertyDbl(stimuli, "NUMBER_OF_SETS");
    sampleColumn = cmsIT8FindDataFormat(stimuli, "SAMPLE_ID");
    for (c = 0; c < in.count; c++) {
        columns[c] = findColumn(stimuli, in.fields[c]);
        if (columns[c] < 0) { fprintf(stderr, "stimuli has no IN_%s\n", in.fields[c]); return 2; }
    }

    output = fopen(argv[6], "w");
    if (output == NULL) { fprintf(stderr, "cannot write %s\n", argv[6]); return 2; }

    fprintf(output, "CGATS.17\nORIGINATOR\t\"it8gen\"\nLCMS_VERSION\t\"%d\"\n", cmsGetEncodedCMMversion());
    if (argc == 8) fprintf(output, "NOTE\t\"%s\"\n", argv[7]);
    fprintf(output, "#\n# Data follows\n#\n");
    fprintf(output, "NUMBER_OF_SETS\t%.8f\nNUMBER_OF_FIELDS\t%.8f\nBEGIN_DATA_FORMAT\n SAMPLE_ID", (double) rows, (double) (1 + in.count + out.count));
    for (c = 0; c < in.count; c++)  fprintf(output, "\tIN_%s", in.fields[c]);
    for (c = 0; c < out.count; c++) fprintf(output, "\tOUT_%s", out.fields[c]);
    fprintf(output, "\nEND_DATA_FORMAT\nBEGIN_DATA\n");

    for (row = 0; row < rows; row++) {
        double source_values[MAX_CHANNELS], device_in[MAX_CHANNELS], device_out[MAX_CHANNELS];

        for (c = 0; c < in.count; c++) {
            source_values[c] = cmsIT8GetDataRowColDbl(stimuli, row, columns[c]);
            device_in[c] = source_values[c] / in.scale;
        }
        cmsDoTransform(transform, device_in, device_out, 1);

        fprintf(output, " %s", cmsIT8GetDataRowCol(stimuli, row, sampleColumn));
        for (c = 0; c < in.count; c++)  fprintf(output, "\t%.8f", source_values[c]);
        for (c = 0; c < out.count; c++) fprintf(output, "\t%.8f", device_out[c] * out.scale);
        fprintf(output, "\n");
    }
    fprintf(output, "END_DATA\n");
    fclose(output);

    cmsDeleteTransform(transform);
    cmsCloseProfile(source);
    cmsCloseProfile(destination);
    cmsIT8Free(stimuli);
    return 0;
}
