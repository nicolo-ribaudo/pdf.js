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

// The OCR models: the PaddleOCR PP-OCRv5 mobile text detection model, shared
// by its text recognition models, one per script. They are vendored in
// this directory (see its README). Each model's `inference.yml` contains
// its post-processing parameters, and the character dictionary for the
// recognition models.

/**
 * @typedef {object} OCRDetModel - A text detection (DB) model.
 * @property {URL} url - The ONNX model.
 * @property {URL} configUrl - Its `inference.yml`.
 * @property {number} maxSideLen - The page is downscaled so that its longest
 *   side is at most this many pixels (PaddleOCR's `DetResizeForTest`).
 */

/**
 * @typedef {object} OCRRecModel - A text recognition (SVTR + CTC) model.
 * @property {URL} url - The ONNX model.
 * @property {URL} configUrl - Its `inference.yml`.
 * @property {number} baseWidth - The minimum width of a batch.
 * @property {{webgpu: number, wasm: number}} batchSize - The number of lines
 *   recognized per inference run, by backend.
 * @property {boolean} [rightToLeft] - Whether the model reads right-to-left
 *   scripts, whose characters it outputs in visual (left-to-right) order.
 */

/**
 * @typedef {object} OCRModel
 * @property {string} name - The name shown in the UI.
 * @property {string} languages - The main languages it reads, for the UI.
 * @property {OCRRecModel} rec
 */

/**
 * @param {string} dir - A model directory, next to this file.
 * @returns {{url: URL, configUrl: URL}} The model and its config.
 */
function getModelFiles(dir) {
  return {
    url: new URL(`./${dir}/inference.onnx`, import.meta.url),
    configUrl: new URL(`./${dir}/inference.yml`, import.meta.url),
  };
}

/**
 * The text detection model, used with all the recognition models.
 * @type {OCRDetModel}
 */
const DETECTION_MODEL = {
  ...getModelFiles("PP-OCRv5_mobile_det"),
  // Higher values don't find more text on a 200-DPI scan, and are slower;
  // keep it <= 2048 (onnxruntime#29130 with WebGPU).
  maxSideLen: 1280,
};

/** The height of the line images read by all the recognition models. */
const REC_IMAGE_HEIGHT = 48;

// The lines of a batch are padded to the same width: on WASM that costs more
// than batching saves; on WebGPU, larger batches are faster in Firefox but
// slower in Chrome.
const REC_SETTINGS = {
  baseWidth: 320,
  batchSize: { webgpu: 4, wasm: 1 },
};

/** @type {Map<string, OCRModel>} The recognition models by id, in UI order. */
const OCR_MODELS = new Map([
  [
    "PP-OCRv5_mobile_en",
    {
      name: "PP-OCRv5 English",
      languages: "English",
      rec: { ...getModelFiles("en_PP-OCRv5_mobile_rec"), ...REC_SETTINGS },
    },
  ],
  [
    "PP-OCRv5_mobile_latin",
    {
      name: "PP-OCRv5 Latin",
      languages: "French, German, Spanish, Italian, Portuguese, …",
      rec: { ...getModelFiles("latin_PP-OCRv5_mobile_rec"), ...REC_SETTINGS },
    },
  ],
  [
    "PP-OCRv5_mobile_cyrillic",
    {
      name: "PP-OCRv5 Cyrillic",
      languages: "Russian, Ukrainian, Bulgarian, Serbian, …",
      rec: {
        ...getModelFiles("cyrillic_PP-OCRv5_mobile_rec"),
        ...REC_SETTINGS,
      },
    },
  ],
  [
    "PP-OCRv5_mobile",
    {
      name: "PP-OCRv5 Chinese & Japanese",
      languages: "Chinese, Japanese, English",
      rec: { ...getModelFiles("PP-OCRv5_mobile_rec"), ...REC_SETTINGS },
    },
  ],
  [
    "PP-OCRv5_mobile_arabic",
    {
      name: "PP-OCRv5 Arabic",
      languages: "Arabic, Persian, Urdu, …",
      rec: {
        ...getModelFiles("arabic_PP-OCRv5_mobile_rec"),
        ...REC_SETTINGS,
        rightToLeft: true,
      },
    },
  ],
]);

/**
 * The automatic mode: the script of each line is identified (see
 * `script_id.js`), and the line is read with the model of its script.
 */
const AUTO_OCR_MODEL = "auto";

const DEFAULT_OCR_MODEL = AUTO_OCR_MODEL;

/**
 * The recognition model used for each script in automatic mode. Latin-script
 * pages use the English model: on dense scans the Latin one tends to drop word
 * spaces, while the English one only loses some accents of other languages.
 * @type {Map<string, string>}
 */
const SCRIPT_MODELS = new Map([
  ["latin", "PP-OCRv5_mobile_en"],
  ["cyrillic", "PP-OCRv5_mobile_cyrillic"],
  ["cjk", "PP-OCRv5_mobile"],
  ["arabic", "PP-OCRv5_mobile_arabic"],
]);

export {
  AUTO_OCR_MODEL,
  DEFAULT_OCR_MODEL,
  DETECTION_MODEL,
  OCR_MODELS,
  REC_IMAGE_HEIGHT,
  SCRIPT_MODELS,
};
