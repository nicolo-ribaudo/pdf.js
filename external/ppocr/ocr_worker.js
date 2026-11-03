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

// PaddleOCR module worker, used by `PaddleOCRService` (see
// `paddle_ocr_service.js`): finds the text lines of a page image, then reads
// them, with PaddleOCR models running in ONNX Runtime Web (WebGPU or WASM). The
// detection model is loaded first; the recognition models (see `OCR_MODELS`)
// are loaded when a page needs them, and kept for the next pages. In automatic
// mode, the script of the lines is identified first (see `script_id.js`), and
// each line is read with the model of its script (see `SCRIPT_MODELS`).
//
// Messages from the main thread:
//  - { type: "init", backend: "auto" | "webgpu" | "wasm" }: load the runtime
//    and the detection model.
//  - { type: "ocr", jobId, bitmap, model }: recognize the text of the
//    (transferred) ImageBitmap, with the model of the given id or
//    `AUTO_OCR_MODEL`. Jobs run one at a time, in order.
//  - { type: "cancel", jobId }: stop the job at the next batch of lines, or
//    during the download of a recognition model.
// Messages to the main thread:
//  - { type: "progress", jobId?, stage, model?, loaded?, total?, done?,
//    count? }: the stages are "load-runtime", "download" and "compile" (for
//    the runtime and the detection model without `jobId`, or for the
//    recognition model `model` in a job), "detect", "identify" and
//    "recognize" (`done` lines of `count`).
//  - { type: "ready", backend, runtime, timings: { load, compile } }
//  - { type: "detected", jobId, boxes }: the line boxes, in reading order,
//    oriented like their text (TL, TR, BR, BL of the upright text).
//  - { type: "scripts", jobId, main, shares, models }: in automatic mode, the
//    main script of the page, the share of each script, and the ids of the
//    recognition models that read it (main first).
//  - { type: "lines", jobId, lines: [{ index, text, score, dir, model }] }:
//    the text in logical order, its direction ("ltr" or "rtl"), and the id of
//    the model that read it; in reading order.
//  - { type: "done", jobId, backend, runtime, models, timings: { det,
//    identify, load, rec, total } }: `models` are the ids of the models used.
//  - { type: "cancelled", jobId }
//  - { type: "error", jobId?, message, fatal }: `fatal` if the runtime or the
//    detection model can't be loaded.

/** @typedef {import("./ocr_models.js").OCRModel} OCRModel */
/** @typedef {import("./rec_postprocess.js").Quad} Quad */

/**
 * @typedef {object} OCREngine - The runtime and the detection model.
 * @property {object} ort - The ONNX Runtime Web module.
 * @property {string} runtime - Its build: "jspi" or "asyncify".
 * @property {string} backend - The backend in use: "webgpu" or "wasm".
 * @property {object} det - The text detection session.
 * @property {object} dbOptions - The `dbPostprocess` options for its output.
 */

/**
 * @typedef {object} Recognizer - A loaded text recognition model.
 * @property {OCRModel} model - The model description.
 * @property {object} session
 * @property {Array<string>} chars - The character table.
 */

/**
 * @typedef {object} OCRJob
 * @property {number} id
 * @property {ImageBitmap} bitmap
 * @property {string} model - A model id, or `AUTO_OCR_MODEL`.
 * @property {AbortController} controller - Aborted when the job is cancelled.
 */

import {
  AUTO_OCR_MODEL,
  DEFAULT_OCR_MODEL,
  DETECTION_MODEL,
  OCR_MODELS,
  REC_IMAGE_HEIGHT,
  SCRIPT_MODELS,
} from "./ocr_models.js";
import {
  classifyLineScript,
  decidePageScripts,
  pickSampleLines,
  routeLines,
} from "./script_id.js";
import {
  ctcDecode,
  getQuadRatio,
  getRecBatchWidth,
  getTextDirection,
  orientQuad,
  parseCharacterDict,
  parsePostProcessConfig,
  prepareRecBatch,
  toLogicalOrder,
} from "./rec_postprocess.js";
import { dbPostprocess, prepareDetInput } from "./det_postprocess.js";

