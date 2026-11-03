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

// An example of text recognition (OCR) service, see
// `web/text_recognition_service.js`: it isn't part of PDF.js, which only
// defines the interface that embedders implement. The development viewer
// uses it for its OCR demo (see `web/genericcom.js`).
//
// It runs PaddleOCR PP-OCRv5 models with ONNX Runtime Web, in a module worker
// (`ocr_worker.js`): a text detection model, and recognition models for
// several scripts, which are loaded the first time a page needs them. In
// automatic mode, the worker identifies the script of the lines to choose
// their recognition model (`script_id.js`).

import { BaseTextRecognitionService } from "../../web/text_recognition_service.js";
import { OCR_MODELS } from "./ocr_models.js";

const BACKEND_NAMES = { webgpu: "WebGPU", wasm: "WASM" };
const RUNTIME_NAMES = { jspi: "JSPI", asyncify: "Asyncify" };

/**
 * @typedef {object} PaddleOCRJob
 * @property {number} id
 * @property {object} params - The `recognize` parameters.
 * @property {Array<Array<Array<number>>>} quads - The detected lines.
 * @property {Array<object>} lines - The recognized lines.
 * @property {Array<string>} models - The names of the models in use.
 * @property {function(object): void} resolve
 * @property {function(Error): void} reject
 */

/**
 * @param {string} modelId
 * @returns {string} The name of the model.
 */
function getModelName(modelId) {
  return OCR_MODELS.get(modelId)?.name ?? modelId;
}

/**
 * @returns {DOMException}
 */
function createAbortError() {
  return new DOMException("The text recognition was cancelled.", "AbortError");
}

/**
 * Waits for a promise, unless a signal is aborted first.
 * @param {Promise} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise} Rejects with an `AbortError` if the signal is aborted.
 */
