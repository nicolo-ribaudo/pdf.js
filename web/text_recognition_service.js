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

/**
 * A text recognition model (or language) that the user can choose.
 * @typedef {object} TextRecognitionModel
 * @property {string} id - Passed back to `recognize` as `params.model`.
 * @property {string} name - The name shown to the user.
 * @property {string} [description] - Shown below the name, e.g. the languages
 *   that the model supports.
 */

/**
 * A recognized line of text.
 * @typedef {object} RecognizedLine
 * @property {number} index - The position of the line in reading order.
 * @property {Array<Array<number>>} quad - The four corners of the line, in the
 *   pixels of the image, oriented like the upright text: top-left, top-right,
 *   bottom-right, bottom-left (for text rotated by 90°, `quad[0]` is the
 *   top-left corner of the upright glyphs, not of the box in the image).
 *   Left-to-right text starts at the top-left corner, right-to-left text at
 *   the top-right one.
 * @property {string} text - The text, in logical order.
 * @property {string} dir - "ltr" or "rtl".
 * @property {number} confidence - Between 0 and 1.
 */

/**
 * @typedef {object} TextRecognitionProgress
 * @property {string} stage - One of:
 *   - "loading": downloading the engine or a model (`model`, `loaded`, and
 *     `total` in bytes, are optional);
 *   - "preparing": initializing the engine or a model (`model` is optional);
 *   - "detecting": finding the lines of text;
 *   - "identifying": identifying the script or language of the lines;
 *   - "recognizing": reading the lines (`count` is the number of lines to
 *     read, `done` the number of lines read so far; `models`, the names of
 *     the models in use, is optional).
 * @property {string} [model] - The name of a model.
 * @property {Array<string>} [models]
 * @property {number} [loaded]
 * @property {number} [total]
 * @property {number} [done]
 * @property {number} [count]
 */

/**
 * @typedef {object} TextRecognitionParameters
 * @property {string|null} [model] - The id of one of the `models`; `null` or
 *   omitted to let the service choose (only if `supportsAutomaticModel` is
 *   true).
 * @property {AbortSignal} [signal] - Aborting it cancels the recognition; the
 *   returned promise then rejects with an `AbortError`.
 * @property {function(TextRecognitionProgress): void} [onProgress]
 * @property {function(Array<Array<Array<number>>>): void} [onLinesDetected] -
 *   Called, at most once and before any `onLinesRecognized`, with the quads of
 *   all the lines that will be recognized (indexed as `RecognizedLine.index`,
 *   in the same orientation as `RecognizedLine.quad`). Services that don't
 *   detect the lines before reading them may never call it.
 * @property {function(Array<RecognizedLine>): void} [onLinesRecognized] -
 *   Called as lines are recognized, in ascending `index` order.
 */

/**
 * @typedef {object} TextRecognitionResult
 * @property {Array<RecognizedLine>} lines - All the recognized lines, in
 *   reading order; it can skip indices (e.g. lines that turned out empty).
 * @property {Array<string>} models - The names of the models that were used
 *   (empty if there was no text).
 * @property {string} engine - A short description of how the text was
 *   recognized, shown to the user (e.g. "WebGPU").
 * @property {string} [details] - More details, e.g. timings, shown on demand.
 */

/**
 * The interface between PDF.js and a text recognition (OCR) engine, which
 * embedders provide through
 * `BaseExternalServices.createTextRecognitionService`.
 * PDF.js renders a page to an image, and the service finds and reads its
 * lines of text; PDF.js then turns them into a text layer.
 *
 * Implementations should load their models lazily, the first time they are
 * needed, since most documents never need OCR.
 */
class BaseTextRecognitionService {
  /**
   * The models that the user can choose from. If there's only one, PDF.js
   * doesn't show a choice.
   * @type {Array<TextRecognitionModel>}
   */
  get models() {
    return [];
  }

  /**
   * Whether the service can choose the model by itself, e.g. by identifying
   * the script of the text; PDF.js then offers it as the default choice.
   * @type {boolean}
   */
  get supportsAutomaticModel() {
    return false;
  }

  /**
   * Recognizes the text of an image.
   * @param {ImageBitmap} image - The ownership of the image is transferred to
   *   the service, which must close it once it's done with it.
   * @param {TextRecognitionParameters} params
   * @returns {Promise<TextRecognitionResult>}
   */
  async recognize(image, params) {
    throw new Error("Not implemented: recognize");
  }

  /**
   * Releases all the resources (workers, models, …) of the service.
   */
  destroy() {}
}

export { BaseTextRecognitionService };