const state = {
  // Resolves to the OCREngine (null if it couldn't be loaded), see `init`.
  engine: null,
  // The recognizers, loaded or being loaded: promises of Recognizer, by model
  // id.
  recognizers: new Map(),
  // The main script of the previous page read in automatic mode.
  lastScript: null,
  // Promise chain running the jobs one at a time.
  queue: Promise.resolve(),
  // The queued and running jobs, by id.
  jobs: new Map(),
};

/**
 * Downloads files, reporting the overall progress.
 * @param {Array<URL>} urls
 * @param {object} [progress] - Extra properties for the progress messages.
 * @param {AbortSignal} [signal] - Aborts the download.
 * @returns {Promise<Array<Uint8Array>>}
 */
async function download(urls, progress = {}, signal = undefined) {
  const responses = await Promise.all(urls.map(url => fetch(url, { signal })));
  let total = 0;
  for (const { ok, status, url, headers } of responses) {
    if (!ok) {
      throw new Error(`Failed to fetch ${url} (HTTP ${status}).`);
    }
    // The size is unknown if the body is compressed or has no length.
    total += headers.has("Content-Encoding")
      ? NaN
      : parseInt(headers.get("Content-Length"), 10);
  }
  total ||= 0;

  const step = total > 0 ? total / 100 : 2 ** 20;
  let loaded = 0,
    reported = -Infinity;
  const report = () => {
    self.postMessage({
      type: "progress",
      stage: "download",
      ...progress,
      loaded,
      total,
    });
    reported = loaded;
  };
  report();

  const files = await Promise.all(
    responses.map(async response => {
      const reader = response.body.getReader();
      const chunks = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        chunks.push(r.value);
        loaded += r.value.length;
        if (loaded - reported >= step) {
          report();
        }
      }
      return new Uint8Array(await new Blob(chunks).arrayBuffer());
    })
  );
  if (loaded > reported) {
    report();
  }
  return files;
}

/**
 * Reads the DB post-processing parameters of a detection model.
 * @param {Uint8Array} config - Its `inference.yml`.
 * @returns {object} The `dbPostprocess` options.
 */
function getDBOptions(config) {
  const params = parsePostProcessConfig(new TextDecoder().decode(config));
  const options = {
    thresh: Number(params.get("thresh")),
    boxThresh: Number(params.get("box_thresh")),
    unclipRatio: Number(params.get("unclip_ratio")),
    maxCandidates: Number(params.get("max_candidates")),
  };
  if (!Object.values(options).every(Number.isFinite)) {
    throw new Error("invalid DB post-processing parameters");
  }
  return options;
}

/**
 * Creates an inference session.
 * @param {object} ort - The ONNX Runtime Web module.
 * @param {Uint8Array} model - The ONNX model.
 * @param {string} backend - "webgpu" or "wasm".
 * @returns {Promise<object>}
 */
function createSession(ort, model, backend) {
  return ort.InferenceSession.create(model, {
    executionProviders: [backend],
    // Only log errors: loading the models causes some harmless warnings.
    logSeverityLevel: 3,
  });
}

/**
 * Creates the detection session on WebGPU if it's wanted and available,
 * otherwise on WASM. The recognition sessions then use the same backend.
 * @param {object} ort - The ONNX Runtime Web module.
 * @param {Uint8Array} model - The ONNX detection model.
 * @param {string} backend - The preferred backend: "auto", "webgpu" or
 *   "wasm".
 * @returns {Promise<{backend: string, det: object}>}
 */
async function createDetector(ort, model, backend) {
  if (backend !== "wasm") {
    try {
      if (!(await navigator.gpu?.requestAdapter())) {
        throw new Error("no adapter");
      }
      return {
        backend: "webgpu",
        det: await createSession(ort, model, "webgpu"),
      };
    } catch (error) {
      console.warn(`OCR: WebGPU is not available (${error}), using WASM.`);
    }
  }
  return { backend: "wasm", det: await createSession(ort, model, "wasm") };
}

