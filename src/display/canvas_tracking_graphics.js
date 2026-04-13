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

import { BaseGraphics, CanvasExtraState } from "./base_graphics.js";
import {
  CanvasNestedDependencyTracker,
  Dependencies,
} from "./canvas_dependency_tracker.js";
import {
  FONT_IDENTITY_MATRIX,
  OPS,
  TextRenderingMode,
  Util,
  warn,
} from "../shared/util.js";

// Minimal font size that would be used during canvas fillText operations.
const MIN_FONT_SIZE = 16;
// Maximum font size that would be used during canvas fillText operations.
const MAX_FONT_SIZE = 100;

/**
 * CanvasTrackingGraphics implements the same operator dispatch interface as
 * CanvasGraphics, but only performs bounding box and dependency tracking
 * without any canvas rendering. This allows computing operation bboxes and
 * dependencies without needing a live rendering canvas.
 *
 * It must be kept in sync with CanvasGraphics: when operator methods change
 * in canvas.js, the corresponding methods here must be updated as well.
 * Methods in canvas.js that need syncing are annotated with comments
 * pointing to this file.
 */
class CanvasTrackingGraphics extends BaseGraphics {
  constructor(
    commonObjs,
    objs,
    canvasWidth,
    canvasHeight,
    dependencyTracker,
    opts,
    imagesTracker = null
  ) {
    super(canvasWidth, canvasHeight, commonObjs, objs, opts, dependencyTracker);
    this.imagesTracker = imagesTracker;
  }

  getObject(opIdx, data, fallback = null) {
    this.dependencyTracker.recordNamedDependency(opIdx, data);
    return super.getObject(opIdx, data, fallback);
  }

  beginDrawing({ transform, viewport }) {
    if (transform) {
      this.dependencyTracker.transform(...transform);
      this.outputScaleX = transform[0];
      this.outputScaleY = transform[0];
    }
    this.dependencyTracker.transform(...viewport.transform);
    this.viewportScale = viewport.scale;

    this.baseTransform = this.dependencyTracker.getTransform().slice();
  }

  executeOperatorList(operatorList, executionStartIdx) {
    const argsArray = operatorList.argsArray;
    const fnArray = operatorList.fnArray;
    let i = executionStartIdx || 0;
    const argsArrayLen = argsArray.length;

    if (argsArrayLen === i) {
      return i;
    }

    const commonObjs = this.commonObjs;
    const objs = this.objs;
    let fnId, fnArgs;

    while (true) {
      fnId = fnArray[i];
      fnArgs = argsArray[i] ?? null;

      if (fnId !== OPS.dependency) {
        if (fnArgs === null) {
          this[fnId](i);
        } else {
          this[fnId](i, ...fnArgs);
        }
      } else {
        for (const depObjId of fnArgs) {
          this.dependencyTracker.recordNamedData(depObjId, i);
          const objsPool = depObjId.startsWith("g_") ? commonObjs : objs;
          if (!objsPool.has(depObjId)) {
            throw new Error(
              `Dependency ${depObjId} not available for tracking`
            );
          }
        }
      }

      i++;
      if (i === argsArrayLen) {
        return i;
      }
    }
  }

