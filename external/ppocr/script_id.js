/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Script identification of text lines, to choose the recognition model(s) of
// a page before loading any of them. Each line crop is binarized and split
// into connected components; a few dozen shape statistics (component sizes,
// x-height zones, ascenders, dots and other marks, stems, holes, projection
// profiles) feed a tiny neural network. A page then loads the recognizers of
// the scripts with enough votes, weighted by line length.
//
// The Cyrillic recognizer reads Latin text almost as well as the Latin one
// (its dictionary has the ASCII and Latin-1 letters, but e.g. no Polish or
// Czech ones), while the Latin one reads almost no Cyrillic, and the
// classifier sometimes confuses the two scripts on a single line. So when a
// page has Cyrillic, its Latin lines are read by the Cyrillic recognizer too.

/** The scripts the classifier knows. */
const SCRIPTS = ["latin", "cyrillic", "cjk", "arabic"];

// Lines shorter than this, in text heights (about 3 characters), don't get a
// script: there is too little to see.
const MIN_LINE_LENGTH = 3;

// The vote of a line is its length in text heights, up to this.
const MAX_LINE_WEIGHT = 40;

// Lines classified with a lower confidence don't vote, and are read by the
// recognizer of the page's main script.
const MIN_CONFIDENCE = 0.6;

// A page whose main script has at least this share of the votes uses that
// script only.
const SINGLE_SCRIPT_SHARE = 0.85;

// Otherwise, another script is also used if it has at least this share of
// the votes, from at least this many lines (a single line is more likely to
// be misclassified than a whole paragraph).
const MIN_EXTRA_SHARE = 0.1;
const MIN_EXTRA_LINES = 2;

// The number of lines to classify first, the longest ones, see
// `pickSampleLines`.
const SAMPLE_LINES = 20;

// When the confident lines of a page add up to less than this many text
// heights, the prior script (e.g. the one of the previous page) gets a vote
// of `PRIOR_WEIGHT`.
const WEAK_EVIDENCE = 10;
const PRIOR_WEIGHT = 5;

