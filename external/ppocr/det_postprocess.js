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

// Pre- and post-processing for the PaddleOCR text detection model (DBNet).
// The post-processing is an OpenCV-free port of PaddleOCR's `DBPostProcess`
// (with `score_mode = "fast"` and `box_type = "quad"`): the text regions are
// the 8-connected components of the binarized probability map, and each of
// them is approximated by its minimum-area rectangle. The boxes are then sorted
// in a column-aware reading order (which isn't what PaddleOCR does).

// PaddleOCR normalizes BGR images with these per-channel values, hence the
// first ones apply to the blue channel.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// Boxes whose top-left corners are vertically closer than this (in pixels)
// are considered to be on the same line when sorting them.
const SAME_LINE_THRESHOLD = 10;

// When splitting boxes into blocks, relatively to the median box height: rows
// of boxes overlapping by up to ROW_OVERLAP are still considered separate (and
// gaps differing by less than that are considered as wide), and columns must
// be at least COLUMN_GAP apart.
const ROW_OVERLAP = 0.15;
const COLUMN_GAP = 0.5;

function clamp(value, min, max) {
  if (value < min) {
    return min;
  }
  return value > max ? max : value;
}

/**
 * Convert RGBA pixels into the input tensor of the detection model.
 * @param {Uint8ClampedArray} rgba - RGBA pixels, row-major.
 * @param {number} width - The image width, a multiple of 32.
 * @param {number} height - The image height, a multiple of 32.
 * @returns {Float32Array} The CHW tensor data, in B, G, R channel order.
 */
function prepareDetInput(rgba, width, height) {
  const size = width * height;
  const data = new Float32Array(3 * size);
  // (v / 255 - mean) / std = v * scale + offset
  const [scaleB, scaleG, scaleR] = STD.map(s => 1 / (255 * s));
  const [offsetB, offsetG, offsetR] = MEAN.map((m, i) => -m / STD[i]);

  for (let i = 0, j = 0; i < size; i++, j += 4) {
    data[i] = rgba[j + 2] * scaleB + offsetB;
    data[size + i] = rgba[j + 1] * scaleG + offsetG;
    data[2 * size + i] = rgba[j] * scaleR + offsetR;
  }
  return data;
}

function growInt32Array(array) {
  const grown = new Int32Array(2 * array.length);
  grown.set(array);
  return grown;
}

/**
 * Find the 8-connected components of the pixels whose probability is above
 * `thresh`. The image is scanned in runs of consecutive foreground pixels,
 * which are merged with a union-find.
 * @returns {Array<Int32Array>} For each component, in the raster order of
 *   their first pixel and at most `maxCount` of them, the leftmost and the
 *   rightmost pixel of each of its rows as interleaved x, y coordinates,
 *   sorted by (y, x). They have the same convex hull as the whole component.
 */
function findRegions(prob, width, height, thresh, maxCount) {
  let runY = new Int32Array(1024);
  let runStart = new Int32Array(1024);
  let runEnd = new Int32Array(1024);
  let parent = new Int32Array(1024);
  let count = 0;

  const find = i => {
    while (parent[i] !== i) {
      i = parent[i] = parent[parent[i]];
    }
    return i;
  };

  for (let y = 0, prevFirst = 0, prevEnd = 0; y < height; y++) {
    const rowFirst = count;
    const offset = y * width;
    let prev = prevFirst;

    for (let x = 0; x < width; x++) {
      if (prob[offset + x] <= thresh) {
        continue;
      }
      const start = x;
      while (x + 1 < width && prob[offset + x + 1] > thresh) {
        x++;
      }
      if (count === runY.length) {
        runY = growInt32Array(runY);
        runStart = growInt32Array(runStart);
        runEnd = growInt32Array(runEnd);
        parent = growInt32Array(parent);
      }
      runY[count] = y;
      runStart[count] = start;
      runEnd[count] = x;
      parent[count] = count;

      // Merge with the runs of the previous row touching [start - 1, x + 1]
      // (8-connectivity), keeping the first run of a component as its root.
      while (prev < prevEnd && runEnd[prev] < start - 1) {
        prev++;
      }
      for (let i = prev; i < prevEnd && runStart[i] <= x + 1; i++) {
        const a = find(i),
          b = find(count);
        if (a !== b) {
          parent[Math.max(a, b)] = Math.min(a, b);
        }
      }
      count++;
    }
    prevFirst = rowFirst;
    prevEnd = count;
  }

  // Number the components in the order of their first run.
  const label = new Int32Array(count);
  let numComponents = 0;
  for (let i = 0; i < count; i++) {
    const root = find(i);
    label[i] = root === i ? numComponents++ : label[root];
  }
  numComponents = Math.min(numComponents, maxCount);

  // Since the runs are in raster order, so are the runs of each component.
  const lastY = new Int32Array(numComponents).fill(-1);
  const numRows = new Int32Array(numComponents);
  for (let i = 0; i < count; i++) {
    const c = label[i];
    if (c < numComponents && runY[i] !== lastY[c]) {
      lastY[c] = runY[i];
      numRows[c]++;
    }
  }
  const regions = Array.from(numRows, n => new Int32Array(4 * n));
  const length = new Int32Array(numComponents);
  lastY.fill(-1);
  for (let i = 0; i < count; i++) {
    const c = label[i];
    if (c >= numComponents) {
      continue;
    }
    const points = regions[c];
    if (runY[i] === lastY[c]) {
      // Another run on the same row: it's further right.
      points[length[c] - 2] = runEnd[i];
      continue;
    }
    lastY[c] = runY[i];
    const k = length[c];
    points[k] = runStart[i];
    points[k + 1] = points[k + 3] = runY[i];
    points[k + 2] = runEnd[i];
    length[c] += 4;
  }
  return regions;
}