/**
 * Loads ONNX Runtime Web. Both builds contain the WebGPU and the WASM backends,
 * and load their WebAssembly files from their own directory. The JSPI build is
 * much smaller, but it requires WebAssembly JavaScript Promise Integration;
 * otherwise the Asyncify build is used.
 * @returns {Promise<{ort: object, runtime: string}>} The ONNX Runtime Web
 *   module, and its build: "jspi" or "asyncify".
 */
async function loadRuntime() {
  if (
    typeof WebAssembly.Suspending === "function" &&
    typeof WebAssembly.promising === "function"
  ) {
    return {
      ort: await import("../../node_modules/onnxruntime-web/dist/ort.jspi.min.mjs"),
      runtime: "jspi",
    };
  }
  return {
    ort: await import("../../node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs"),
    runtime: "asyncify",
  };
}

/**
 * Loads ONNX Runtime and the detection model, reporting the progress.
 * @param {string} backend - The preferred backend.
 * @returns {Promise<OCREngine|null>} The engine, or null if loading failed
 *   (reported as a fatal error).
 */
async function init(backend) {
  try {
    const start = performance.now();
    self.postMessage({ type: "progress", stage: "load-runtime" });
    const { ort, runtime } = await loadRuntime();
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(4, Math.ceil(navigator.hardwareConcurrency / 2))
      : 1;
    ort.env.wasm.proxy = false;

    const [model, config] = await download([
      DETECTION_MODEL.url,
      DETECTION_MODEL.configUrl,
    ]);
    const dbOptions = getDBOptions(config);
    const loaded = performance.now();

    self.postMessage({ type: "progress", stage: "compile" });
    const detector = await createDetector(ort, model, backend);
    self.postMessage({
      type: "ready",
      backend: detector.backend,
      runtime,
      timings: { load: loaded - start, compile: performance.now() - loaded },
    });
    return { ort, runtime, dbOptions, ...detector };
  } catch (error) {
    self.postMessage({
      type: "error",
      message: `Cannot load the OCR models: ${error.message}`,
      fatal: true,
    });
    return null;
  }
}

/**
 * Starts loading the runtime and the detection model, unless it's already
 * started.
 * @param {string} backend - The preferred backend.
 * @returns {Promise<OCREngine|null>} See `init`.
 */
function ensureEngine(backend) {
  state.engine ??= init(backend);
  return state.engine;
}

/**
 * Loads a recognition model, reporting the progress.
 * @param {OCREngine} engine
 * @param {string} modelId
 * @param {OCRJob} job - The job that needs it; cancelling it aborts the
 *   download.
 * @returns {Promise<Recognizer>}
 */
async function loadRecognizer(engine, modelId, job) {
  const model = OCR_MODELS.get(modelId);
  const progress = { jobId: job.id, model: modelId };
  const [onnx, config] = await download(
    [model.rec.url, model.rec.configUrl],
    progress,
    job.controller.signal
  );
  const chars = parseCharacterDict(new TextDecoder().decode(config));

  self.postMessage({ type: "progress", stage: "compile", ...progress });
  const session = await createSession(engine.ort, onnx, engine.backend);
  // The output is [N, T, C], with one class per character.
  const classes = session.outputMetadata[0].shape[2];
  if (classes !== chars.length) {
    throw new Error(
      `The recognition model ${modelId} has ${classes} classes, but its ` +
        `dictionary has ${chars.length} characters.`
    );
  }
  return { model, session, chars };
}

/**
 * Gets a recognition model, loading it on first use.
 * @param {OCREngine} engine
 * @param {string} modelId
 * @param {OCRJob} job - The job that needs it.
 * @returns {Promise<Recognizer>}
 */