// The classifier: a multilayer perceptron with one hidden layer of tanh units
// and a softmax output (in `SCRIPTS` order). It was trained (cross-entropy
// with class weights and L2 regularization, Adam) on about 3,800 lines of
// synthetic pages, rendered with headless Chrome in 27 fonts (serif, sans
// and monospace, each used for both Latin and Cyrillic text, plus Noto/Droid
// CJK and Arabic fonts), in 14 Latin and Cyrillic languages, Chinese,
// Japanese, Arabic, Persian and Urdu, with regular, bold, italic and
// uppercase lines, "scanned" at 150 and 100 DPI, then detected, straightened
// and scaled to the 48-pixel height of the recognizer input. On scans in
// held-out fonts it gets about 95% of the Latin/Cyrillic lines and nearly all
// the CJK/Arabic lines right, and the main script of every page.
//
// Each feature is standardized with the mean and standard deviation of the
// training data; the weights are in thousandths, one row per unit with the
// bias last.
const FEATURES = [
  ["narrowAscFrac", 0.01404, 0.0358],
  ["midAscFrac", 0.01868, 0.03682],
  ["midDescFrac", 0.01908, 0.03198],
  ["initialAscFrac", 0.02449, 0.03936],
  ["xOnlyFrac", 0.8356, 0.132],
  ["medWx", 1.132, 0.6827],
  ["wideXFrac", 0.2776, 0.2783],
  ["narrowXFrac", 0.04172, 0.07395],
  ["symX", 0.7444, 0.09196],
  ["stemsX", 1.659, 0.8804],
  ["twoStemFrac", 0.4472, 0.22],
  ["topFillX", 0.7068, 0.1345],
  ["botFillX", 0.706, 0.09671],
  ["flatTopFrac", 0.6092, 0.2413],
  ["holeXFrac", 0.5343, 0.2021],
  ["dotFrac", 0.01741, 0.03753],
  ["lettersPerXh", 0.7522, 0.2214],
  ["xRatio", 0.7494, 0.1225],
  ["baseRatio", 0.8762, 0.07439],
  ["ascFrac", 0.0893, 0.1137],
  ["descFrac", 0.06103, 0.07216],
  ["markAboveFrac", 0.0635, 0.1548],
  ["markBelowFrac", 0.01013, 0.0535],
  ["density", 0.3878, 0.1013],
  ["ccPerT", 1.135, 0.393],
  ["groupsPerT", 0.9888, 0.3259],
  ["compsPerGroup", 1.23, 1.648],
  ["medGroupW", 0.9432, 1.003],
  ["q90GroupW", 1.701, 1.544],
  ["wideGroupFrac", 0.1457, 0.2147],
  ["medGap", 0.1331, 0.09964],
  ["bigGapFrac", 0.2397, 0.1544],
  ["medH", 0.7683, 0.1466],
  ["medW", 0.8071, 0.5438],
  ["tallFrac", 0.8631, 0.1751],
  ["wideFrac", 0.1557, 0.2163],
  ["squareBigPerT", 0.5393, 0.3215],
  ["smallFrac", 0.06424, 0.1002],
  ["smallAboveFrac", 0.04545, 0.06986],
  ["smallBelowFrac", 0.01879, 0.04651],
  ["holesPerT", 0.7962, 0.4471],
  ["peakiness", 1.693, 0.3052],
  ["peakPos", 0.4711, 0.2607],
  ["peakMass", 0.2368, 0.04146],
  ["topThird", 0.251, 0.07869],
  ["midThird", 0.4155, 0.05203],
  ["botThird", 0.3202, 0.06179],
  ["acPitch", 0.2026, 0.1063],
  ["acLag", 0.8145, 0.2261],
];
const HIDDEN_UNITS = 16;
const HIDDEN_WEIGHTS = [
  -115, 211, 79, 64, -287, -187, 62, 87, -10, -99, -103, -470, -30, -202, 167,
  -106, 215, 182, 115, 336, -86, 429, -156, 122, 256, -77, 101, 58, -101, 12,
  -80, 29, 319, -117, -243, -23, -113, -275, -56, -507, -99, 8, -394, -146, 259,
  -244, -85, -61, -330, 409, 187, 24, 596, 46, 77, -267, 487, -35, -302, -12,
  197, -148, -61, -132, -159, -131, 122, -35, -207, -133, -77, -59, 193, 27,
  115, 289, -80, -202, -255, -89, -110, -421, -302, -234, 217, 175, -25, 90, 11,
  178, -196, 57, -193, 33, 63, 173, -331, 141, -290, -158, 363, 22, -199, 526,
  -60, 77, -210, 109, -243, 162, 22, 584, -260, 130, -233, -137, 139, -69, 98,
  533, -55, 167, 141, 196, 218, 105, 2, -33, 38, -12, 137, 295, -107, -173, 12,
  -96, 89, 129, 195, -19, -628, 262, 70, 20, 361, -283, -207, -101, -40, -868,
  214, 63, -45, -361, 17, 134, 167, 261, 299, -184, 198, -146, 2, -320, -155,
  84, -313, -101, -194, -304, 92, -124, -6, -169, -349, -200, -133, -86, 69,
  -71, 38, 278, -35, -129, 195, 361, -198, 73, 98, 14, -430, -13, -42, 129, 14,
  41, -173, -521, -262, 133, 136, 72, 174, 82, 105, 135, 0, -117, 129, -261,
  101, 281, 17, 132, 108, 182, 197, -284, -275, -139, 37, -170, -271, -207,
  -117, 155, -75, -57, 228, 157, 160, -79, 31, 91, 337, 224, -13, -22, -28, -10,
  -355, -212, 35, 94, -126, 86, 103, -134, -218, 1418, 256, 240, -111, -22, 212,
  -39, 337, 239, -228, 139, 171, -442, 142, -405, -284, 241, -46, -270, -86,
  -43, 49, 71, -49, -163, 207, 28, -263, -400, -30, -14, -211, -341, 48, 73,
  304, 147, 114, 109, 52, 157, -7, 95, 222, 13, -279, 185, 194, 262, -156, 254,
  56, 29, -46, -152, -166, 224, -25, 80, -149, -48, -325, -200, -57, -49, -2,
  -242, -112, 235, 128, 16, -4, 46, 311, 86, 55, -236, 56, 160, -35, -16, -138,
  58, -78, 228, -481, -161, 126, -90, -143, 21, 356, 248, -94, -89, 202, -148,
  -104, 64, 166, -1224, -30, -30, 65, 190, -4, 25, 246, -99, -391, 233, 670,
  657, -644, 173, -19, 138, 174, 126, -44, -156, 492, -217, -68, 28, -48, -41,
  -43, -69, 12, -36, -104, -294, 377, 168, 253, -140, 154, -86, -281, 232, 438,
  -125, 167, -85, 55, 37, -95, 1, -73, 713, 123, -45, -80, -54, -74, 20, 1, -6,
  -142, 144, -72, -255, -93, -131, -121, -84, -159, 206, 336, 175, -106, 120,
  143, 213, 83, -130, 98, 37, -200, -180, -100, 34, -76, -110, -354, -192, -6,
  -48, -100, 46, 424, 43, -76, -141, 49, -103, 14, 120, 167, -1462, -84, 30, 53,
  9, 47, 60, -142, 36, 0, -219, -47, 113, -401, -604, 164, -201, 109, -84, -50,
  -75, 28, -136, 269, -164, 81, 89, 3, -50, -103, -7, -48, 97, -104, -241, 126,
  -94, 60, -61, -144, 90, 50, 24, 107, 89, -251, 132, 142, -435, -32, -1341,
  318, 91, -139, 151, -94, 84, -269, -437, -72, -172, -31, -58, -16, -20, -33,
  239, -7, -329, -342, 26, 21, -92, -111, -362, -167, -47, -58, 62, 264, 99,
  -71, -31, -170, 37, 131, 146, 524, 57, 143, -110, -228, -224, 148, -160, 45,
  -59, -14, -174, -172, 1175, -132, -143, -89, -296, -16, 35, 362, 37, -1, -119,
  -334, -191, 454, 307, 82, -92, -45, 53, -31, 377, -126, 85, 18, 33, 6, -11,
  -177, -197, -40, -42, 122, -2, 165, 91, 369, 268, 175, 56, 61, 30, -361, 727,
  15, 180, 58, -89, 103, -86, -52, 643, -2, -19, 65, -126, 108, 63, -142, -47,
  29, 34, -99, 148, 53, -70, 20, 46, 30, 5, 59, -126, -48, -37, -105, 72, -35,
  -1, 62, 120, 115, 38, -15, -151, 32, 60, -50, -15, -28, -46, -3, -93, 141,
  -186, 44, -131, 70, -236, 109, 207, 24, 1076, -26, -206, -197, 220, 197, 75,
  -206, 443, 148, 199, 9, 927, -167, -9, 177, 2, 46, -96, 156, -291, 201, -7,
  -12, -147, 23, 33, 95, 77, 187, -91, 7, 80, -20, 110, -114, -45, 18, -147,
  -20, -294, 209, -134, -124, 60, 10, -309, 242, 472, 8, 270, 36, 139, 42, -37,
  -358, -49, 175, 206, -448, 109, -90, -68, 122, 19, -4, 207, -124, 203, 70,
  -70, 35, -4, 199, -39, -138, -464, 82, 70, 171, -66, 138, 128, -16, -131,
  -170, -341, 206, 43, 106, -64, 111, 199, 109, -133, -9, -77, 55, 559, 217,
  -1102, 228, -105, 52, 6, -322, 201, -22, 375, 336, -201, -368, -1047, 191,
  -118, 75, -39, -331, 88, 180, 551, -65, 376, -12, 343, 171, -144, 100, 61,
  -146, -266, -19, -92, 11, -115, 2, -183, -74, 84, 38, 126, 705, 155, -268, 29,
  34, -14, -61, 53, 128, 32,
];
const OUTPUT_WEIGHTS = [
  908, -1036, 906, -860, 928, 1002, -1242, -1025, -863, -1154, -582, 1093, 61,
  -1061, -1242, 794, 121, -1079, 926, -1237, 955, 617, -918, -1, 1454, -428,
  701, 1291, -790, 516, 1003, 518, -1603, 501, 466, -485, -126, -678, -933,
  -504, 706, 80, 973, -264, -566, -823, 415, 575, 406, 665, -479, -134, 546,
  421, 557, -474, 390, 455, -505, 267, 726, -167, 482, -930, -435, 522, 266,
  -163,
];