/**
 * Andrew's monotone chain algorithm, for points sorted by (y, x).
 * @param {Int32Array} points - Interleaved x, y coordinates.
 * @returns {Int32Array} The interleaved coordinates of the hull vertices,
 *   without collinear points.
 */
function convexHull(points) {
  const n = points.length;
  const hull = new Int32Array(2 * n);
  let length = 0;
  for (const reverse of [false, true]) {
    const first = length;
    for (let k = 0; k < n; k += 2) {
      const i = reverse ? n - 2 - k : k;
      const x = points[i],
        y = points[i + 1];
      // Drop the last vertex while it doesn't make a strict turn.
      while (length >= first + 4) {
        const ox = hull[length - 4],
          oy = hull[length - 3];
        const cross =
          (hull[length - 2] - ox) * (y - oy) -
          (hull[length - 1] - oy) * (x - ox);
        if (cross > 0) {
          break;
        }
        length -= 2;
      }
      hull[length++] = x;
      hull[length++] = y;
    }
    // The last point of each chain is the first one of the other chain.
    length -= 2;
  }
  return hull.subarray(0, length);
}

/**
 * Minimum-area enclosing rectangle of a convex polygon (`cv2.minAreaRect`):
 * one of its sides is collinear with an edge of the polygon, hence try all of
 * them (the hulls of text regions only have a few dozen vertices).
 * @param {Int32Array} hull - Interleaved coordinates of at least 3 vertices.
 * @returns {object} The center (cx, cy), the unit vector (ux, uy) along the
 *   side of length `width`, and the length `height` of the other side.
 */
function minAreaRect(hull) {
  const n = hull.length;
  let rect = null,
    minArea = Infinity;

  for (let i = 0; i < n; i += 2) {
    const x0 = hull[i],
      y0 = hull[i + 1];
    const j = (i + 2) % n;
    const len = Math.hypot(hull[j] - x0, hull[j + 1] - y0);
    const ux = (hull[j] - x0) / len,
      uy = (hull[j + 1] - y0) / len;

    let minS = Infinity,
      maxS = -Infinity,
      minT = Infinity,
      maxT = -Infinity;
    for (let k = 0; k < n; k += 2) {
      const dx = hull[k] - x0,
        dy = hull[k + 1] - y0;
      // Coordinates along the edge and along its normal (-uy, ux).
      const s = dx * ux + dy * uy,
        t = dy * ux - dx * uy;
      minS = Math.min(minS, s);
      maxS = Math.max(maxS, s);
      minT = Math.min(minT, t);
      maxT = Math.max(maxT, t);
    }

    const area = (maxS - minS) * (maxT - minT);
    if (area < minArea) {
      minArea = area;
      const s = (minS + maxS) / 2,
        t = (minT + maxT) / 2;
      rect = {
        cx: x0 + s * ux - t * uy,
        cy: y0 + s * uy + t * ux,
        ux,
        uy,
        width: maxS - minS,
        height: maxT - minT,
      };
    }
  }
  return rect;
}

/**
 * @returns {Array<Array<number>>} The rectangle corners, in cyclic order.
 */
function rectCorners({ cx, cy, ux, uy, width, height }) {
  // Half of the two sides of the rectangle.
  const ax = (ux * width) / 2,
    ay = (uy * width) / 2;
  const bx = (-uy * height) / 2,
    by = (ux * height) / 2;
  return [
    [cx - ax - bx, cy - ay - by],
    [cx + ax - bx, cy + ay - by],
    [cx + ax + bx, cy + ay + by],
    [cx - ax + bx, cy - ay + by],
  ];
}

