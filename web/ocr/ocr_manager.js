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

/** @typedef {import("../event_utils.js").EventBus} EventBus */
/** @typedef {import("../pdf_page_view.js").PDFPageView} PDFPageView */
/** @typedef {import("../pdf_viewer.js").PDFViewer} PDFViewer */
// eslint-disable-next-line max-len
/** @typedef {import("../text_recognition_service.js").BaseTextRecognitionService} BaseTextRecognitionService */
// eslint-disable-next-line max-len
/** @typedef {import("../text_recognition_service.js").RecognizedLine} RecognizedLine */
// eslint-disable-next-line max-len
/** @typedef {import("../text_recognition_service.js").TextRecognitionProgress} TextRecognitionProgress */

import {
  getOCRViewport,
  quadToPagePoints,
  quadToTextItem,
} from "./ocr_geometry.js";
import { AnnotationMode } from "pdfjs-lib";
import { internalOpt } from "../internal_evt.js";
import { OCRPageLayer } from "./ocr_page_layer.js";
import { parseQueryString } from "../ui_utils.js";
import { RenderingStates } from "../renderable_view.js";

// Recognized lines with a lower confidence are not added to the text layer.
const MIN_CONFIDENCE = 0.5;

const DOCUMENT_STATUS_L10N_IDS = {
  running: "pdfjs-ocr-document-status-running",
  done: "pdfjs-ocr-document-status-done",
  nothing: "pdfjs-ocr-document-status-nothing",
};

/**
 * @typedef {object} PDFOCRManagerOptions
 * @property {BaseTextRecognitionService} service - The OCR engine, provided by
 *   the embedder.
 * @property {EventBus} eventBus - The application event bus.
 * @property {PDFViewer} pdfViewer - The PDF viewer.
 * @property {HTMLElement} [toolbar] - The toolbar container where the button
 *   to recognize the text of all the pages is added.
 * @property {AbortSignal} [abortSignal] - Removes all the listeners, and
 *   destroys the service, once aborted.
 */

/**
 * The toolbar button to recognize the text of all the pages, and its status.
 */
class OCRDocumentControls {
  #button;

  #label;

  #status;

  /**
   * @param {HTMLElement} container
   * @param {Function} onClick
   * @param {AbortSignal} [abortSignal]
   */
  constructor(container, onClick, abortSignal) {
    const button = (this.#button = document.createElement("button"));
    button.id = "ocrDocumentButton";
    button.className = "toolbarButton";
    button.type = "button";
    button.tabIndex = 0;
    button.addEventListener("click", onClick, { signal: abortSignal });
    this.#label = document.createElement("span");
    button.append(this.#label);

    const status = (this.#status = document.createElement("span"));
    status.id = "ocrDocumentStatus";
    status.className = "toolbarLabel";
    status.setAttribute("role", "status");

    const group = document.createElement("div");
    group.id = "ocrDocumentControls";
    group.className = "toolbarHorizontalGroup";
    group.append(button, status);
    const separator = document.createElement("div");
    separator.className = "verticalToolbarSeparator";
    container.prepend(group, separator);

    this.setState("idle");
  }

  /**
   * @param {boolean} disabled
   */
  setDisabled(disabled) {
    this.#button.disabled = disabled;
  }

  /**
   * @param {string} state - "idle", "running", "done" or "nothing" (all the
   *   pages were already recognized); the last two are idle too.
   * @param {object} [args] - The arguments of the status message.
   */
  setState(state, args = null) {
    const running = state === "running";
    this.#button.classList.toggle("toggled", running);
    this.#button.setAttribute(
      "data-l10n-id",
      running ? "pdfjs-ocr-document-cancel-button" : "pdfjs-ocr-document-button"
    );
    this.#label.setAttribute(
      "data-l10n-id",
      running
        ? "pdfjs-ocr-document-cancel-button-label"
        : "pdfjs-ocr-document-button-label"
    );

    const status = this.#status;
    status.setAttribute("data-state", state);
    if (state === "idle") {
      status.removeAttribute("data-l10n-id");
      status.textContent = "";
      return;
    }
    status.setAttribute("data-l10n-id", DOCUMENT_STATUS_L10N_IDS[state]);
    status.setAttribute("data-l10n-args", JSON.stringify(args ?? {}));
  }
}

/**
 * The user interface of text recognition (OCR) in PDF.js: every page gets an
 * "OCR" button, and the toolbar one for all the pages. A page is rendered to
 * an image, whose text is recognized by the `BaseTextRecognitionService` that
 * the embedder provides (PDF.js doesn't contain any OCR engine), and the
 * recognized lines are streamed into an OCR text layer, where the text can be
 * selected and copied.
 *
 * Pages are processed one at a time; the OCR layers are kept for each page
 * view, see `PDFPageView.addOCRLayer`, until the document is closed. The model
 * is chosen with a menu next to the button, if the service offers a choice, or
 * with the `#ocrmodel=auto|<id>` hash parameter.
 */
class PDFOCRManager {
  #abortSignal = null;