const FEATURE_COUNT = FEATURES.length;

/**
 * @param {Array<number>} values
 * @returns {number} The median (the upper one for an even count), 0 if empty.
 */
function median(values) {
  return quantile(values, 0.5);
}

/**
 * @param {Array<number>} values
 * @param {number} q - In [0, 1].
 * @returns {number} The value at the given rank, 0 if empty.
 */
function quantile(values, q) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * Binarizes an RGBA image with Otsu's threshold on its luma (over white);
 * the ink is the minority class, so light text on a dark background works
 * too.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @returns {{ink: Uint8Array, inkCount: number}} 1 for ink pixels.
 */
function binarize({ data, width, height }) {
  const size = width * height;
  const gray = new Uint8Array(size);
  const histogram = new Float64Array(256);
  for (let i = 0, j = 0; i < size; i++, j += 4) {
    const luma = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    // Transparent pixels (outside the page) are white.
    const value = 255 - Math.trunc(((255 - luma) * data[j + 3]) / 255);
    gray[i] = value;
    histogram[value]++;
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    sum += i * histogram[i];
  }
  let sumBelow = 0,
    countBelow = 0,
    bestVariance = 0,
    threshold = 128;
  for (let t = 0; t < 256; t++) {
    countBelow += histogram[t];
    if (countBelow === 0) {
      continue;
    }
    const countAbove = size - countBelow;
    if (countAbove === 0) {
      break;
    }
    sumBelow += t * histogram[t];
    const meanBelow = sumBelow / countBelow,
      meanAbove = (sum - sumBelow) / countAbove;
    const variance = countBelow * countAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = t;
    }
  }

  const ink = new Uint8Array(size);
  let inkCount = 0;
  for (let i = 0; i < size; i++) {
    if (gray[i] <= threshold) {
      ink[i] = 1;
      inkCount++;
    }
  }
  if (inkCount > size / 2) {
    for (let i = 0; i < size; i++) {
      ink[i] ^= 1;
    }
    inkCount = size - inkCount;
  }
  return { ink, inkCount };
}