  #restoreInitialState() {
    while (this.stateStack.length) {
      this.restore();
    }
  }

  // Graphics state

  save(opIdx) {
    const old = this.current;
    this.stateStack.push(old);
    this.current = old.clone();
    this.dependencyTracker.save(opIdx);
  }

  restore(opIdx) {
    this.dependencyTracker.restore(opIdx);

    if (this.stateStack.length === 0) {
      return;
    }

    this.current = this.stateStack.pop();
    this.pendingClip = null;
  }

  transform(opIdx, a, b, c, d, e, f) {
    this.dependencyTracker
      .recordIncrementalData("transform", opIdx)
      .transform(a, b, c, d, e, f);
  }

  // Path
  constructPath(opIdx, op, data, minMax) {
    if (!minMax) {
      this[op](opIdx);
      return;
    }

    const outerExtraSize = op === OPS.stroke ? this.current.lineWidth / 2 : 0;
    this.dependencyTracker
      .resetBBox(opIdx)
      .recordBBox(
        opIdx,
        minMax[0] - outerExtraSize,
        minMax[2] + outerExtraSize,
        minMax[1] - outerExtraSize,
        minMax[3] + outerExtraSize
      )
      .recordDependencies(opIdx, ["transform"]);

    this[op](opIdx);
  }

  stroke(opIdx, path, consumePath = true) {
    this.dependencyTracker.recordDependencies(opIdx, Dependencies.stroke);

    if (consumePath) {
      this.consumePath(opIdx);
    }
  }

  fill(opIdx, path, consumePath = true) {
    if (this.current.patternFill) {
      this.dependencyTracker.save(opIdx);
    }

    this.dependencyTracker.recordDependencies(opIdx, Dependencies.fill);

    if (this.current.patternFill) {
      this.dependencyTracker.restore(opIdx);
    }
    this.pendingEOFill = false;
    if (consumePath) {
      this.consumePath(opIdx);
    }
  }

  rawFillPath(opIdx) {
    this.dependencyTracker
      .recordDependencies(opIdx, Dependencies.rawFillPath)
      .recordOperation(opIdx);
  }

  // Clipping
  clip(opIdx) {
    this.dependencyTracker.recordFutureForcedDependency("clipMode", opIdx);
    super.clip(opIdx);
  }

  eoClip(opIdx) {
    this.dependencyTracker.recordFutureForcedDependency("clipMode", opIdx);
    super.eoClip(opIdx);
  }

  // Text
  beginText(opIdx) {
    super.beginText(opIdx);
    this.dependencyTracker
      .recordOpenMarker(opIdx)
      .resetIncrementalData("sameLineText")
      .resetIncrementalData("moveText", opIdx);
  }

  endText(opIdx) {
    if (this.pendingTextPaths !== undefined) {
      this.dependencyTracker
        .recordFutureForcedDependency(
          "textClip",
          this.dependencyTracker.getOpenMarker()
        )
        .recordFutureForcedDependency("textClip", opIdx);
    }
    this.dependencyTracker.recordCloseMarker(opIdx);
    delete this.pendingTextPaths;
  }

  setCharSpacing(opIdx, spacing) {
    this.dependencyTracker.recordSimpleData("charSpacing", opIdx);
    super.setCharSpacing(opIdx, spacing);
  }

  setWordSpacing(opIdx, spacing) {
    this.dependencyTracker.recordSimpleData("wordSpacing", opIdx);
    super.setWordSpacing(opIdx, spacing);
  }

  setHScale(opIdx, scale) {
    this.dependencyTracker.recordSimpleData("hScale", opIdx);
    super.setHScale(opIdx, scale);
  }

  setLeading(opIdx, leading) {
    this.dependencyTracker.recordSimpleData("leading", opIdx);
    super.setLeading(opIdx, leading);
  }

  setFont(opIdx, fontRefName, size) {
    this.dependencyTracker
      .recordSimpleData("font", opIdx)
      .recordSimpleDataFromNamed("fontObj", fontRefName, opIdx);
    const fontObj = this.commonObjs.get(fontRefName);
    const current = this.current;

    if (!fontObj) {
      throw new Error(`Can't find font for ${fontRefName}`);
    }
    current.fontMatrix = fontObj.fontMatrix || FONT_IDENTITY_MATRIX;

    if (current.fontMatrix[0] === 0 || current.fontMatrix[3] === 0) {
      warn("Invalid font matrix for font " + fontRefName);
    }

    if (size < 0) {
      size = -size;
      current.fontDirection = -1;
    } else {
      current.fontDirection = 1;
    }

    this.current.font = fontObj;
    this.current.fontSize = size;

    if (fontObj.isType3Font) {
      return;
    }

    const name = fontObj.loadedName || "sans-serif";
    const typeface =
      fontObj.systemFontInfo?.css || `"${name}", ${fontObj.fallbackName}`;

    let bold = "normal";
    if (fontObj.black) {
      bold = "900";
    } else if (fontObj.bold) {
      bold = "bold";
    }
    const italic = fontObj.italic ? "italic" : "normal";

    let browserFontSize = size;
    if (size < MIN_FONT_SIZE) {
      browserFontSize = MIN_FONT_SIZE;
    } else if (size > MAX_FONT_SIZE) {
      browserFontSize = MAX_FONT_SIZE;
    }
    this.current.fontSizeScale = size / browserFontSize;

    const fontString = `${italic} ${bold} ${browserFontSize}px ${typeface}`;
    this.dependencyTracker.setFont(fontString);
  }

  setTextRenderingMode(opIdx, mode) {
    this.dependencyTracker.recordSimpleData("textRenderingMode", opIdx);
    super.setTextRenderingMode(opIdx, mode);
  }

  setTextRise(opIdx, rise) {
    this.dependencyTracker.recordSimpleData("textRise", opIdx);
    super.setTextRise(opIdx, rise);
  }

  moveText(opIdx, x, y) {
    this.dependencyTracker
      .resetIncrementalData("sameLineText")
      .recordIncrementalData("moveText", opIdx);
    super.moveText(opIdx, x, y);
  }

  setTextMatrix(opIdx, matrix) {
    this.dependencyTracker
      .resetIncrementalData("sameLineText")
      .recordSimpleData("textMatrix", opIdx);
    super.setTextMatrix(opIdx, matrix);
  }

  nextLine(opIdx) {
    super.nextLine(opIdx);
    this.dependencyTracker.recordIncrementalData(
      "moveText",
      this.dependencyTracker.getSimpleIndex("leading") ?? opIdx
    );
  }

  showText(opIdx, glyphs) {
    const { dependencyTracker } = this;

    dependencyTracker
      .recordDependencies(opIdx, Dependencies.showText)
      .resetBBox(opIdx);
    if (this.current.textRenderingMode & TextRenderingMode.ADD_TO_PATH_FLAG) {
      dependencyTracker
        .recordFutureForcedDependency("textClip", opIdx)
        .inheritPendingDependenciesAsFutureForcedDependencies();
    }

    const current = this.current;
    const font = current.font;
    if (font.isType3Font) {
      this.showType3Text(opIdx, glyphs);
      dependencyTracker.recordShowTextOperation(opIdx);
      return undefined;
    }

    const fontSize = current.fontSize;
    if (fontSize === 0) {
      dependencyTracker.recordOperation(opIdx);
      return undefined;
    }

    const fontSizeScale = current.fontSizeScale;
    const charSpacing = current.charSpacing;
    const wordSpacing = current.wordSpacing;
    const fontDirection = current.fontDirection;
    const textHScale = current.textHScale * fontDirection;
    const glyphsLength = glyphs.length;
    const vertical = font.vertical;
    const spacingDir = vertical ? 1 : -1;
    const defaultVMetrics = font.defaultVMetrics;
    const widthAdvanceScale = fontSize * current.fontMatrix[0];

    const scaleY = fontDirection > 0 ? -1 : 1;

    dependencyTracker.save(opIdx);
    if (current.textMatrix) {
      dependencyTracker.transform(...current.textMatrix);
    }
    dependencyTracker
      .translate(current.x, current.y + current.textRise)
      .scale(textHScale, scaleY);

    if (fontSizeScale !== 1.0) {
      dependencyTracker.scale(fontSizeScale, fontSizeScale);
    }

    if (font.isInvalidPDFjsFont) {
      const chars = [];
      let width = 0;
      for (const glyph of glyphs) {
        chars.push(glyph.unicode);
        width += glyph.width;
      }
      const joinedChars = chars.join("");
      const measure = dependencyTracker.measureText(joinedChars);
      dependencyTracker
        .recordBBox(
          opIdx,
          -measure.actualBoundingBoxLeft,
          measure.actualBoundingBoxRight,
          -measure.actualBoundingBoxAscent,
          measure.actualBoundingBoxDescent
        )
        .recordShowTextOperation(opIdx)
        .restore(opIdx);
      current.x += width * widthAdvanceScale * textHScale;
      return undefined;
    }

    let x = 0,
      i;
    for (i = 0; i < glyphsLength; ++i) {
      const glyph = glyphs[i];
      if (typeof glyph === "number") {
        x += (spacingDir * glyph * fontSize) / 1000;
        continue;
      }

      const spacing = (glyph.isSpace ? wordSpacing : 0) + charSpacing;
      const character = glyph.fontChar;
      const accent = glyph.accent;
      let width = glyph.width;
      let scaledX, scaledY;
      if (vertical) {
        const vmetric = glyph.vmetric || defaultVMetrics;
        const vx =
          -(glyph.vmetric ? vmetric[1] : width * 0.5) * widthAdvanceScale;
        const vy = vmetric[2] * widthAdvanceScale;

        width = vmetric ? -vmetric[0] : width;
        scaledX = vx / fontSizeScale;
        scaledY = (x + vy) / fontSizeScale;
      } else {
        scaledX = x / fontSizeScale;
        scaledY = 0;
      }

      if (glyph.isInFont || font.missingFile) {
        const textRenderingMode = current.textRenderingMode;
        const fillStrokeMode =
          textRenderingMode & TextRenderingMode.FILL_STROKE_MASK;

        if (
          (font.disableFontFace ||
            current.patternFill ||
            current.patternStroke) &&
          !font.missingFile
        ) {
          // Path-based rendering: bbox from font path
          dependencyTracker.withLocalTransform(dt =>
            dt
              .translate(scaledX, scaledY)
              .scale(fontSize / fontSizeScale, -(fontSize / fontSizeScale))
              .recordCharacterBBox(opIdx, null, font)
          );
        } else {
          // fillText/strokeText rendering
          if (
            fillStrokeMode === TextRenderingMode.FILL ||
            fillStrokeMode === TextRenderingMode.FILL_STROKE
          ) {
            dependencyTracker.recordCharacterBBox(
              opIdx,
              character,
              font.remeasure && width > 0 ? { bbox: null } : font,
              fontSize / fontSizeScale,
              scaledX,
              scaledY
            );
          }
          if (
            fillStrokeMode === TextRenderingMode.STROKE ||
            fillStrokeMode === TextRenderingMode.FILL_STROKE
          ) {
            dependencyTracker
              .recordCharacterBBox(
                opIdx,
                character,
                font,
                fontSize / fontSizeScale,
                scaledX,
                scaledY
              )
              .recordDependencies(opIdx, Dependencies.stroke);
          }
        }

        if (accent) {
          const scaledAccentX =
            scaledX + (fontSize * accent.offset.x) / fontSizeScale;
          const scaledAccentY =
            scaledY - (fontSize * accent.offset.y) / fontSizeScale;
          dependencyTracker.recordCharacterBBox(
            opIdx,
            accent.fontChar,
            font,
            fontSize / fontSizeScale,
            scaledAccentX,
            scaledAccentY
          );
        }

        if (textRenderingMode & TextRenderingMode.ADD_TO_PATH_FLAG) {
          this.pendingTextPaths = true;
          dependencyTracker.recordCharacterBBox(
            opIdx,
            null,
            font,
            fontSize / fontSizeScale,
            scaledX,
            scaledY
          );
        }
      }

      const charWidth = vertical
        ? width * widthAdvanceScale - spacing * fontDirection
        : width * widthAdvanceScale + spacing * fontDirection;
      x += charWidth;
    }
    if (vertical) {
      current.y -= x;
    } else {
      current.x += x * textHScale;
    }
    dependencyTracker.restore(opIdx).recordShowTextOperation(opIdx);
    return undefined;
  }

  showType3Text(opIdx, glyphs) {
    const current = this.current;
    const font = current.font;
    const fontSize = current.fontSize;
    const fontDirection = current.fontDirection;
    const spacingDir = font.vertical ? 1 : -1;
    const charSpacing = current.charSpacing;
    const wordSpacing = current.wordSpacing;
    const textHScale = current.textHScale * fontDirection;
    const fontMatrix = current.fontMatrix || FONT_IDENTITY_MATRIX;
    const glyphsLength = glyphs.length;
    const isTextInvisible =
      current.textRenderingMode === TextRenderingMode.INVISIBLE;
    let i, glyph, width, spacingLength;

    if (isTextInvisible || fontSize === 0) {
      return;
    }

    const dependencyTracker = this.dependencyTracker;
    dependencyTracker.save(opIdx);
    if (current.textMatrix) {
      dependencyTracker.transform(...current.textMatrix);
    }
    dependencyTracker
      .translate(current.x, current.y + current.textRise)
      .scale(textHScale, fontDirection);

    // Type3 fonts have their own operator list. Avoid mixing it up with the
    // dependency tracker of the main operator list.
    this.dependencyTracker = new CanvasNestedDependencyTracker(
      dependencyTracker,
      opIdx
    );

    for (i = 0; i < glyphsLength; ++i) {
      glyph = glyphs[i];
      if (typeof glyph === "number") {
        spacingLength = (spacingDir * glyph * fontSize) / 1000;
        this.dependencyTracker.translate(spacingLength, 0);
        current.x += spacingLength * textHScale;
        continue;
      }

      const spacing = (glyph.isSpace ? wordSpacing : 0) + charSpacing;
      const operatorList = font.charProcOperatorList[glyph.operatorListId];
      if (!operatorList) {
        warn(`Type3 character "${glyph.operatorListId}" is not available.`);
      } else if (this.contentVisible) {
        this.save();
        this.dependencyTracker
          .scale(fontSize, fontSize)
          .transform(...fontMatrix);
        this.executeOperatorList(operatorList);
        this.restore();
      }

      const p = [glyph.width, 0];
      Util.applyTransform(p, fontMatrix);
      width = p[0] * fontSize + spacing;

      this.dependencyTracker.translate(width, 0);
      current.x += width * textHScale;
    }
    dependencyTracker.restore(opIdx);
    this.dependencyTracker = dependencyTracker;
  }

  // Type3 fonts
  setCharWidthAndBounds(opIdx, xWidth, yWidth, llx, lly, urx, ury) {
    this.dependencyTracker
      .recordBBox(opIdx, llx, urx, lly, ury)
      .bboxToClipBoxDropOperation(opIdx);
  }

  // Color
  setStrokeColorN(opIdx, ...args) {
    this.dependencyTracker.recordSimpleData("strokeColor", opIdx);
    this.current.patternStroke = true;
  }

  setFillColorN(opIdx, ...args) {
    this.dependencyTracker.recordSimpleData("fillColor", opIdx);
    this.current.patternFill = true;
  }

  setStrokeRGBColor(opIdx, color) {
    this.dependencyTracker.recordSimpleData("strokeColor", opIdx);
    super.setStrokeRGBColor(opIdx, color);
  }

  setStrokeTransparent(opIdx) {
    this.dependencyTracker.recordSimpleData("strokeColor", opIdx);
    super.setStrokeTransparent(opIdx);
  }

  setFillRGBColor(opIdx, color) {
    this.dependencyTracker.recordSimpleData("fillColor", opIdx);
    super.setFillRGBColor(opIdx, color);
  }

  setFillTransparent(opIdx) {
    this.dependencyTracker.recordSimpleData("fillColor", opIdx);
    super.setFillTransparent(opIdx);
  }

  shadingFill(opIdx, objId) {
    if (!this.contentVisible) {
      return;
    }
    this.getObject(opIdx, objId);
    this.save(opIdx);
    this.dependencyTracker
      .resetBBox(opIdx)
      .recordFullPageBBox(opIdx)
      .recordDependencies(opIdx, Dependencies.transform)
      .recordDependencies(opIdx, Dependencies.fill)
      .recordOperation(opIdx);
    this.restore(opIdx);
  }

  // Images
  paintFormXObjectBegin(opIdx, matrix, bbox) {
    if (!this.contentVisible) {
      return;
    }
    this.save(opIdx);
    this.baseTransformStack.push(this.baseTransform);

    if (matrix) {
      this.transform(opIdx, ...matrix);
    }
    this.baseTransform = this.dependencyTracker.getTransform().slice();

    if (bbox) {
      const [x0, y0, x1, y1] = bbox;
      this.dependencyTracker.recordClipBox(opIdx, x0, x1, y0, y1);
      this.endPath(opIdx);
    }
  }

  beginGroup(opIdx, group) {
    if (!this.contentVisible) {
      return;
    }

    this.save(opIdx);

    if (!group.needsIsolation && !group.smask) {
      this.groupStack.push(null);
      this.groupLevel++;
      return;
    }

    const currentTransform = this.dependencyTracker.getTransform().slice();
    if (group.matrix) {
      this.dependencyTracker.transform(...group.matrix);
    }

    // Compute bounds same as CanvasGraphics but without creating a canvas.
    // Use the canvas dimensions from the CanvasExtraState.
    const canvasWidth = this.current.clipBox[2] || 1;
    const canvasHeight = this.current.clipBox[3] || 1;
    const canvasBounds = [0, 0, canvasWidth, canvasHeight];

    let bounds;
    if (group.bbox) {
      const transform = this.dependencyTracker.getTransform();
      const tmpBounds = new Float32Array([
        Infinity,
        -Infinity,
        Infinity,
        -Infinity,
      ]);
      Util.axialAlignedBoundingBox(group.bbox, transform, tmpBounds);
      bounds = Util.intersect(
        [tmpBounds[0], tmpBounds[2], tmpBounds[1], tmpBounds[3]],
        canvasBounds
      ) || [0, 0, 0, 0];
    } else {
      bounds = canvasBounds;
    }

    const offsetX = Math.floor(bounds[0]);
    const offsetY = Math.floor(bounds[1]);

    this.current.startNewPathAndClipBox([
      0,
      0,
      Math.max(Math.ceil(bounds[2]) - offsetX, 1),
      Math.max(Math.ceil(bounds[3]) - offsetY, 1),
    ]);

    const savedTransform = this.dependencyTracker.getTransform().slice();
    this.dependencyTracker
      .inheritSimpleDataAsFutureForcedDependencies([
        "fillAlpha",
        "strokeAlpha",
        "globalCompositeOperation",
      ])
      .setTransform(1, 0, 0, 1, offsetX, offsetY)
      .pushBaseTransform()
      .setTransform(
        savedTransform[0],
        savedTransform[1],
        savedTransform[2],
        savedTransform[3],
        savedTransform[4] - offsetX,
        savedTransform[5] - offsetY
      );

    this.setGState(opIdx, [
      ["BM", "source-over"],
      ["ca", 1],
      ["CA", 1],
      ["TR", null],
    ]);
    this.groupStack.push(currentTransform);
    this.groupLevel++;
  }

  endGroup(opIdx, group) {
    if (!this.contentVisible) {
      return;
    }
    this.groupLevel--;
    const savedTransform = this.groupStack.pop();
    if (savedTransform === null) {
      this.restore(opIdx);
      return;
    }

    this.dependencyTracker.popBaseTransform();
    this.restore(opIdx);
  }

  beginAnnotation(opIdx, id, rect, transform, matrix, hasOwnCanvas) {
    this.#restoreInitialState();

    this.save(opIdx);

    if (this.baseTransform) {
      this.dependencyTracker.setTransform(...this.baseTransform);
    }

    if (rect) {
      if (hasOwnCanvas) {
        transform = transform.slice();
        transform[4] -= rect[0];
        transform[5] -= rect[1];

        const width = rect[2] - rect[0];
        const height = rect[3] - rect[1];
        const canvasWidth = Math.ceil(
          width * this.outputScaleX * this.viewportScale
        );
        const canvasHeight = Math.ceil(
          height * this.outputScaleY * this.viewportScale
        );

        this.current = new CanvasExtraState(canvasWidth, canvasHeight);
      } else {
        this.endPath(opIdx);
        this.current = new CanvasExtraState(
          this.current.clipBox[2] || 1,
          this.current.clipBox[3] || 1
        );
      }
    } else {
      this.current = new CanvasExtraState(
        this.current.clipBox[2] || 1,
        this.current.clipBox[3] || 1
      );
    }

    this.baseTransformStack.push(this.baseTransform);
    this.transform(opIdx, ...transform);
    this.transform(opIdx, ...matrix);
    this.baseTransform = this.dependencyTracker.getTransform().slice();
  }

  endAnnotation(opIdx) {
    this.baseTransform = this.baseTransformStack.pop();
  }

  paintImageMaskXObject(opIdx, img) {
    if (!this.contentVisible) {
      return;
    }

    img = this.getObject(opIdx, img.data, img);

    // The mask is painted into a unit square [0,0,1,1] in user space.
    // recordBBox applies the current transform internally.
    this.dependencyTracker
      .resetBBox(opIdx)
      .recordBBox(opIdx, 0, 1, 0, 1)
      .recordOperation(opIdx);
  }

  paintImageMaskXObjectRepeat(
    opIdx,
    img,
    scaleX,
    skewX = 0,
    skewY = 0,
    scaleY,
    positions
  ) {
    if (!this.contentVisible) {
      return;
    }

    img = this.getObject(opIdx, img.data, img);

    this.dependencyTracker.save(opIdx).resetBBox(opIdx);

    for (let i = 0, ii = positions.length; i < ii; i += 2) {
      this.dependencyTracker.withLocalTransform(dt =>
        dt
          .transform(
            scaleX,
            skewX,
            skewY,
            scaleY,
            positions[i],
            positions[i + 1]
          )
          .recordBBox(opIdx, 0, 1, 0, 1)
      );
    }
    this.dependencyTracker.restore(opIdx).recordOperation(opIdx);
  }

  paintImageMaskXObjectGroup(opIdx, images) {
    if (!this.contentVisible) {
      return;
    }

    this.dependencyTracker
      .resetBBox(opIdx)
      .recordDependencies(opIdx, Dependencies.transformAndFill);

    for (const image of images) {
      const { width, height, transform } = image;
      this.getObject(opIdx, image.data, image);
      this.dependencyTracker.withLocalTransform(dt =>
        dt
          .transform(...transform)
          .scale(1, -1)
          .recordBBox(opIdx, 0, width, 0, height)
      );
    }
    this.dependencyTracker.recordOperation(opIdx);
  }

  paintInlineImageXObject(opIdx, imgData) {
    if (!this.contentVisible) {
      return;
    }
    const width = imgData.width;
    const height = imgData.height;

    this.save(opIdx);

    // scale the image to the unit square
    this.dependencyTracker.scale(1 / width, -1 / height);

    this.dependencyTracker
      .resetBBox(opIdx)
      .recordBBox(opIdx, 0, width, -height, 0)
      .recordDependencies(opIdx, Dependencies.imageXObject)
      .recordOperation(opIdx);
    this.imagesTracker?.record(
      this.dependencyTracker.getTransform(),
      width,
      height,
      this.dependencyTracker.clipBox
    );
    this.restore(opIdx);
  }

  paintInlineImageXObjectGroup(opIdx, imgData, map) {
    if (!this.contentVisible) {
      return;
    }

    this.dependencyTracker.resetBBox(opIdx);

    for (const entry of map) {
      this.dependencyTracker.withLocalTransform(dt =>
        dt
          .transform(...entry.transform)
          .scale(1, -1)
          .recordBBox(opIdx, 0, 1, -1, 0)
      );
    }
    this.dependencyTracker.recordOperation(opIdx);
  }

  paintSolidColorImageMask(opIdx) {
    if (!this.contentVisible) {
      return;
    }
    this.dependencyTracker
      .resetBBox(opIdx)
      .recordBBox(opIdx, 0, 1, 0, 1)
      .recordDependencies(opIdx, Dependencies.fill)
      .recordOperation(opIdx);
  }

  // Marked content

  beginMarkedContent(opIdx, tag) {
    this.dependencyTracker.beginMarkedContent(opIdx);
    super.beginMarkedContent(opIdx, tag);
  }

  beginMarkedContentProps(opIdx, tag, properties) {
    this.dependencyTracker.beginMarkedContent(opIdx);
    super.beginMarkedContentProps(opIdx, tag, properties);
  }

  endMarkedContent(opIdx) {
    this.dependencyTracker.endMarkedContent(opIdx);
    super.endMarkedContent(opIdx);
  }

  // Graphics state (simple setters)
  setLineWidth(opIdx, width) {
    this.dependencyTracker.recordSimpleData("lineWidth", opIdx);
    super.setLineWidth(opIdx, width);
  }

  setLineCap(opIdx, style) {
    this.dependencyTracker.recordSimpleData("lineCap", opIdx);
  }

  setLineJoin(opIdx, style) {
    this.dependencyTracker.recordSimpleData("lineJoin", opIdx);
  }

  setMiterLimit(opIdx, limit) {
    this.dependencyTracker.recordSimpleData("miterLimit", opIdx);
  }

  setDash(opIdx, dashArray, dashPhase) {
    this.dependencyTracker.recordSimpleData("dash", opIdx);
  }

  setGState(opIdx, states) {
    for (const [key, value] of states) {
      switch (key) {
        case "LW":
          this.setLineWidth(opIdx, value);
          break;
        case "LC":
          this.setLineCap(opIdx, value);
          break;
        case "LJ":
          this.setLineJoin(opIdx, value);
          break;
        case "ML":
          this.setMiterLimit(opIdx, value);
          break;
        case "D":
          this.setDash(opIdx, value[0], value[1]);
          break;
        case "RI":
          this.setRenderingIntent(opIdx, value);
          break;
        case "FL":
          this.setFlatness(opIdx, value);
          break;
        case "Font":
          this.setFont(opIdx, value[0], value[1]);
          break;
        case "CA":
          this.dependencyTracker.recordSimpleData("strokeAlpha", opIdx);
          this.current.strokeAlpha = value;
          break;
        case "ca":
          this.dependencyTracker.recordSimpleData("fillAlpha", opIdx);
          this.current.fillAlpha = value;
          break;
        case "BM":
          this.dependencyTracker.recordSimpleData(
            "globalCompositeOperation",
            opIdx
          );
          break;
        case "SMask":
          this.dependencyTracker.recordSimpleData("SMask", opIdx);
          break;
        case "TR":
          this.dependencyTracker.recordSimpleData("filter", opIdx);
          break;
      }
    }
  }

  // Helper functions

  consumePath(opIdx) {
    if (this.pendingClip) {
      this.current.updateClipFromPath();
    }
    if (this.pendingClip) {
      this.pendingClip = null;
      this.dependencyTracker
        .bboxToClipBoxDropOperation(opIdx)
        .recordFutureForcedDependency("clipPath", opIdx);
    } else {
      this.dependencyTracker.recordOperation(opIdx);
    }

    this.current.startNewPathAndClipBox(this.current.clipBox);
  }
}

for (const op in OPS) {
  if (CanvasTrackingGraphics.prototype[op] !== undefined) {
    CanvasTrackingGraphics.prototype[OPS[op]] =
      CanvasTrackingGraphics.prototype[op];
  }
}

export { CanvasTrackingGraphics };
