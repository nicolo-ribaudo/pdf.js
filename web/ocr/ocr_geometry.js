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

/** @typedef {import("../../src/display/api").PDFPageProxy} PDFPageProxy */
// eslint-disable-next-line max-len
/** @typedef {import("../../src/display/page_viewport").PageViewport} PageViewport */

/**
 * The four corners of a text line, in the pixels of the recognized image, in
 * the reading direction (see `RecognizedLine` in
 * `web/text_recognition_service.js`).
 * @typedef {Array<Array<number>>} Quad
 */

import { TextLayer } from "pdfjs-lib";

// Size of the longest side of the image given to the OCR engine, about 180 DPI
// for Letter and A4 pages.
const TARGET_LONG_SIDE = 2000;

// Text lines less than this angle, in radians, away from an axis are snapped to
// it.
const ANGLE_SNAP = 0.01;

// The detected boxes include some padding around the glyphs, hence the font
// size is a bit smaller than the box height so that the injected text roughly
// matches the scanned one.
const FONT_SIZE_RATIO = 0.8;

const DEFAULT_ASCENT = 0.8;

const OCR_FONT_FAMILY = "sans-serif";
const OCR_FONT_NAME = "pdfjsOCR";

const OCR_TEXT_STYLES = Object.freeze({
  [OCR_FONT_NAME]: {
    fontFamily: OCR_FONT_FAMILY,
    ascent: DEFAULT_ASCENT,
    descent: DEFAULT_ASCENT - 1,
    vertical: false,
  },
});

let ascentRatio = 0;

/**
 * The ascent of the text layer font, measured exactly as `TextLayer` does it,
 * since it positions the text runs from their baseline.
 * @returns {number}
 */
function getAscentRatio() {
  if (!ascentRatio) {
    const ctx = document.createElement("canvas").getContext("2d");
    const family =
      TextLayer.fontFamilyMap.get(OCR_FONT_FAMILY) || OCR_FONT_FAMILY;
    ctx.font = `30px ${family}`;
    const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } =
      ctx.measureText("");
    ascentRatio = ascent
      ? ascent / (ascent + Math.abs(descent))
      : DEFAULT_ASCENT;
  }
  return ascentRatio;
}

/**
 * Get the viewport used to render a page for the OCR engine: rotated as it's
 * displayed, so that what is recognized is what the user sees.
 * @param {PDFPageProxy} pdfPage
 * @param {number} rotation - The rotation, in degrees, of the page view.
 * @returns {PageViewport}
 */
function getOCRViewport(pdfPage, rotation) {
  const { width, height } = pdfPage.getViewport({ scale: 1, rotation });
  const scale = TARGET_LONG_SIDE / Math.max(width, height);
  return pdfPage.getViewport({ scale, rotation });
}

/**
 * Convert a quad to the unrotated page space, with the y-axis pointing down,
 * as used by the OCR box layer.
 * @param {Quad} quad
 * @param {PageViewport} viewport - The viewport used to render the image.
 * @returns {Array<Array<number>>}
 */
function quadToPagePoints(quad, viewport) {
  const { pageHeight, pageX, pageY } = viewport.rawDims;
  return quad.map(([x, y]) => {
    const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
    return [pdfX - pageX, pageY + pageHeight - pdfY];
  });
}

/**
 * Create a text content item, in PDF space, for a recognized text line, such
 * that `TextLayer` renders it as a text run covering the detected box.
 * @param {Quad} quad
 * @param {PageViewport} viewport - The viewport used to render the image.
 * @param {string} str - The recognized text.
 * @param {string} [dir] - The text direction, "ltr" or "rtl".
 * @returns {object} A `TextItem`, see `TextContent` in `src/display/api.js`.
 */
function quadToTextItem(quad, viewport, str, dir = "ltr") {
  let [tl, tr, br, bl] = quad.map(([x, y]) => viewport.convertToPdfPoint(x, y));
  // Text runs always go from their left edge, also for right-to-left text: if
  // the line starts on its right (the quad is mirrored, i.e. its corners go
  // counter-clockwise in PDF space), use its left corners instead.
  const cross =
    (tr[0] - tl[0]) * (bl[1] - tl[1]) - (tr[1] - tl[1]) * (bl[0] - tl[0]);
  if (cross > 0) {
    [tl, tr, br, bl] = [tr, tl, bl, br];
  }
  const width = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  let angle = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
  const rightAngle = (Math.PI / 2) * Math.round(angle / (Math.PI / 2));
  if (Math.abs(angle - rightAngle) < ANGLE_SNAP) {
    angle = rightAngle;
  }
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  // The line height is measured along the normal (-sin, cos) of the text.
  const height = Math.abs(cos * (tl[1] - bl[1]) - sin * (tl[0] - bl[0]));
  const fontSize = FONT_SIZE_RATIO * height;

  // `TextLayer` puts the top-left corner of a text run `ascent * fontSize`
  // above its origin, on the baseline: place the origin such that the run
  // starts at the left edge of the line, and is vertically centered in it.
  const baseline = (height - fontSize) / 2 + getAscentRatio() * fontSize;

  return {
    str,
    dir,
    width,
    height: fontSize,
    transform: [
      fontSize * cos,
      fontSize * sin,
      -fontSize * sin,
      fontSize * cos,
      tl[0] + sin * baseline,
      tl[1] - cos * baseline,
    ],
    fontName: OCR_FONT_NAME,
    hasEOL: true,
  };
}

export { getOCRViewport, OCR_TEXT_STYLES, quadToPagePoints, quadToTextItem };
