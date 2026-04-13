/* Copyright 2025 Mozilla Foundation
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

import {
  F32_BBOX_INIT,
  FONT_IDENTITY_MATRIX,
  TextRenderingMode,
  unreachable,
  Util,
  warn,
} from "../shared/util.js";
import { PathType } from "./pattern_helper.js";

// Used to get some coordinates.
const XY = new Float32Array(2);

const NORMAL_CLIP = {};
const EO_CLIP = {};

// <canvas> contexts store most of the state we need natively.
// However, PDF needs a bit more state, which we store here.
class CanvasExtraState {
  // Are soft masks and alpha values shapes or opacities?
  alphaIsShape = false;

  fontSize = 0;

  fontSizeScale = 1;

  textMatrix = null;

  textMatrixScale = 1;

  fontMatrix = FONT_IDENTITY_MATRIX;

  leading = 0;

  // Current point (in user coordinates)
  x = 0;

  y = 0;

  // Start of text line (in text coordinates)
  lineX = 0;

  lineY = 0;

  // Character and word spacing
  charSpacing = 0;

  wordSpacing = 0;

  textHScale = 1;

  textRenderingMode = TextRenderingMode.FILL;

  textRise = 0;

  // Default fore and background colors
  fillColor = "#000000";

  strokeColor = "#000000";

  tilingPatternDims = null;

  patternFill = false;

  patternStroke = false;

  // Note: fill alpha applies to all non-stroking operations
  fillAlpha = 1;

  strokeAlpha = 1;

  lineWidth = 1;

  activeSMask = null;

  transferMaps = "none";

  minMax = F32_BBOX_INIT.slice();

  constructor(width, height) {
    this.clipBox = new Float32Array([0, 0, width, height]);
  }

  clone() {
    const clone = Object.create(this);
    clone.clipBox = this.clipBox.slice();
    clone.minMax = this.minMax.slice();
    clone.tilingPatternDims = this.tilingPatternDims?.slice();
    return clone;
  }

  getPathBoundingBox(pathType = PathType.FILL, transform = null) {
    const box = this.minMax.slice();
    if (pathType === PathType.STROKE) {
      if (!transform) {
        unreachable("Stroke bounding box must include transform.");
      }
      // Stroked paths can be outside of the path bounding box
      // by 1/2 the line width.
      Util.singularValueDecompose2dScale(transform, XY);
      const xStrokePad = (XY[0] * this.lineWidth) / 2;
      const yStrokePad = (XY[1] * this.lineWidth) / 2;
      box[0] -= xStrokePad;
      box[1] -= yStrokePad;
      box[2] += xStrokePad;
      box[3] += yStrokePad;
    }
    return box;
  }

  updateClipFromPath() {
    const intersect = Util.intersect(this.clipBox, this.getPathBoundingBox());
    this.startNewPathAndClipBox(intersect || [0, 0, 0, 0]);
  }

  isEmptyClip() {
    return this.minMax[0] === Infinity;
  }

  startNewPathAndClipBox(box) {
    this.clipBox.set(box, 0);
    this.minMax.set(F32_BBOX_INIT, 0);
  }

  getClippedPathBoundingBox(pathType = PathType.FILL, transform = null) {
    return Util.intersect(
      this.clipBox,
      this.getPathBoundingBox(pathType, transform)
    );
  }
}

/**
 * BaseGraphics is the shared superclass of CanvasGraphics and
 * CanvasTrackingGraphics, containing common state management and
 * methods that are identical in both subclasses.
 */
class BaseGraphics {
  constructor(
    canvasWidth,
    canvasHeight,
    commonObjs,
    objs,
    { optionalContentConfig, markedContentStack = null },
    dependencyTracker = null
  ) {
    this.current = new CanvasExtraState(canvasWidth, canvasHeight);
    this.stateStack = [];
    this.pendingClip = null;
    this.pendingEOFill = false;
    this.commonObjs = commonObjs;
    this.objs = objs;
    this.baseTransform = null;
    this.baseTransformStack = [];
    this.groupStack = [];
    this.groupLevel = 0;
    this.contentVisible = true;
    this.markedContentStack = markedContentStack || [];
    this.optionalContentConfig = optionalContentConfig;
    this.viewportScale = 1;
    this.outputScaleX = 1;
    this.outputScaleY = 1;
    this.dependencyTracker = dependencyTracker;
  }

  // --- Object lookup ---

  getObject(opIdx, data, fallback = null) {
    if (typeof data === "string") {
      return data.startsWith("g_")
        ? this.commonObjs.get(data)
        : this.objs.get(data);
    }
    return fallback;
  }

  // --- Text state ---

  beginText(opIdx) {
    this.current.textMatrix = null;
    this.current.textMatrixScale = 1;
    this.current.x = this.current.lineX = 0;
    this.current.y = this.current.lineY = 0;
  }

  setCharSpacing(opIdx, spacing) {
    this.current.charSpacing = spacing;
  }

  setWordSpacing(opIdx, spacing) {
    this.current.wordSpacing = spacing;
  }

  setHScale(opIdx, scale) {
    this.current.textHScale = scale / 100;
  }

  setLeading(opIdx, leading) {
    this.current.leading = -leading;
  }

  setTextRenderingMode(opIdx, mode) {
    this.current.textRenderingMode = mode;
  }

  setTextRise(opIdx, rise) {
    this.current.textRise = rise;
  }

  moveText(opIdx, x, y) {
    this.current.x = this.current.lineX += x;
    this.current.y = this.current.lineY += y;
  }