function getRecognizer(engine, modelId, job) {
  let recognizer = state.recognizers.get(modelId);
  if (!recognizer) {
    recognizer = loadRecognizer(engine, modelId, job);
    state.recognizers.set(modelId, recognizer);
    // Retry on next use if loading failed (e.g. if the job was cancelled).
    recognizer.catch(() => state.recognizers.delete(modelId));
  }
  return recognizer;
}

/**
 * Gets some recognition models, loading them one after the other.
 * @param {OCREngine} engine
 * @param {Array<string>} modelIds
 * @param {OCRJob} job - The job that needs them.
 * @returns {Promise<Map<string, Recognizer>>} The recognizers by model id.
 */
async function getRecognizers(engine, modelIds, job) {
  const recognizers = new Map();
  for (const modelId of modelIds) {
    recognizers.set(modelId, await getRecognizer(engine, modelId, job));
  }
  return recognizers;
}

/**
 * Runs a model with a single input and output.
 * @param {object} session
 * @param {object} input - The input tensor.
 * @returns {Promise<object>} The output tensor.
 */
async function run(session, input) {
  const outputs = await session.run({ x: input });
  return outputs[session.outputNames[0]];
}

/**
 * Computes the size of the detection input (PaddleOCR `DetResizeForTest`):
 * the image is downscaled to fit in `maxSideLen`, and each side is rounded
 * to a multiple of 32.
 * @param {ImageBitmap} bitmap
 * @param {number} maxSideLen
 * @returns {{width: number, height: number}}
 */
function getDetInputSize(bitmap, maxSideLen) {
  const ratio = Math.min(1, maxSideLen / Math.max(bitmap.width, bitmap.height));
  const round = size =>
    Math.max(32, Math.round(Math.trunc(size * ratio) / 32) * 32);
  return { width: round(bitmap.width), height: round(bitmap.height) };
}

/**
 * Finds the text lines of an image.
 * @param {OCREngine} engine
 * @param {ImageBitmap} bitmap
 * @returns {Promise<Array<Quad>>} The line boxes, in bitmap pixels, oriented
 *   like their text (see `orientQuad`), in reading order.
 */
async function detect(engine, bitmap) {
  const { width, height } = getDetInputSize(bitmap, DETECTION_MODEL.maxSideLen);
  const ctx = new OffscreenCanvas(width, height).getContext("2d", {
    willReadFrequently: true,
  });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const input = new engine.ort.Tensor(
    "float32",
    prepareDetInput(data, width, height),
    [1, 3, height, width]
  );
  const prob = await run(engine.det, input);
  const boxes = dbPostprocess(prob.data, width, height, engine.dbOptions);

  // Point (x, y) of the map is the center of the pixel [x, x + 1] x [y, y + 1].
  const scaleX = bitmap.width / width,
    scaleY = bitmap.height / height;
  return boxes.map(({ points }) =>
    orientQuad(
      points.map(([x, y]) => [
        Math.min((x + 0.5) * scaleX, bitmap.width),
        Math.min((y + 0.5) * scaleY, bitmap.height),
      ])
    )
  );
}

/**
 * Extracts a text line from an image, straightened and scaled.
 * @param {ImageBitmap} bitmap
 * @param {Quad} quad - The line box, oriented like its text.
 * @param {number} width - The width of the line image.
 * @param {number} height - The height of the line image.
 * @returns {ImageData}
 */