function waitUnlessAborted(promise, signal) {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * A text recognition service running PaddleOCR in a worker.
 */
class PaddleOCRService extends BaseTextRecognitionService {
  #backend;

  #worker = null;

  // The job sent to the worker and not finished yet.
  #job = null;

  #nextJobId = 0;

  // Resolves when the previous `recognize` call is finished.
  #queue = Promise.resolve();

  /**
   * @param {object} [options]
   * @param {string} [options.backend] - "webgpu", "wasm", or "auto" (the
   *   default) to use WebGPU when it's available.
   */
  constructor({ backend } = {}) {
    super();
    this.#backend = backend || "auto";
  }

  get models() {
    return Array.from(OCR_MODELS, ([id, { name, languages }]) => ({
      id,
      name,
      description: languages,
    }));
  }

  get supportsAutomaticModel() {
    return true;
  }

  /**
   * Recognizes the text of an image; the calls are queued and run one at a
   * time.
   * @param {ImageBitmap} image
   * @param {object} params - See `TextRecognitionParameters`.
   * @returns {Promise<object>} See `TextRecognitionResult`.
   */
  async recognize(image, params) {
    // The next call waits for this one, and for the previous ones.
    const previous = this.#queue;
    const { promise: finished, resolve: finish } = Promise.withResolvers();
    this.#queue = Promise.all([previous, finished]);
    try {
      await waitUnlessAborted(previous, params.signal);
    } catch (error) {
      image.close();
      finish();
      throw error;
    }
    try {
      return await this.#run(image, params);
    } finally {
      finish();
    }
  }

  destroy() {
    this.#terminate(createAbortError());
  }

  /**
   * Sends a job to the worker, and waits for its result.
   * @param {ImageBitmap} image
   * @param {object} params
   * @returns {Promise<object>}
   */
  #run(image, params) {
    const { model = null, signal } = params;
    if (signal?.aborted) {
      image.close();
      return Promise.reject(createAbortError());
    }
    const worker = this.#ensureWorker();
    const { promise, resolve, reject } = Promise.withResolvers();
    const job = (this.#job = {
      id: this.#nextJobId++,
      params,
      quads: [],
      lines: [],
      models: model ? [getModelName(model)] : [],
      resolve,
      reject,
    });
    worker.postMessage(
      { type: "ocr", jobId: job.id, bitmap: image, model: model ?? "auto" },
      [image]
    );

    // Cancel the job in the worker, but don't wait for it to stop.
    const onAbort = () => {
      worker.postMessage({ type: "cancel", jobId: job.id });
      this.#finish(job, createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    return promise.finally(() => {
      signal?.removeEventListener("abort", onAbort);
    });
  }

  /**
   * @returns {Worker} The worker, created (and initialized) if needed.
   */
  #ensureWorker() {
    if (!this.#worker) {
      const worker = (this.#worker = new Worker(
        new URL("./ocr_worker.js", import.meta.url),
        { type: "module", name: "pdfjs-ocr" }
      ));
      worker.addEventListener("message", ({ data }) => this.#onMessage(data));
      worker.addEventListener("error", event => {
        event.preventDefault();
        this.#terminate(new Error(event.message || "The OCR worker failed."));
      });
      worker.postMessage({ type: "init", backend: this.#backend });
    }
    return this.#worker;
  }

  /**
   * Terminates the worker (it's recreated if needed), and fails its job.
   * @param {Error} error
   */
  #terminate(error) {
    this.#worker?.terminate();
    this.#worker = null;
    if (this.#job) {
      this.#finish(this.#job, error);
    }
  }

  /**
   * Settles a job.
   * @param {PaddleOCRJob} job
   * @param {Error|null} error
   * @param {object} [result]
   */
  #finish(job, error, result) {
    if (this.#job !== job) {
      return;
    }
    this.#job = null;
    if (error) {
      job.reject(error);
    } else {
      job.resolve(result);
    }
  }

  /**
   * @param {object} data - A message from the worker.
   */
  #onMessage(data) {
    const job = this.#job;
    // Ignore the "ready" message, and the messages of the cancelled jobs.
    if (!job || (data.jobId !== undefined && data.jobId !== job.id)) {
      return;
    }
    const { onProgress, onLinesDetected, onLinesRecognized } = job.params;
    switch (data.type) {
      case "progress":
        onProgress?.(this.#getProgress(job, data));
        break;
      case "detected":
        job.quads = data.boxes;
        onLinesDetected?.(job.quads);
        break;
      case "scripts":
        job.models = data.models.map(getModelName);
        break;
      case "lines": {
        const lines = data.lines
          .filter(({ text }) => text.trim())
          .map(({ index, text, score, dir }) => ({
            index,
            quad: job.quads[index],
            text,
            dir,
            confidence: score,
          }));
        job.lines.push(...lines);
        if (lines.length > 0) {
          onLinesRecognized?.(lines);
        }
        break;
      }
      case "done":
        this.#finish(job, null, {
          lines: job.lines,
          models: data.models.map(getModelName),
          engine: BACKEND_NAMES[data.backend] ?? data.backend,
          details: this.#getDetails(data),
        });
        break;
      case "cancelled":
        this.#finish(job, createAbortError());
        break;
      case "error":
        if (data.fatal) {
          this.#terminate(new Error(data.message));
        } else {
          this.#finish(job, new Error(data.message));
        }
        break;
    }
  }

  /**
   * Converts a "progress" message of the worker.
   * @param {PaddleOCRJob} job
   * @param {object} data
   * @returns {object} See `TextRecognitionProgress`.
   */
  #getProgress(job, data) {
    const { stage, model, loaded, total, done, count } = data;
    const name = model && getModelName(model);
    switch (stage) {
      case "load-runtime":
        return { stage: "loading" };
      case "download":
        return { stage: "loading", model: name, loaded, total };
      case "compile":
        return { stage: "preparing", model: name };
      case "detect":
        return { stage: "detecting" };
      case "identify":
        return { stage: "identifying" };
      default:
        return { stage: "recognizing", done, count, models: job.models };
    }
  }

  /**
   * @param {object} data - The "done" message of the worker.
   * @returns {string} The timings of the job, and how the models ran.
   */
  #getDetails(data) {
    const { backend, runtime, timings } = data;
    const ms = value => `${Math.round(value)} ms`;
    const parts = [`detection ${ms(timings.det)}`];
    if (timings.identify >= 1) {
      parts.push(`script identification ${ms(timings.identify)}`);
    }
    if (timings.load >= 1) {
      parts.push(`model loading ${ms(timings.load)}`);
    }
    parts.push(`recognition ${ms(timings.rec)}`);
    const engine =
      `${BACKEND_NAMES[backend] ?? backend}, ` +
      `${RUNTIME_NAMES[runtime] ?? runtime} build of ONNX Runtime Web`;
    return `${parts.join(", ")} (${engine})`;
  }
}

export { PaddleOCRService };