/**
 * @typedef {object} Component - An 8-connected component of ink pixels.
 * @property {number} id - Its label in the label image.
 * @property {number} x0 - Its bounding box, inclusive.
 * @property {number} x1
 * @property {number} y0
 * @property {number} y1
 * @property {number} w - Its bounding box size.
 * @property {number} h
 * @property {number} area - Its number of pixels.
 * @property {number} cy - The mean y of its pixels.
 */

/**
 * Labels the 8-connected components of the ink.
 * @param {Uint8Array} ink
 * @param {number} width
 * @param {number} height
 * @returns {{components: Array<Component>, labels: Int32Array}} The
 *   components in the raster order of their first pixel, and the label of
 *   each pixel (-1 for the background).
 */
function labelComponents(ink, width, height) {
  const labels = new Int32Array(width * height).fill(-1);
  const components = [];
  const stack = [];
  for (let i = 0; i < width * height; i++) {
    if (!ink[i] || labels[i] >= 0) {
      continue;
    }
    const c = { id: components.length, x0: width, x1: -1, y0: height, y1: -1 };
    let area = 0,
      sumY = 0;
    labels[i] = c.id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      const x = p % width,
        y = (p - x) / width;
      area++;
      sumY += y;
      c.x0 = Math.min(c.x0, x);
      c.x1 = Math.max(c.x1, x);
      c.y0 = Math.min(c.y0, y);
      c.y1 = Math.max(c.y1, y);
      const xMin = Math.max(0, x - 1),
        xMax = Math.min(width - 1, x + 1),
        yMin = Math.max(0, y - 1),
        yMax = Math.min(height - 1, y + 1);
      for (let yy = yMin; yy <= yMax; yy++) {
        for (let xx = xMin; xx <= xMax; xx++) {
          const q = yy * width + xx;
          if (ink[q] && labels[q] < 0) {
            labels[q] = c.id;
            stack.push(q);
          }
        }
      }
    }
    c.w = c.x1 - c.x0 + 1;
    c.h = c.y1 - c.y0 + 1;
    c.area = area;
    c.cy = sumY / area;
    components.push(c);
  }
  return { components, labels };
}

/**
 * Counts the holes of a component: the 4-connected background regions of its
 * bounding box (with a 1-pixel margin) that don't touch the box border, and
 * have at least 2 pixels.
 * @param {Component} c
 * @param {Int32Array} labels
 * @param {number} width - The image width.
 * @returns {number}
 */
