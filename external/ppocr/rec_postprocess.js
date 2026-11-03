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

// Pre- and post-processing for the PaddleOCR text recognition models,
// following PaddleOCR's `tools/infer/predict_rec.py`, and parsing of the
// models' `inference.yml` (pure functions, no DOM).

/** @typedef {[number, number]} Point */
/** @typedef {[Point, Point, Point, Point]} Quad - TL, TR, BR, BL. */

// The model downsamples the width by 8 (one CTC time step per 8 pixels), so
// the batch width is rounded up to a multiple of 8.
const WIDTH_ALIGNMENT = 8;

// Lines at least this many times taller than wide are read top to bottom.
const VERTICAL_RATIO = 1.5;

// Letters of right-to-left scripts.
const RTL_LETTER = String.raw`[\p{L}&&[\p{scx=Arab}\p{scx=Hebr}]]`;

// Text whose first letter is from a right-to-left script.
const RTL_TEXT = new RegExp(String.raw`^\P{L}*${RTL_LETTER}`, "v");

// The same, for text in visual order: the first letter is the rightmost one.
const RTL_VISUAL_TEXT = new RegExp(String.raw`${RTL_LETTER}\P{L}*$`, "v");

// Characters written left to right in right-to-left text: the letters of the
// other scripts, and digits.
const LTR_LETTER = String.raw`[\p{L}--${RTL_LETTER}]`;
const LTR_CHAR = String.raw`[\p{Nd}${LTR_LETTER}]`;

// A left-to-right word or number, e.g. "OCR", "3.14" or "2026-10-13".
const LTR_WORD = String.raw`${LTR_CHAR}+(?:[.,:\/+\-\u066B\u066C]${LTR_CHAR}+)*`;

// The left-to-right runs of right-to-left text: words, also joined by spaces
// and punctuation after a letter, as by the Unicode Bidirectional Algorithm
// (roughly: rules W4, W7 and N1).
const LTR_RUN = new RegExp(
  String.raw`${LTR_WORD}(?:(?<=${LTR_LETTER})[\p{Zs}\p{Po}\p{Pd}]+${LTR_WORD})*`,
  "gv"
);

// Characters that are displayed mirrored in right-to-left text.
const MIRRORED = new Map([
  ["(", ")"],
  [")", "("],
  ["[", "]"],
  ["]", "["],
  ["{", "}"],
  ["}", "{"],
  ["<", ">"],
  [">", "<"],
  ["\u00AB", "\u00BB"],
  ["\u00BB", "\u00AB"],
]);

// Escape sequences of YAML double-quoted strings, besides \x, \u and \U.
const YAML_ESCAPES = new Map([
  ["0", "\0"],
  ["a", "\x07"],
  ["b", "\b"],
  ["t", "\t"],
  ["\t", "\t"],
  ["n", "\n"],
  ["v", "\v"],
  ["f", "\f"],
  ["r", "\r"],
  ["e", "\x1b"],
  [" ", " "],
  ['"', '"'],
  ["/", "/"],
  ["\\", "\\"],
  ["N", "\x85"],
  ["_", "\xa0"],
  ["L", "\u2028"],
  ["P", "\u2029"],
]);

/**
 * Parses a YAML scalar as written by PyYAML:
 * plain, 'single-quoted' or "double-quoted".
 * @param {string} rawText - The scalar, possibly surrounded by whitespace.
 * @returns {string}
 */
function parseYAMLScalar(rawText) {
  // Only spaces and tabs are whitespace in YAML (e.g. U+3000 is a character
  // of the dictionaries), and around a scalar they are never part of it.
  const text = rawText.replace(/^[ \t]+/, "").replace(/(?<![ \t])[ \t]+$/, "");
  if (text.startsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.startsWith('"')) {
    return text
      .slice(1, -1)
      .replaceAll(
        /\\(x[\dA-Fa-f]{2}|u[\dA-Fa-f]{4}|U[\dA-Fa-f]{8}|.)/g,
        (match, escape) =>
          escape.length > 1
            ? String.fromCodePoint(parseInt(escape.slice(1), 16))
            : (YAML_ESCAPES.get(escape) ?? match)
      );
  }
  return text;
}

/**
 * Extracts the `PostProcess` section of a PaddleOCR `inference.yml` (as
 * written by PyYAML): its scalars and lists of scalars.
 * @param {string} yml - The content of `inference.yml`.
 * @returns {Map<string, string|Array<string>>} The values by key (scalars are
 *   returned as strings).
 */
function parsePostProcessConfig(yml) {
  const config = new Map();
  let section = null,
    list = null;
  for (const line of yml.split(/\r?\n/)) {
    if (!/^[ \t]/.test(line)) {
      // A top-level key.
      section = line;
      continue;
    }
    if (section !== "PostProcess:") {
      continue;
    }
    const item = /^[ \t]*- (.*)$/.exec(line);
    if (item) {
      list?.push(parseYAMLScalar(item[1]));
      continue;
    }
    const entry = /^[ \t]+(\w+):(.*)$/.exec(line);
    if (entry) {
      const [, key, value] = entry;
      // A key without a value starts a list.
      list = /[^ \t]/.test(value) ? null : [];
      config.set(key, list ?? parseYAMLScalar(value));
    }
  }
  return config;
}

/**
 * Extracts the character table of a recognition model from its
 * `inference.yml`, i.e. the `PostProcess.character_dict` list.
 * @param {string} yml - The content of `inference.yml`.
 * @returns {Array<string>} The characters indexed by model class: the CTC
 *   blank (class 0), the dictionary, then a space.
 */