/**
 * Order the corners of a rectangle as top-left, top-right, bottom-right and
 * bottom-left, like PaddleOCR's `get_mini_boxes`: the top-left (resp.
 * top-right) corner is the upper one among the two leftmost (resp. rightmost)
 * corners. Hence the first side is the long one for horizontal-ish text, up to
 * steep angles, while it's the short one for vertical boxes.
 */
function orderCorners(corners) {
  const [p0, p1, p2, p3] = corners.toSorted((a, b) => a[0] - b[0]);
  const [topLeft, bottomLeft] = p1[1] > p0[1] ? [p0, p1] : [p1, p0];
  const [topRight, bottomRight] = p3[1] > p2[1] ? [p2, p3] : [p3, p2];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

/**
 * Mean probability inside a convex quad, like PaddleOCR's `box_score_fast`,
 * which rasterizes the quad (with its vertices truncated to integers) in a
 * mask covering the clipped bounding box.
 */
function boxScoreFast(prob, width, height, quad) {
  const xs = quad.map(p => p[0]),
    ys = quad.map(p => p[1]);
  const xMin = clamp(Math.floor(Math.min(...xs)), 0, width - 1);
  const xMax = clamp(Math.ceil(Math.max(...xs)), 0, width - 1);
  const yMin = clamp(Math.floor(Math.min(...ys)), 0, height - 1);
  const yMax = clamp(Math.ceil(Math.max(...ys)), 0, height - 1);
  const qx = xs.map(x => xMin + Math.trunc(x - xMin)),
    qy = ys.map(y => yMin + Math.trunc(y - yMin));

  let sum = 0,
    count = 0;
  for (let y = yMin; y <= yMax; y++) {
    // Horizontal extent of the quad on this row, edges included.
    let left = Infinity,
      right = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x0 = qx[i],
        y0 = qy[i],
        x1 = qx[(i + 1) % 4],
        y1 = qy[(i + 1) % 4];
      // Horizontal edges are covered by the adjacent ones.
      if (y0 === y1 || y < Math.min(y0, y1) || y > Math.max(y0, y1)) {
        continue;
      }
      const x = x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    const from = Math.max(Math.round(left), xMin),
      to = Math.min(Math.round(right), xMax);
    for (let i = y * width + from, end = y * width + to; i <= end; i++) {
      sum += prob[i];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * DB post-processing of the output of the detection model.
 * @param {Float32Array} prob - The probability map (the [1, 1, H, W] model
 *   output, already passed through a sigmoid).
 * @param {number} width - The width of the map.
 * @param {number} height - The height of the map.
 * @param {object} [options]
 * @param {number} [options.thresh] - Binarization threshold of the map.
 * @param {number} [options.boxThresh] - Minimum mean probability of a box.
 * @param {number} [options.unclipRatio] - How much the boxes are expanded.
 * @param {number} [options.maxCandidates] - Maximum number of text regions.
 * @param {number} [options.minSize] - Minimum length of the short box side.
 * @returns {Array<{points: Array<Array<number>>, score: number}>} The boxes,
 *   in reading order (see `sortBoxes`). The points are the top-left,
 *   top-right, bottom-right and bottom-left corners in the coordinates of the
 *   map, where (x, y) is the pixel at column x and row y (as for OpenCV
 *   contours), clipped to [0, width] x [0, height].
 */
function dbPostprocess(
  prob,
  width,
  height,
  {
    thresh = 0.3,
    boxThresh = 0.6,
    unclipRatio = 1.5,
    maxCandidates = 1000,
    minSize = 3,
  } = {}
) {
  const regions = findRegions(prob, width, height, thresh, maxCandidates);
  const boxes = [];
  for (const region of regions) {
    const hull = convexHull(region);
    if (hull.length < 6) {
      // A single pixel or a segment.
      continue;
    }
    const rect = minAreaRect(hull);
    if (Math.min(rect.width, rect.height) < minSize) {
      continue;
    }
    const score = boxScoreFast(prob, width, height, rectCorners(rect));
    if (score < boxThresh) {
      continue;
    }
    // The model predicts shrunk text regions: PaddleOCR expands them with an
    // offset of `distance` (using pyclipper), and then takes the minimum-area
    // rectangle of the result, which is the same rectangle with all its sides
    // moved outwards by `distance`.
    const distance =
      (rect.width * rect.height * unclipRatio) /
      (2 * (rect.width + rect.height));
    rect.width += 2 * distance;
    rect.height += 2 * distance;
    if (Math.min(rect.width, rect.height) < minSize + 2) {
      continue;
    }
    const points = orderCorners(rectCorners(rect)).map(([x, y]) => [
      clamp(x, 0, width),
      clamp(y, 0, height),
    ]);
    boxes.push({ points, score });
  }
  return sortBoxes(boxes);
}

/**
 * Sort boxes like PaddleOCR's `sorted_boxes`: from top to bottom, and from
 * left to right for the ones on the same line.
 */
function sortLines(boxes) {
  const sorted = boxes.toSorted(
    ({ points: [a] }, { points: [b] }) => a[1] - b[1] || a[0] - b[0]
  );
  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      const [x0, y0] = sorted[j].points[0],
        [x1, y1] = sorted[j + 1].points[0];
      if (Math.abs(y1 - y0) >= SAME_LINE_THRESHOLD || x1 >= x0) {
        break;
      }
      [sorted[j], sorted[j + 1]] = [sorted[j + 1], sorted[j]];
    }
  }
  return sorted;
}

/**
 * Find the widest gap between bounding boxes along an axis, i.e. a range of
 * coordinates covered by none of them.
 * @param {Array<object>} items - Objects with a `bbox` property, which is
 *   [minX, minY, maxX, maxY].
 * @param {number} axis - 0 for x, 1 for y.
 * @param {number} minGap - The minimum size of a gap (negative to accept some
 *   overlap).
 * @param {number} tolerance - Gaps whose sizes differ by less than this are
 *   considered as wide, and the first one is taken.
 * @returns {object | null} The size of the widest gap and the items before
 *   and after the gap that was taken, or null if there's no gap.
 */
function findWidestGap(items, axis, minGap, tolerance) {
  const sorted = items.toSorted((a, b) => a.bbox[axis] - b.bbox[axis]);
  const gaps = [];
  for (let i = 1, end = sorted[0].bbox[axis + 2]; i < sorted.length; i++) {
    const gap = sorted[i].bbox[axis] - end;
    if (gap >= minGap) {
      gaps.push({ gap, index: i });
    }
    end = Math.max(end, sorted[i].bbox[axis + 2]);
  }
  if (gaps.length === 0) {
    return null;
  }
  const widest = Math.max(...gaps.map(({ gap }) => gap));
  const { index } = gaps.find(({ gap }) => gap >= widest - tolerance);
  return {
    gap: widest,
    before: sorted.slice(0, index),
    after: sorted.slice(index),
  };
}

/**
 * Recursive XY-cut: split the items at their widest whitespace gap, either
 * horizontal (top part first) or vertical (left part first), until there are
 * no gaps left. Taking the widest gap, instead of always trying horizontal
 * gaps first, avoids cutting columns whose lines are aligned into rows; taking
 * the first one among the about as wide ones separates e.g. a heading touching
 * the columns below it before any of their lines.
 */
function xyCut(items, lineHeight, output) {
  const tolerance = ROW_OVERLAP * lineHeight;
  const rows = findWidestGap(items, 1, -tolerance, tolerance);
  const columns = findWidestGap(items, 0, COLUMN_GAP * lineHeight, tolerance);
  const cut = columns && (!rows || columns.gap > rows.gap) ? columns : rows;
  if (!cut) {
    output.push(...sortLines(items.map(item => item.box)));
    return;
  }
  xyCut(cut.before, lineHeight, output);
  xyCut(cut.after, lineHeight, output);
}

/**
 * Sort boxes in reading order.
 *
 * NOTE: PaddleOCR's `sorted_boxes` sorts all the boxes from top to bottom,
 * which interleaves the lines of multi-column text. Since this order is also
 * the text selection order, the boxes are instead first split into blocks
 * (e.g. columns) with a recursive XY-cut on their bounding boxes, and only the
 * boxes of each block are sorted like in PaddleOCR.
 * @param {Array<{points: Array<Array<number>>}>} boxes - The boxes, whose
 *   first point is the top-left corner.
 * @returns {Array<{points: Array<Array<number>>}>} A new sorted array.
 */
function sortBoxes(boxes) {
  if (boxes.length === 0) {
    return [];
  }
  const items = boxes.map(box => {
    const xs = box.points.map(p => p[0]),
      ys = box.points.map(p => p[1]);
    return {
      box,
      bbox: [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ],
    };
  });
  const heights = items
    .map(({ bbox }) => bbox[3] - bbox[1])
    .sort((a, b) => a - b);
  const output = [];
  xyCut(items, heights[Math.floor(heights.length / 2)], output);
  return output;
}

export { dbPostprocess, prepareDetInput, sortBoxes };