function cropLine(bitmap, quad, width, height) {
  const [topLeft, topRight, , bottomLeft] = quad;
  const ctx = new OffscreenCanvas(width, height).getContext("2d", {
    willReadFrequently: true,
  });
  // Maps the line image onto the line in the bitmap: drawing the bitmap
  // through the inverse transform straightens the line.
  const lineToBitmap = new DOMMatrix([
    (topRight[0] - topLeft[0]) / width,
    (topRight[1] - topLeft[1]) / width,
    (bottomLeft[0] - topLeft[0]) / height,
    (bottomLeft[1] - topLeft[1]) / height,
    topLeft[0],
    topLeft[1],
  ]);
  ctx.setTransform(lineToBitmap.inverse());
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Extracts all the text lines from an image, as the recognition models read
 * them: straightened, and scaled to their input height.
 * @param {ImageBitmap} bitmap
 * @param {Array<Quad>} boxes
 * @returns {Array<ImageData>}
 */
function cropLines(bitmap, boxes) {
  return boxes.map(box => {
    const width = Math.ceil(REC_IMAGE_HEIGHT * getQuadRatio(box));
    return cropLine(bitmap, box, width, REC_IMAGE_HEIGHT);
  });
}

/**
 * Identifies the script of the lines (automatic mode), to choose the model
 * that reads each of them. Only the longest lines are classified, unless the
 * page looks mixed.
 * @param {Array<ImageData>} images - The line images.
 * @returns {{main: string|null, shares: object, lineModels: Array<string>,
 *   models: Array<string>}} The main script and the share of each script,
 *   the id of the model of each line, and the ids of the models used (main
 *   first).
 */
function identifyScripts(images) {
  const results = new Array(images.length).fill(null);
  for (const i of pickSampleLines(images.map(image => image.width))) {
    results[i] = classifyLineScript(images[i]);
  }
  let decision = decidePageScripts(results, state.lastScript);
  if (decision.mixed) {
    for (const [i, image] of images.entries()) {
      results[i] ??= classifyLineScript(image);
    }
    decision = decidePageScripts(results, state.lastScript);
  }
  state.lastScript = decision.main ?? state.lastScript;

  const lineModels = routeLines(results, decision).map(script =>
    SCRIPT_MODELS.get(script)
  );
  const models = decision.scripts
    .map(script => SCRIPT_MODELS.get(script))
    .filter(modelId => lineModels.includes(modelId));
  return { main: decision.main, shares: decision.shares, lineModels, models };
}

/**
 * Chooses the model that reads each line: the job's model, or in automatic
 * mode the model of the line's script (reported with a "scripts" message).
 * @param {OCRJob} job
 * @param {Array<ImageData>} images - The line images.
 * @returns {{lineModels: Array<string>, models: Array<string>}} The id of
 *   the model of each line, and the ids of the models used.
 */
function chooseModels(job, images) {
  if (job.model !== AUTO_OCR_MODEL) {
    return {
      lineModels: images.map(() => job.model),
      models: images.length > 0 ? [job.model] : [],
    };
  }
  self.postMessage({ type: "progress", jobId: job.id, stage: "identify" });
  const { main, shares, lineModels, models } = identifyScripts(images);
  self.postMessage({ type: "scripts", jobId: job.id, main, shares, models });
  return { lineModels, models };
}

/**
 * Reads some text lines, with a single model run.
 * @param {OCREngine} engine
 * @param {Recognizer} recognizer
 * @param {Array<ImageData>} images - The line images.
 * @returns {Promise<Array<{text: string, score: number}>>}
 */
async function recognizeBatch(engine, recognizer, images) {
  const { baseWidth, rightToLeft } = recognizer.model.rec;
  const height = REC_IMAGE_HEIGHT;
  const width = getRecBatchWidth(
    images.map(image => image.width),
    baseWidth
  );
  const input = new engine.ort.Tensor(
    "float32",
    prepareRecBatch(images, height, width),
    [images.length, 3, height, width]
  );
  const output = await run(recognizer.session, input);
  const results = ctcDecode(output.data, output.dims, recognizer.chars);
  if (rightToLeft) {
    for (const result of results) {
      result.text = toLogicalOrder(result.text);
    }
  }
  return results;
}

/**
 * Reads the lines in reading order, batching consecutive lines read by the
 * same model, and sends the results of each batch.
 * @param {OCREngine} engine
 * @param {OCRJob} job
 * @param {Array<ImageData>} images - The line images; they're released once
 *   read.
 * @param {Array<string>} lineModels - The id of the model of each line.
 * @param {Map<string, Recognizer>} recognizers - The recognizers by model id.
 * @returns {Promise<boolean>} False if the job was cancelled.
 */
async function recognize(engine, job, images, lineModels, recognizers) {
  for (let start = 0; start < images.length;) {
    if (job.controller.signal.aborted) {
      return false;
    }
    const modelId = lineModels[start];
    const recognizer = recognizers.get(modelId);
    const batchSize = recognizer.model.rec.batchSize[engine.backend];
    let end = start + 1;
    while (
      end < images.length &&
      end - start < batchSize &&
      lineModels[end] === modelId
    ) {
      end++;
    }
    const results = await recognizeBatch(
      engine,
      recognizer,
      images.slice(start, end)
    );
    images.fill(null, start, end);

    self.postMessage({
      type: "lines",
      jobId: job.id,
      lines: results.map(({ text, score }, i) => ({
        index: start + i,
        text,
        score,
        dir: getTextDirection(text),
        model: modelId,
      })),
    });
    self.postMessage({
      type: "progress",
      jobId: job.id,
      stage: "recognize",
      done: end,
      count: images.length,
    });
    start = end;
  }
  return true;
}

/**
 * Runs an OCR job: text detection, script identification in automatic mode,
 * loading of the recognition models if needed, and recognition. The timings
 * sent with "done" cover the job itself, not the wait for the runtime or for
 * other jobs.
 * @param {OCREngine} engine
 * @param {OCRJob} job
 */
async function runJob(engine, job) {
  const jobId = job.id;
  if (job.model !== AUTO_OCR_MODEL && !OCR_MODELS.has(job.model)) {
    throw new Error(`Unknown OCR model "${job.model}".`);
  }
  const timings = { det: 0, identify: 0, load: 0, rec: 0, total: 0 };
  const start = performance.now();
  let time = start;
  const lap = () => {
    const now = performance.now();
    const elapsed = now - time;
    time = now;
    return elapsed;
  };

  self.postMessage({ type: "progress", jobId, stage: "detect" });
  const boxes = await detect(engine, job.bitmap);
  self.postMessage({ type: "detected", jobId, boxes });
  timings.det = lap();

  const images = cropLines(job.bitmap, boxes);
  timings.rec = lap();

  const { lineModels, models } = chooseModels(job, images);
  timings.identify = lap();

  const recognizers = await getRecognizers(engine, models, job);
  timings.load = lap();

  if (!(await recognize(engine, job, images, lineModels, recognizers))) {
    self.postMessage({ type: "cancelled", jobId });
    return;
  }
  timings.rec += lap();
  timings.total = performance.now() - start;
  self.postMessage({
    type: "done",
    jobId,
    backend: engine.backend,
    runtime: engine.runtime,
    models,
    timings,
  });
}

/**
 * Runs an OCR job once the engine is ready, and reports its errors.
 * @param {OCRJob} job
 */
async function processJob(job) {
  const jobId = job.id;
  try {
    const engine = await ensureEngine("auto");
    if (!engine) {
      self.postMessage({
        type: "error",
        jobId,
        message: "The OCR models are not available.",
        fatal: true,
      });
    } else if (job.controller.signal.aborted) {
      self.postMessage({ type: "cancelled", jobId });
    } else {
      await runJob(engine, job);
    }
  } catch (error) {
    // Cancelling a job aborts the download of the models it needs.
    self.postMessage(
      job.controller.signal.aborted
        ? { type: "cancelled", jobId }
        : { type: "error", jobId, message: error.message, fatal: false }
    );
  } finally {
    job.bitmap.close();
    state.jobs.delete(jobId);
  }
}

self.addEventListener("message", ({ data }) => {
  switch (data.type) {
    case "init":
      ensureEngine(data.backend);
      break;
    case "ocr": {
      const job = {
        id: data.jobId,
        bitmap: data.bitmap,
        model: data.model ?? DEFAULT_OCR_MODEL,
        controller: new AbortController(),
      };
      state.jobs.set(job.id, job);
      state.queue = state.queue.then(() => processJob(job));
      break;
    }
    case "cancel":
      state.jobs.get(data.jobId)?.controller.abort();
      break;
  }
});