function parseCharacterDict(yml) {
  const dict = parsePostProcessConfig(yml).get("character_dict");
  if (!Array.isArray(dict)) {
    throw new Error("No `PostProcess.character_dict` in the model config.");
  }
  return ["blank", ...dict, " "];
}

/**
 * Computes the width / height ratio of a box.
 * @param {Quad} quad
 * @returns {number}
 */
function getQuadRatio([tl, tr, , bl]) {
  const width = Math.max(Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), 1);
  const height = Math.max(Math.hypot(bl[0] - tl[0], bl[1] - tl[1]), 1);
  return width / height;
}

/**
 * Orients a detected box like its text (PaddleOCR `get_rotate_crop_image`):
 * boxes that are much taller than wide hold text rotated by 90° clockwise,
 * so their corners are rotated such that the first one is the top-left
 * corner of the upright text.
 * @param {Quad} quad - The detected box: TL, TR, BR, BL in image axes.
 * @returns {Quad} The top-left, top-right, bottom-right and bottom-left
 *   corners of the upright text.
 */
function orientQuad(quad) {
  return getQuadRatio(quad) <= 1 / VERTICAL_RATIO
    ? [quad[1], quad[2], quad[3], quad[0]]
    : quad;
}

/**
 * Computes the input width of a recognition batch (PaddleOCR
 * `resize_norm_img`): wide enough for its widest line, and at least
 * `baseWidth`.
 * @param {Array<number>} widths - The widths of the line images.
 * @param {number} baseWidth - The minimum input width.
 * @returns {number}
 */
function getRecBatchWidth(widths, baseWidth) {
  const width = Math.max(baseWidth, ...widths);
  return Math.ceil(width / WIDTH_ALIGNMENT) * WIDTH_ALIGNMENT;
}

/**
 * Builds the `[N, 3, height, width]` input tensor of the recognition model:
 * B, G, R planes with values normalized to [-1, 1], each line left-aligned
 * and right-padded with zeros.
 * @param {Array<ImageData>} lines - The line images, all `height` pixels high
 *   and at most `width` pixels wide.
 * @param {number} height
 * @param {number} width
 * @returns {Float32Array}
 */
function prepareRecBatch(lines, height, width) {
  const planeSize = height * width;
  const data = new Float32Array(lines.length * 3 * planeSize);
  for (const [n, { data: rgba, width: lineWidth }] of lines.entries()) {
    const columns = Math.min(lineWidth, width);
    for (let y = 0; y < height; y++) {
      let dst = n * 3 * planeSize + y * width;
      let src = 4 * y * lineWidth;
      for (let x = 0; x < columns; x++, dst++, src += 4) {
        // (v / 255 - 0.5) / 0.5
        data[dst] = rgba[src + 2] / 127.5 - 1;
        data[dst + planeSize] = rgba[src + 1] / 127.5 - 1;
        data[dst + 2 * planeSize] = rgba[src] / 127.5 - 1;
      }
    }
  }
  return data;
}

/**
 * Greedy CTC decoding of the recognition output (already softmaxed): the
 * most likely class of each time step, without repeats and blanks.
 * @param {Float32Array} data - The `[N, T, C]` class probabilities.
 * @param {Array<number>} dims - `[N, T, C]`.
 * @param {Array<string>} chars - The character table, see
 *   {@link parseCharacterDict}.
 * @returns {Array<{text: string, score: number}>} For each line, its text
 *   and the mean probability of its characters (0 if empty).
 */
function ctcDecode(data, [count, steps, classes], chars) {
  const results = [];
  for (let n = 0; n < count; n++) {
    let text = "",
      scoreSum = 0,
      length = 0,
      previous = 0;
    for (let t = 0; t < steps; t++) {
      const offset = (n * steps + t) * classes;
      let best = 0;
      for (let c = 1; c < classes; c++) {
        if (data[offset + c] > data[offset + best]) {
          best = c;
        }
      }
      if (best !== 0 && best !== previous) {
        text += chars[best];
        scoreSum += data[offset + best];
        length++;
      }
      previous = best;
    }
    results.push({ text, score: length > 0 ? scoreSum / length : 0 });
  }
  return results;
}

/**
 * Converts the text of a line from visual order, in which the recognition
 * models read it (left to right), to logical order. Right-to-left lines (whose
 * rightmost letter is from a right-to-left script) are reversed, except for
 * their left-to-right runs (e.g. Latin words and numbers), and their brackets
 * are mirrored; other lines are returned as is. PaddleOCR does the same for
 * Arabic in `BaseRecLabelDecode.pred_reverse`
 * (`ppocr/postprocess/rec_postprocess.py`), but for all the lines, and it also
 * reverses Arabic-Indic numbers, and doesn't mirror brackets.
 * @param {string} text
 * @returns {string}
 */
function toLogicalOrder(text) {
  if (!RTL_VISUAL_TEXT.test(text)) {
    return text;
  }
  const units = [];
  let end = 0;
  for (const run of text.matchAll(LTR_RUN)) {
    units.push(...text.slice(end, run.index), run[0]);
    end = run.index + run[0].length;
  }
  units.push(...text.slice(end));
  return units
    .reverse()
    .map(unit => MIRRORED.get(unit) ?? unit)
    .join("");
}

/**
 * Gets the base direction of a line of text, from its first letter.
 * @param {string} text
 * @returns {string} "rtl" if the first letter is from a right-to-left script
 *   (Arabic, Hebrew), otherwise "ltr".
 */
function getTextDirection(text) {
  return RTL_TEXT.test(text) ? "rtl" : "ltr";
}

export {
  ctcDecode,
  getQuadRatio,
  getRecBatchWidth,
  getTextDirection,
  orientQuad,
  parseCharacterDict,
  parsePostProcessConfig,
  prepareRecBatch,
  toLogicalOrder,
};