function countHoles(c, labels, width) {
  const boxWidth = c.w + 2,
    boxHeight = c.h + 2;
  const filled = new Uint8Array(boxWidth * boxHeight);
  for (let y = c.y0; y <= c.y1; y++) {
    for (let x = c.x0; x <= c.x1; x++) {
      if (labels[y * width + x] === c.id) {
        filled[(y - c.y0 + 1) * boxWidth + (x - c.x0 + 1)] = 1;
      }
    }
  }
  let holes = 0;
  const stack = [];
  for (let i = 0; i < filled.length; i++) {
    if (filled[i]) {
      continue;
    }
    let area = 0,
      touchesBorder = false;
    filled[i] = 1;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      area++;
      const x = p % boxWidth,
        y = (p - x) / boxWidth;
      if (x === 0 || y === 0 || x === boxWidth - 1 || y === boxHeight - 1) {
        touchesBorder = true;
      }
      // The 4 neighbors, without wrapping around the rows.
      for (const q of [p - 1, p + 1, p - boxWidth, p + boxWidth]) {
        if (q >= 0 && q < filled.length && !filled[q]) {
          if (Math.abs((q % boxWidth) - x) <= 1) {
            filled[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (!touchesBorder && area >= 2) {
      holes++;
    }
  }
  return holes;
}

/**
 * Computes the features of a line crop.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @returns {{features: object, length: number} | null} The features, by name,
 *   and the length of the line in text heights; null if the image has no ink.
 */
function computeFeatures(image) {
  const { width: w, height: h } = image;
  const { ink, inkCount } = binarize(image);

  // The text band: between the 1st and the 99th percentiles of the ink rows.
  const rowInk = new Float64Array(h);
  const columnInk = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ink[y * w + x]) {
        rowInk[y]++;
        columnInk[x]++;
      }
    }
  }
  let cumulated = 0,
    top = 0,
    bottom = h - 1;
  for (let y = 0; y < h; y++) {
    cumulated += rowInk[y];
    if (cumulated < 0.01 * inkCount) {
      top = y + 1;
    }
    if (cumulated <= 0.99 * inkCount) {
      bottom = y + 1;
    }
  }
  bottom = Math.min(h - 1, bottom);
  // The text height, the unit of most features.
  const T = Math.max(4, bottom - top + 1);

  // The components, without the specks.
  const { components: all, labels } = labelComponents(ink, w, h);
  const minArea = Math.max(2, 0.0015 * T * T);
  const comps = all.filter(c => c.area >= minArea);
  if (comps.length === 0) {
    return null;
  }
  let left = w,
    right = 0;
  for (const c of comps) {
    left = Math.min(left, c.x0);
    right = Math.max(right, c.x1);
  }
  const inkWidth = right - left + 1;
  const length = Math.max(1, inkWidth / T);
  const f = Object.create(null);

  // Horizontal projection profile within the text band: the baseline stroke
  // of Arabic and the headline of Devanagari make a sharp peak, Latin has an
  // x-height band, CJK is flat.
  const band = Array.from(rowInk.slice(top, bottom + 1));
  const bandMean = band.reduce((a, b) => a + b, 0) / band.length;
  let peakRow = 0;
  for (let i = 0; i < band.length; i++) {
    if (band[i] > band[peakRow]) {
      peakRow = i;
    }
  }
  f.peakiness = band[peakRow] / (bandMean || 1);
  f.peakPos = peakRow / band.length;
  const radius = Math.max(1, Math.round(0.06 * T));
  let nearPeak = 0;
  for (let i = peakRow - radius; i <= peakRow + radius; i++) {
    if (i >= 0 && i < band.length) {
      nearPeak += band[i];
    }
  }
  f.peakMass = nearPeak / (inkCount || 1);
  const third = i => {
    let sum = 0;
    const end = Math.floor(((i + 1) * band.length) / 3);
    for (let k = Math.floor((i * band.length) / 3); k < end; k++) {
      sum += band[k];
    }
    return sum / (inkCount || 1);
  };
  f.topThird = third(0);
  f.midThird = third(1);
  f.botThird = third(2);

  // Component sizes, relative to the text height.
  const small = comps.filter(c => c.h < 0.25 * T && c.w < 0.25 * T);
  const middle = top + T / 2;
  f.density = inkCount / (inkWidth * T);
  f.ccPerT = comps.length / length;
  f.medH = median(comps.map(c => c.h / T));
  f.medW = median(comps.map(c => c.w / T));
  f.tallFrac = comps.filter(c => c.h >= 0.6 * T).length / comps.length;
  f.wideFrac = comps.filter(c => c.w >= 1.2 * T).length / comps.length;
  f.squareBigPerT =
    comps.filter(c => c.h >= 0.6 * T && c.w >= 0.6 * T && c.w <= 1.3 * T)
      .length / length;
  f.smallFrac = small.length / comps.length;
  f.smallAboveFrac = small.filter(c => c.cy < middle).length / comps.length;
  f.smallBelowFrac = small.filter(c => c.cy >= middle).length / comps.length;
  let holes = 0;
  for (const c of comps) {
    if (c.h >= 0.2 * T) {
      holes += countHoles(c, labels, w);
    }
  }
  f.holesPerT = holes / length;

  // Column groups (components overlapping horizontally, e.g. CJK glyphs or
  // letters with their marks) and the gaps between them.
  const groups = [];
  for (const c of comps.toSorted((a, b) => a.x0 - b.x0)) {
    const group = groups.at(-1);
    if (group && c.x0 <= group.x1) {
      group.x1 = Math.max(group.x1, c.x1);
    } else {
      groups.push({ x0: c.x0, x1: c.x1 });
    }
  }
  const groupWidths = groups.map(g => (g.x1 - g.x0 + 1) / T);
  const gaps = [];
  for (let i = 1; i < groups.length; i++) {
    gaps.push((groups[i].x0 - groups[i - 1].x1 - 1) / T);
  }
  f.groupsPerT = groups.length / length;
  f.compsPerGroup = comps.length / groups.length;
  f.medGroupW = median(groupWidths);
  f.q90GroupW = quantile(groupWidths, 0.9);
  f.wideGroupFrac = groupWidths.filter(v => v >= 1.5).length / groups.length;
  f.medGap = median(gaps);
  f.bigGapFrac = gaps.filter(v => v > 0.25).length / (gaps.length || 1);

  // Pitch regularity (CJK glyphs are on a grid): the best autocorrelation of
  // the vertical projection profile, at lags between 0.5 and 1.3 T.
  const columns = columnInk.slice(left, right + 1);
  const columnMean = columns.reduce((a, b) => a + b, 0) / columns.length;
  let variance = 0;
  for (const v of columns) {
    variance += (v - columnMean) ** 2;
  }
  f.acPitch = 0;
  f.acLag = 0;
  for (let lag = Math.round(0.5 * T); lag <= Math.round(1.3 * T); lag++) {
    let sum = 0;
    for (let i = 0; i + lag < columns.length; i++) {
      sum += (columns[i] - columnMean) * (columns[i + lag] - columnMean);
    }
    const correlation = sum / (variance || 1);
    if (correlation > f.acPitch) {
      f.acPitch = correlation;
      f.acLag = lag / T;
    }
  }

  // Zones: the baseline and the x-line are the median bottom and top of the
  // letter-sized components; letters may have an ascender or a descender,
  // and small marks are above or below.
  const letters = comps.filter(c => c.h >= 0.25 * T);
  const baseline = median(letters.map(c => c.y1));
  const xLine = median(letters.map(c => c.y0));
  const xHeight = Math.max(2, baseline - xLine);
  const isAscender = c => c.y0 < xLine - 0.3 * xHeight;
  const isDescender = c => c.y1 > baseline + 0.3 * xHeight;
  const letterCount = letters.length || 1;
  let ascenders = 0,
    descenders = 0,
    marksAbove = 0,
    marksBelow = 0;
  for (const c of comps) {
    if (c.h >= 0.25 * T) {
      ascenders += isAscender(c) ? 1 : 0;
      descenders += isDescender(c) ? 1 : 0;
    } else if (c.y1 < xLine + 0.15 * xHeight) {
      marksAbove++;
    } else if (c.y0 > baseline - 0.15 * xHeight) {
      marksBelow++;
    }
  }
  f.xRatio = xHeight / T;
  f.baseRatio = (baseline - top) / T;
  f.ascFrac = ascenders / letterCount;
  f.descFrac = descenders / letterCount;
  f.markAboveFrac = marksAbove / letterCount;
  f.markBelowFrac = marksBelow / letterCount;
  f.lettersPerXh = letters.length / Math.max(1, inkWidth / xHeight);

  // The shapes of the x-height letters (no ascender or descender), mostly for
  // Latin vs Cyrillic: Cyrillic lowercase is wider and boxier (н п и ш т к м
  // л), with flat tops and full-height stems.
  const xLetters = letters.filter(
    c => !isAscender(c) && !isDescender(c) && c.h >= 0.5 * xHeight
  );
  const xCount = xLetters.length || 1;
  let symmetry = 0,
    stems = 0,
    twoStems = 0,
    topFill = 0,
    bottomFill = 0,
    flatTops = 0,
    withHoles = 0;
  for (const c of xLetters) {
    const edge = Math.max(1, Math.round(0.15 * c.h));
    let topColumns = 0,
      bottomColumns = 0,
      stemCount = 0,
      inStem = false,
      mirrored = 0,
      pixels = 0;
    for (let x = c.x0; x <= c.x1; x++) {
      const mirrorX = c.x1 - (x - c.x0);
      let run = 0,
        longestRun = 0,
        hasTop = false,
        hasBottom = false;
      for (let y = c.y0; y <= c.y1; y++) {
        if (labels[y * w + x] !== c.id) {
          run = 0;
          continue;
        }
        longestRun = Math.max(longestRun, ++run);
        hasTop ||= y < c.y0 + edge;
        hasBottom ||= y > c.y1 - edge;
        pixels++;
        if (labels[y * w + mirrorX] === c.id) {
          mirrored++;
        }
      }
      topColumns += hasTop ? 1 : 0;
      bottomColumns += hasBottom ? 1 : 0;
      const isStem = longestRun >= 0.8 * c.h;
      if (isStem && !inStem) {
        stemCount++;
      }
      inStem = isStem;
    }
    symmetry += pixels ? mirrored / pixels : 0;
    stems += stemCount;
    twoStems += stemCount >= 2 ? 1 : 0;
    topFill += topColumns / c.w;
    bottomFill += bottomColumns / c.w;
    flatTops += topColumns / c.w > 0.7 ? 1 : 0;
    withHoles += countHoles(c, labels, w) > 0 ? 1 : 0;
  }
  const xWidths = xLetters.map(c => c.w / xHeight);
  f.xOnlyFrac = xLetters.length / letterCount;
  f.medWx = median(xWidths);
  f.wideXFrac = xWidths.filter(v => v > 1.1).length / xCount;
  f.narrowXFrac = xWidths.filter(v => v < 0.45).length / xCount;
  f.symX = symmetry / xCount;
  f.stemsX = stems / xCount;
  f.twoStemFrac = twoStems / xCount;
  f.topFillX = topFill / xCount;
  f.botFillX = bottomFill / xCount;
  f.flatTopFrac = flatTops / xCount;
  f.holeXFrac = withHoles / xCount;

  // i/j dots: small marks above a narrow x-height letter, centered on it.
  let dots = 0;
  for (const c of comps) {
    if (
      c.h >= 0.25 * T ||
      c.y1 >= xLine + 0.15 * xHeight ||
      c.w > 0.4 * xHeight ||
      c.h > 0.4 * xHeight
    ) {
      continue;
    }
    const center = (c.x0 + c.x1) / 2;
    if (
      xLetters.some(
        l =>
          l.w < 0.75 * xHeight &&
          Math.abs(center - (l.x0 + l.x1) / 2) < 0.25 * xHeight
      )
    ) {
      dots++;
    }
  }
  f.dotFrac = dots / letterCount;

  // Ascenders and descenders within words: a tall letter between two
  // x-height letters ("able", "old"), so that capitals, digits and acronyms
  // don't count; Cyrillic lowercase has almost no ascenders (only б). Narrow
  // ascenders are l t f I 1, frequent in Latin text.
  const sequence = letters
    .map(c => ({
      c,
      ascender: isAscender(c),
      descender: isDescender(c),
      xOnly: !isAscender(c) && !isDescender(c) && c.h >= 0.5 * xHeight,
    }))
    .sort((a, b) => a.c.x0 - b.c.x0);
  const maxLetterGap = 0.3 * xHeight;
  let midAscenders = 0,
    midDescenders = 0,
    initialAscenders = 0,
    narrowAscenders = 0;
  for (let i = 0; i < sequence.length; i++) {
    const { c, ascender, descender } = sequence[i];
    const previous = sequence[i - 1],
      next = sequence[i + 1];
    const joinedPrevious = previous && c.x0 - previous.c.x1 <= maxLetterGap;
    const joinedNext = next && next.c.x0 - c.x1 <= maxLetterGap;
    const inWord = joinedPrevious && joinedNext && previous.xOnly && next.xOnly;
    if (ascender && !descender) {
      narrowAscenders += c.w < 0.55 * xHeight ? 1 : 0;
      midAscenders += inWord ? 1 : 0;
      initialAscenders += !joinedPrevious && joinedNext && next.xOnly ? 1 : 0;
    }
    if (descender && !ascender && inWord) {
      midDescenders++;
    }
  }
  f.narrowAscFrac = narrowAscenders / letterCount;
  f.midAscFrac = midAscenders / letterCount;
  f.midDescFrac = midDescenders / letterCount;
  f.initialAscFrac = initialAscenders / letterCount;

  return { features: f, length };
}

/**
 * Runs the classifier.
 * @param {object} features - The feature values, by name.
 * @returns {Array<number>} The probability of each script, in `SCRIPTS`
 *   order.
 */
function runModel(features) {
  const input = FEATURES.map(([name, mean, std]) => {
    const value = features[name];
    return ((Number.isFinite(value) ? value : 0) - mean) / std;
  });
  const hidden = new Array(HIDDEN_UNITS);
  for (let j = 0, row = 0; j < HIDDEN_UNITS; j++, row += FEATURE_COUNT + 1) {
    let sum = HIDDEN_WEIGHTS[row + FEATURE_COUNT];
    for (let i = 0; i < FEATURE_COUNT; i++) {
      sum += HIDDEN_WEIGHTS[row + i] * input[i];
    }
    hidden[j] = Math.tanh(sum / 1000);
  }
  const logits = SCRIPTS.map((_, k) => {
    const row = k * (HIDDEN_UNITS + 1);
    let sum = OUTPUT_WEIGHTS[row + HIDDEN_UNITS];
    for (let j = 0; j < HIDDEN_UNITS; j++) {
      sum += OUTPUT_WEIGHTS[row + j] * hidden[j];
    }
    return sum / 1000;
  });
  const max = Math.max(...logits);
  const exps = logits.map(v => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map(v => v / total);
}

/**
 * Classifies the script of one text line.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image -
 *   The straightened line crop, RGBA, 48 px high: the image the OCR worker
 *   feeds to the recognizer (before normalization and right-padding).
 * @returns {LineScript} `script` is null when the line is too short or has
 *   no ink; `confidence` is its probability; `weight` is its vote, its length
 *   in text heights up to `MAX_LINE_WEIGHT` (0 if `script` is null).
 */
function classifyLineScript(image) {
  const result = image.width > 0 && image.height > 0 && computeFeatures(image);
  if (!result || result.length < MIN_LINE_LENGTH) {
    return { script: null, confidence: 0, weight: 0 };
  }
  const probabilities = runModel(result.features);
  let best = 0;
  for (let k = 1; k < SCRIPTS.length; k++) {
    if (probabilities[k] > probabilities[best]) {
      best = k;
    }
  }
  return {
    script: SCRIPTS[best],
    confidence: probabilities[best],
    weight: Math.min(result.length, MAX_LINE_WEIGHT),
  };
}

/**
 * Picks the lines to classify first: the longest ones. When the page turns
 * out to be mixed (see `decidePageScripts`), the other lines are classified
 * too.
 * @param {Array<number>} widths - The widths of the line crops.
 * @param {number} [count]
 * @returns {Array<number>} Line indices, longest first.
 */
function pickSampleLines(widths, count = SAMPLE_LINES) {
  return widths
    .map((width, index) => ({ width, index }))
    .sort((a, b) => b.width - a.width)
    .slice(0, count)
    .map(({ index }) => index);
}

/**
 * @typedef {object} LineScript - The result of `classifyLineScript`.
 * @property {string|null} script
 * @property {number} confidence
 * @property {number} weight
 */

/**
 * @typedef {object} PageScripts - The result of `decidePageScripts`.
 * @property {string|null} main - The main script. It's null (and `scripts`
 *   is empty) only when there are no lines; with no usable line, it's the
 *   prior or Latin.
 * @property {object} shares - The share of the votes of each script.
 * @property {Array<string>} scripts - The scripts whose recognizer must be
 *   loaded, main first, with Latin folded into Cyrillic.
 * @property {boolean} mixed - Whether the main script doesn't have a clear
 *   majority: if some lines aren't classified yet, classify them and decide
 *   again.
 */

/**
 * @param {LineScript|null} result
 * @returns {boolean} Whether the line votes.
 */
function isConfident(result) {
  return !!result?.script && result.confidence >= MIN_CONFIDENCE;
}

/**
 * Decides which scripts a page needs from its classified lines.
 * @param {Array<LineScript|null>} results - Per line, null for the lines not
 *   classified (yet).
 * @param {string|null} [prior] - A tie-breaker (e.g. the script of the
 *   previous page), only used when the evidence is weak.
 * @returns {PageScripts}
 */
function decidePageScripts(results, prior = null) {
  const votes = new Map(SCRIPTS.map(script => [script, 0]));
  const lineCounts = new Map(SCRIPTS.map(script => [script, 0]));
  let total = 0;
  for (const result of results) {
    if (isConfident(result)) {
      votes.set(result.script, votes.get(result.script) + result.weight);
      lineCounts.set(result.script, lineCounts.get(result.script) + 1);
      total += result.weight;
    }
  }
  if (total < WEAK_EVIDENCE && SCRIPTS.includes(prior)) {
    votes.set(prior, votes.get(prior) + PRIOR_WEIGHT);
    total += PRIOR_WEIGHT;
  }

  const shares = Object.create(null);
  let main = null;
  for (const [script, vote] of votes) {
    shares[script] = total > 0 ? vote / total : 0;
    if (vote > 0 && (!main || vote > votes.get(main))) {
      main = script;
    }
  }
  if (!main) {
    // No usable line: use the prior, or Latin, the most common script.
    if (results.length === 0) {
      return { main: null, shares, scripts: [], mixed: false };
    }
    main = SCRIPTS.includes(prior) ? prior : "latin";
    return { main, shares, scripts: [main], mixed: true };
  }

  const mixed = shares[main] < SINGLE_SCRIPT_SHARE;
  const scripts = [main];
  if (mixed) {
    for (const script of SCRIPTS) {
      if (
        script !== main &&
        shares[script] >= MIN_EXTRA_SHARE &&
        lineCounts.get(script) >= MIN_EXTRA_LINES
      ) {
        scripts.push(script);
      }
    }
  }
  // The Cyrillic recognizer also reads the Latin lines.
  if (scripts.includes("cyrillic") && scripts.includes("latin")) {
    scripts.splice(scripts.indexOf("latin"), 1);
  }
  if (main === "latin" && scripts.includes("cyrillic")) {
    main = "cyrillic";
    scripts.splice(scripts.indexOf("cyrillic"), 1);
    scripts.unshift("cyrillic");
  }
  return { main, shares, scripts, mixed };
}

/**
 * Chooses the recognizer script of each line: its own script if it's
 * confident and loaded (Latin lines go to Cyrillic when Latin is folded into
 * it), otherwise the main script.
 * @param {Array<LineScript|null>} results - Per line, as for
 *   `decidePageScripts`.
 * @param {PageScripts} decision - The result of `decidePageScripts`.
 * @returns {Array<string>} Per line, one of `decision.scripts`.
 */
function routeLines(results, { main, scripts }) {
  return results.map(result => {
    if (!isConfident(result)) {
      return main;
    }
    let { script } = result;
    if (script === "latin" && !scripts.includes("latin")) {
      script = "cyrillic";
    }
    return scripts.includes(script) ? script : main;
  });
}

export {
  classifyLineScript,
  decidePageScripts,
  pickSampleLines,
  routeLines,
  SCRIPTS,
};