  #activeJob = null;

  #documentControls = null;

  #documentRun = null;

  #layers = new Map();

  // The id of the selected model, or `null` to let the service choose.
  #model = null;

  #models = [];

  #pdfViewer = null;

  #queue = [];

  #service = null;

  /**
   * @param {PDFOCRManagerOptions} options
   */
  constructor({
    service,
    eventBus,
    pdfViewer,
    toolbar = null,
    abortSignal = null,
  }) {
    this.#service = service;
    this.#pdfViewer = pdfViewer;
    this.#abortSignal = abortSignal;

    // The automatic choice comes first, and is the default.
    const { models, supportsAutomaticModel } = service;
    this.#models = supportsAutomaticModel ? [null, ...models] : models;
    if (this.#models.length === 0) {
      throw new Error("PDFOCRManager: the service has no models.");
    }
    this.#model = this.#models[0]?.id ?? null;
    const model = parseQueryString(document.location.hash.substring(1)).get(
      "ocrmodel"
    );
    if (model === "auto" ? supportsAutomaticModel : this.#getModel(model)) {
      this.#model = model === "auto" ? null : model;
    }

    // The styles aren't part of `viewer.css`, to keep the builds unchanged.
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./ocr.css", import.meta.url);
    document.head.append(link);

    const opts = { signal: abortSignal, ...internalOpt };
    eventBus.on("pagerender", this.#onPageRender.bind(this), opts);
    eventBus.on(
      "textlayerrendered",
      this.#onTextLayerRendered.bind(this),
      opts
    );
    eventBus.on("rotationchanging", this.#onRotationChanging.bind(this), opts);
    eventBus.on("pagesdestroy", this.#onPagesDestroy.bind(this), opts);
    if (toolbar) {
      this.#documentControls = new OCRDocumentControls(
        toolbar,
        this.#onDocumentButtonClick.bind(this),
        abortSignal
      );
      this.#documentControls.setDisabled(pdfViewer.pagesCount === 0);
      eventBus.on(
        "pagesinit",
        () => this.#documentControls.setDisabled(false),
        opts
      );
    }
    abortSignal?.addEventListener("abort", () => service.destroy(), {
      once: true,
    });

    // This class is loaded lazily, hence some pages may already be rendered.
    for (const pageView of pdfViewer.getCachedPageViews()) {
      if (pageView.renderingState !== RenderingStates.INITIAL) {
        this.#ensureLayer(pageView);
        if (pageView.textLayer?.div.isConnected) {
          this.#onTextLayerRendered({ source: pageView });
        }
      }
    }
  }

  #getModel(id) {
    return this.#models.find(model => model && model.id === id);
  }

  /**
   * @param {PDFPageView} pageView
   * @returns {OCRPageLayer}
   */
  #ensureLayer(pageView) {
    if (this.#layers.has(pageView)) {
      return this.#layers.get(pageView);
    }
    const layer = new OCRPageLayer({
      onClick: () => this.#onButtonClick(pageView, layer),
      models: this.#models,
      model: this.#model,
      onModelChange: model => this.#setModel(model),
      abortSignal: this.#abortSignal,
    });
    this.#layers.set(pageView, layer);
    pageView.addOCRLayer(layer.div);
    return layer;
  }

  /**
   * The same model is used for all the pages: update their model menus.
   * @param {string|null} model - The id of the model, `null` for automatic.
   */
  #setModel(model) {
    this.#model = model;
    for (const layer of this.#layers.values()) {
      layer.setModel(model);
    }
  }