  setLeadingMoveText(opIdx, x, y) {
    this.setLeading(opIdx, -y);
    this.moveText(opIdx, x, y);
  }

  setTextMatrix(opIdx, matrix) {
    const { current } = this;
    current.textMatrix = matrix;
    current.textMatrixScale = Math.hypot(matrix[0], matrix[1]);

    current.x = current.lineX = 0;
    current.y = current.lineY = 0;
  }

  nextLine(opIdx) {
    this.moveText(opIdx, 0, this.current.leading);
  }

  // --- Graphics state (simple setters) ---

  setLineWidth(opIdx, width) {
    this.current.lineWidth = width;
  }

  setRenderingIntent(opIdx, intent) {
    // This operation is ignored since we haven't found a
    // use case for it yet.
  }

  setFlatness(opIdx, flatness) {
    // This operation is ignored since we haven't found a
    // use case for it yet.
  }

  // --- Clipping ---

  clip(opIdx) {
    this.pendingClip = NORMAL_CLIP;
  }

  eoClip(opIdx) {
    this.pendingClip = EO_CLIP;
  }

  // --- Fill/stroke delegates ---

  closeStroke(opIdx, path) {
    this.stroke(opIdx, path);
  }

  eoFill(opIdx, path) {
    this.pendingEOFill = true;
    this.fill(opIdx, path);
  }

  fillStroke(opIdx, path) {
    this.fill(opIdx, path, false);
    this.stroke(opIdx, path, false);

    this.consumePath(opIdx, path);
  }

  eoFillStroke(opIdx, path) {
    this.pendingEOFill = true;
    this.fillStroke(opIdx, path);
  }

  closeFillStroke(opIdx, path) {
    this.fillStroke(opIdx, path);
  }

  closeEOFillStroke(opIdx, path) {
    this.pendingEOFill = true;
    this.fillStroke(opIdx, path);
  }

  endPath(opIdx, path) {
    this.consumePath(opIdx, path);
  }

  // --- Color state ---

  setStrokeRGBColor(opIdx, color) {
    this.current.strokeColor = color;
    this.current.patternStroke = false;
  }

  setStrokeTransparent(opIdx) {
    this.current.strokeColor = "transparent";
    this.current.patternStroke = false;
  }

  setFillRGBColor(opIdx, color) {
    this.current.fillColor = color;
    this.current.patternFill = false;
    this.current.tilingPatternDims = null;
  }

  setFillTransparent(opIdx) {
    this.current.fillColor = "transparent";
    this.current.patternFill = false;
    this.current.tilingPatternDims = null;
  }

  // --- Marked content ---

  markPoint(opIdx, tag) {
    // TODO Marked content.
  }

  markPointProps(opIdx, tag, properties) {
    // TODO Marked content.
  }

  beginMarkedContent(opIdx, tag) {
    this.markedContentStack.push({
      visible: true,
    });
  }

  beginMarkedContentProps(opIdx, tag, properties) {
    if (tag === "OC") {
      this.markedContentStack.push({
        visible: this.optionalContentConfig.isVisible(properties),
      });
    } else {
      this.markedContentStack.push({
        visible: true,
      });
    }
    this.contentVisible = this.isContentVisible();
  }

  endMarkedContent(opIdx) {
    this.markedContentStack.pop();
    this.contentVisible = this.isContentVisible();
  }

  // --- Compatibility ---

  beginCompat(opIdx) {
    // TODO ignore undefined operators
  }

  endCompat(opIdx) {
    // TODO stop ignoring undefined operators
  }

  // --- Type3 fonts ---

  setCharWidth(opIdx, xWidth, yWidth) {
    // We can safely ignore this since the width should be the
    // same as the width in the Widths array.
  }

  // --- Form XObjects ---

  paintFormXObjectEnd(opIdx) {
    if (!this.contentVisible) {
      return;
    }
    this.restore(opIdx);
    this.baseTransform = this.baseTransformStack.pop();
  }

  // --- Images ---

  beginInlineImage() {
    unreachable("Should not call beginInlineImage");
  }

  beginImageData() {
    unreachable("Should not call beginImageData");
  }

  paintImageXObject(opIdx, objId) {
    if (!this.contentVisible) {
      return;
    }
    const imgData = this.getObject(opIdx, objId);
    if (!imgData) {
      warn("Dependent image isn't ready yet");
      return;
    }

    this.paintInlineImageXObject(opIdx, imgData);
  }

  paintImageXObjectRepeat(opIdx, objId, scaleX, scaleY, positions) {
    if (!this.contentVisible) {
      return;
    }
    const imgData = this.getObject(opIdx, objId);
    if (!imgData) {
      warn("Dependent image isn't ready yet");
      return;
    }

    const width = imgData.width;
    const height = imgData.height;
    const map = [];
    for (let i = 0, ii = positions.length; i < ii; i += 2) {
      map.push({
        transform: [scaleX, 0, 0, scaleY, positions[i], positions[i + 1]],
        x: 0,
        y: 0,
        w: width,
        h: height,
      });
    }
    this.paintInlineImageXObjectGroup(opIdx, imgData, map);
  }

  // --- Helpers ---

  isContentVisible() {
    for (let i = this.markedContentStack.length - 1; i >= 0; i--) {
      if (!this.markedContentStack[i].visible) {
        return false;
      }
    }
    return true;
  }
}

export { BaseGraphics, CanvasExtraState, EO_CLIP, NORMAL_CLIP };