  #onPageRender({ source, pageNumber }) {
    // Ignore e.g. the detail views of the pages.
    if (source === this.#pdfViewer.getPageView(pageNumber - 1)) {
      this.#ensureLayer(source);
    }
  }

  #onTextLayerRendered({ source }) {
    this.#layers
      .get(source)
      ?.setNativeText(!!source.textLayer?.div.textContent.trim());
  }

  #onRotationChanging() {
    for (const [pageView, layer] of this.#layers) {
      layer.updateRotation(pageView.viewport.rotation);
    }
  }

  #onPagesDestroy() {
    this.#resetDocumentRun();
    this.#documentControls?.setDisabled(true);
    // Cancel the queued jobs first, since cancelling the active one may start
    // the next one.
    for (const job of [...this.#queue, this.#activeJob]) {
      if (job && !job.cancelled) {
        this.#cancelJob(job);
      }
    }
    for (const layer of this.#layers.values()) {
      layer.clear();
    }
    this.#layers.clear();
  }

  #findJob(layer) {
    return [this.#activeJob, ...this.#queue].find(
      job => job?.layer === layer && !job.cancelled
    );
  }

  #onButtonClick(pageView, layer) {
    const job = this.#findJob(layer);
    if (job) {
      this.#cancelJob(job);
    }
    if (job || layer.state === "done") {
      layer.clear();
      layer.setState("idle");
      return;
    }
    this.#queueJob(pageView, layer);
  }

  /**
   * Recognize the text of all the pages, but the ones already recognized, or
   * being recognized; or cancel it, if it's running.
   */
  #onDocumentButtonClick() {
    const runningJobs = this.#documentRun?.jobs;
    if (runningJobs) {
      this.#resetDocumentRun();
      // Cancel the queued jobs first, see `#onPagesDestroy`.
      for (const job of [...runningJobs].reverse()) {
        this.#cancelJob(job);
        job.layer.clear();
        job.layer.setState("idle");
      }
      return;
    }
    const pagesCount = this.#pdfViewer.pagesCount;
    const run = {
      jobs: new Set(),
      total: 0,
      pages: 0,
      lines: 0,
      startTime: performance.now(),
    };
    for (let i = 0; i < pagesCount; i++) {
      const pageView = this.#pdfViewer.getPageView(i);
      // The pages that were never displayed get a layer too, so that they
      // show the results once displayed.
      const layer = this.#ensureLayer(pageView);
      if (layer.state !== "done" && !this.#findJob(layer)) {
        run.jobs.add(this.#queueJob(pageView, layer, run));
      }
    }
    run.total = run.jobs.size;
    if (run.total === 0) {
      this.#documentControls.setState("nothing");
      return;
    }
    this.#documentRun = run;
    this.#updateDocumentRun();
  }

  /**
   * Called when a job ends, whatever the reason.
   */
  #onJobEnd(job) {
    const run = job.documentRun;
    if (run !== this.#documentRun || !run?.jobs.delete(job)) {
      return;
    }
    if (job.layer.state === "done") {
      run.pages++;
      run.lines += job.appendedCount;
    }
    this.#updateDocumentRun();
  }

  #updateDocumentRun() {
    const run = this.#documentRun;
    if (run.jobs.size > 0) {
      this.#documentControls.setState("running", {
        done: run.total - run.jobs.size,
        total: run.total,
      });
      return;
    }
    this.#documentRun = null;
    if (run.pages === 0) {
      this.#documentControls.setState("idle");
      return;
    }
    this.#documentControls.setState("done", {
      pages: run.pages,
      lines: run.lines,
      duration: Math.round((performance.now() - run.startTime) / 1000),
    });
  }

  #resetDocumentRun() {
    this.#documentRun = null;
    this.#documentControls?.setState("idle");
  }

  /**
   * @returns {object} The job.
   */
  #queueJob(pageView, layer, documentRun = null) {
    const job = {
      pageView,
      layer,
      // The model selected when the page was queued.
      model: this.#model,
      abortController: new AbortController(),
      cancelled: false,
      // The viewport used to render the image.
      viewport: null,
      lineCount: 0,
      recognizedCount: 0,
      appendedCount: 0,
      // The names of the models in use.
      models: null,
      // When recognizing the text of all the pages.
      documentRun,
    };
    this.#queue.push(job);
    layer.setState("queued");
    this.#runNext();
    return job;
  }

  #cancelJob(job) {
    job.cancelled = true;
    job.abortController.abort();
    this.#onJobEnd(job);

    if (job !== this.#activeJob) {
      this.#queue.splice(this.#queue.indexOf(job), 1);
    }
    // Otherwise, the next job starts once the service stopped.
  }

  async #runNext() {
    if (this.#activeJob || this.#queue.length === 0) {
      return;
    }
    const job = (this.#activeJob = this.#queue.shift());
    try {
      await this.#run(job);
    } catch (ex) {
      if (!job.cancelled) {
        job.layer.clear();
        job.layer.setState("error", { message: ex.message });
        this.#onJobEnd(job);
      }
    }
    this.#activeJob = null;
    this.#runNext();
  }

  async #run(job) {
    const { abortController, layer, pageView } = job;
    const startTime = performance.now();
    layer.setState("rendering");

    const { bitmap, viewport } = await this.#renderPage(job);
    if (job.cancelled) {
      bitmap.close();
      return;
    }
    job.viewport = viewport;
    const renderTime = performance.now() - startTime;
    layer.start(pageView.viewport);

    const recognitionStart = performance.now();
    const result = await this.#service.recognize(bitmap, {
      model: job.model,
      signal: abortController.signal,
      onProgress: progress => this.#onProgress(job, progress),
      onLinesDetected: quads => {
        job.lineCount = quads.length;
        layer.setBoxes(quads.map(quad => quadToPagePoints(quad, viewport)));
      },
      onLinesRecognized: lines => this.#onLinesRecognized(job, lines),
    });
    const duration = performance.now() - recognitionStart;
    if (job.cancelled) {
      return;
    }
    layer.finish();
    layer.setState(
      "done",
      {
        lines: job.appendedCount,
        duration: Math.round(duration),
        engine: result.engine ?? "",
        models: result.models.join(" + "),
        render: Math.round(renderTime),
        details: result.details ?? "",
      },
      job.model === null ? "doneAuto" : "done"
    );
    this.#onJobEnd(job);
  }

  /**
   * Render the page as it's displayed, but without e.g. the page colors since
   * the OCR engine works best with dark text on a white background.
   */
  async #renderPage({ pageView, abortController }) {
    if (!pageView.pdfPage) {
      // The page was never displayed: load it, as `PDFViewer` would.
      const pdfPage = await this.#pdfViewer.pdfDocument.getPage(pageView.id);
      if (!pageView.pdfPage) {
        pageView.setPdfPage(pdfPage);
      }
    }
    const { pdfPage } = pageView;
    const viewport = getOCRViewport(pdfPage, pageView.viewport.rotation);

    // Because of: https://bugzilla.mozilla.org/show_bug.cgi?id=2003060
    // we need to use a HTMLCanvasElement here.
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const renderTask = pdfPage.render({
      canvas,
      viewport,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      optionalContentConfigPromise:
        this.#pdfViewer.optionalContentConfigPromise,
    });
    abortController.signal.addEventListener(
      "abort",
      () => renderTask.cancel(),
      { once: true }
    );
    try {
      await renderTask.promise;
      return { bitmap: await createImageBitmap(canvas), viewport };
    } finally {
      // Zeroing the width and height causes Firefox to release graphics
      // resources immediately, which can greatly reduce memory consumption.
      canvas.width = canvas.height = 0;
    }
  }

  /**
   * @param {object} job
   * @param {TextRecognitionProgress} progress
   */
  #onProgress(job, { stage, model, models, loaded, total, count }) {
    const { layer } = job;
    switch (stage) {
      case "loading": {
        const percent =
          total > 0 ? Math.floor((100 * loaded) / total) : undefined;
        if (model) {
          layer.setState(
            "loading",
            { model, percent },
            percent === undefined ? "loadingModel" : "downloadingModel"
          );
        } else {
          layer.setState(
            "loading",
            { percent },
            percent === undefined ? "loading" : "downloading"
          );
        }
        break;
      }
      case "preparing":
        layer.setState(
          "preparing",
          { model },
          model ? "preparingModel" : "preparing"
        );
        break;
      case "detecting":
      case "identifying":
        layer.setState(stage);
        break;
      case "recognizing":
        if (models) {
          job.models = models;
        }
        // The number of lines recognized so far is counted by the manager.
        job.lineCount = count ?? job.lineCount;
        this.#setRecognizing(job);
        break;
    }
  }

  #setRecognizing(job) {
    const args = { done: job.recognizedCount, total: job.lineCount };
    if (job.models) {
      job.layer.setState(
        "recognizing",
        { ...args, models: job.models.join(" + ") },
        "recognizingModels"
      );
    } else {
      job.layer.setState("recognizing", args);
    }
  }

  /**
   * Append the recognized lines to the text layer; they arrive in reading
   * order. Lines with a confidence below `MIN_CONFIDENCE` aren't added, since
   * their text would mostly be wrong.
   * @param {object} job
   * @param {Array<RecognizedLine>} lines
   */
  #onLinesRecognized(job, lines) {
    if (job.cancelled) {
      return;
    }
    const { layer, viewport } = job;
    const items = [];
    for (const { index, quad, text, dir, confidence } of lines) {
      const str = text.trim();
      if (!str) {
        layer.markBox(index, "empty");
      } else if (confidence < MIN_CONFIDENCE) {
        layer.markBox(index, "lowScore");
      } else {
        layer.markBox(index, "recognized");
        items.push(quadToTextItem(quad, viewport, str, dir));
      }
    }
    layer.appendItems(items);
    job.appendedCount += items.length;
    job.recognizedCount += lines.length;
    this.#setRecognizing(job);
  }
}

export { PDFOCRManager };
