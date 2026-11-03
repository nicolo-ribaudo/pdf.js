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

// eslint-disable-next-line max-len
/** @typedef {import("../../src/display/page_viewport").PageViewport} PageViewport */
// eslint-disable-next-line max-len
/** @typedef {import("../text_recognition_service.js").TextRecognitionModel} TextRecognitionModel */

import { AbortException, setLayerDimensions, stopEvent } from "pdfjs-lib";
import { OCR_TEXT_STYLES } from "./ocr_geometry.js";
import { TextLayerBuilder } from "../text_layer_builder.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const BUTTON_L10N_IDS = {
  idle: "pdfjs-ocr-button",
  done: "pdfjs-ocr-clear-button",
  error: "pdfjs-ocr-retry-button",
};
const CANCEL_BUTTON_L10N_ID = "pdfjs-ocr-cancel-button";

const STATUS_L10N_IDS = {
  queued: "pdfjs-ocr-status-queued",
  rendering: "pdfjs-ocr-status-rendering",
  loading: "pdfjs-ocr-status-loading",
  downloading: "pdfjs-ocr-status-downloading",
  preparing: "pdfjs-ocr-status-preparing",
  detecting: "pdfjs-ocr-status-detecting",
  identifying: "pdfjs-ocr-status-identifying",
  loadingModel: "pdfjs-ocr-status-loading-model",
  downloadingModel: "pdfjs-ocr-status-downloading-model",
  preparingModel: "pdfjs-ocr-status-preparing-model",
  recognizing: "pdfjs-ocr-status-recognizing",
  recognizingModels: "pdfjs-ocr-status-recognizing-models",
  done: "pdfjs-ocr-status-done",
  doneAuto: "pdfjs-ocr-status-done-auto",
  error: "pdfjs-ocr-status-error",
};

// Gap, in pixels, between the model menu and its button.
const MENU_OFFSET = 4;

/**
 * The menu to choose the OCR model, opened with a small button next to the
 * "OCR" one. It's shown in the top layer (it's a popover), hence it's never
 * clipped or covered by the pages, and only one such menu is open at a time.
 */
class OCRModelMenu {
  static #id = 0;

  #anchor;

  #items = new Map();

  #model = null;

  #openAC = null;

  /**
   * @param {object} options
   * @param {Array<TextRecognitionModel|null>} options.models - The models to
   *   choose from, `null` for the automatic choice.
   * @param {HTMLElement} options.anchor - The menu is aligned with it.
   * @param {Function} options.onSelect - Called with the id of the model, or
   *   `null` for the automatic choice.
   * @param {AbortSignal} [options.abortSignal]
   */
  constructor({ models, anchor, onSelect, abortSignal }) {
    this.#anchor = anchor;
    const id = OCRModelMenu.#id++;
    const opts = { signal: abortSignal };

    const button = (this.button = document.createElement("button"));
    button.type = "button";
    button.className = "ocrMenuButton";
    button.id = `ocrMenuButton${id}`;
    button.setAttribute("data-l10n-id", "pdfjs-ocr-menu-button");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");

    const menu = (this.menu = document.createElement("menu"));
    menu.id = `ocrModelMenu${id}`;
    menu.className = "popupMenu withMark ocrModelMenu";
    menu.popover = "auto";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-labelledby", button.id);
    button.setAttribute("aria-controls", menu.id);
    // Clicking the button toggles the menu.
    button.popoverTargetElement = menu;

    for (const model of models) {
      if (!model) {
        // The automatic choice, followed by the actual models.
        const [name, description] = this.#addItem(null, onSelect, opts);
        name.setAttribute("data-l10n-id", "pdfjs-ocr-model-auto");
        description.setAttribute(
          "data-l10n-id",
          "pdfjs-ocr-model-auto-description"
        );
        menu.append(document.createElement("hr"));
        continue;
      }
      const [name, description] = this.#addItem(model.id, onSelect, opts);
      name.textContent = model.name;
      description.textContent = model.description ?? "";
    }

    button.addEventListener(
      "keydown",
      evt => {
        if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
          if (menu.matches(":popover-open")) {
            this.#focusItem(this.#items.get(this.#model));
          } else {
            menu.showPopover();
          }
          stopEvent(evt);
        }
      },
      opts
    );
    menu.addEventListener("keydown", this.#onKeyDown.bind(this), opts);
    menu.addEventListener(
      "beforetoggle",
      ({ newState }) => {
        if (newState === "open") {
          this.#position();
        }
      },
      opts
    );
    menu.addEventListener("toggle", this.#onToggle.bind(this), opts);
  }

  /**
   * @returns {Array<HTMLSpanElement>} The name and description of the item.
   */
  #addItem(modelId, onSelect, opts) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "noIcon";
    item.tabIndex = -1;
    item.setAttribute("role", "menuitemradio");
    const name = document.createElement("span");
    name.className = "ocrModelName";
    const description = document.createElement("span");
    description.className = "ocrModelDescription";
    const label = document.createElement("span");
    label.append(name, description);
    item.append(label);
    item.addEventListener(
      "click",
      () => {
        this.#close();
        onSelect(modelId);
      },
      opts
    );
    this.#items.set(modelId, item);
    this.menu.append(item);
    return [name, description];
  }

  /**
   * @param {string} model - The id of the model to check.
   */
  select(model) {
    this.#model = model;
    for (const [id, item] of this.#items) {
      item.setAttribute("aria-checked", id === model);
      item.classList.toggle("selected", id === model);
    }
  }

  #focusItem(item) {
    item?.focus({ preventScroll: true });
  }

  #close() {
    this.menu.hidePopover();
    this.button.focus();
  }

  /**
   * The menu is right-aligned with its anchor, and below it, or above if
   * there isn't enough room (which is only known once it's shown).
   */
  #position() {
    const { top, bottom, right } = this.#anchor.getBoundingClientRect();
    const { style } = this.menu;
    style.right = `${document.documentElement.clientWidth - right}px`;
    style.top = `${bottom + MENU_OFFSET}px`;

    const { height } = this.menu.getBoundingClientRect();
    if (height && bottom + MENU_OFFSET + height > window.innerHeight) {
      style.top = `${Math.max(0, top - MENU_OFFSET - height)}px`;
    }
  }

  #onToggle({ newState }) {
    const { button, menu } = this;
    const isOpen = newState === "open";
    button.setAttribute("aria-expanded", isOpen);
    this.#openAC?.abort();
    this.#openAC = null;
    if (!isOpen) {
      return;
    }
    this.#position();
    this.#focusItem(this.#items.get(this.#model));

    // The menu doesn't follow its button, hence close it when it moves.
    this.#openAC = new AbortController();
    const opts = { capture: true, signal: this.#openAC.signal };
    const close = () => menu.hidePopover();
    document.addEventListener("scroll", close, opts);
    window.addEventListener("resize", close, opts);
  }

  #onKeyDown(evt) {
    const items = [...this.#items.values()];
    const index = items.indexOf(evt.target);
    switch (evt.key) {
      case "ArrowDown":
        this.#focusItem(items[(index + 1) % items.length]);
        break;
      case "ArrowUp":
        this.#focusItem(items.at(index - 1));
        break;
      case "Home":
        this.#focusItem(items[0]);
        break;
      case "End":
        this.#focusItem(items.at(-1));
        break;
      case "Escape":
        this.#close();
        break;
      case "Tab":
        this.menu.hidePopover();
        return;
      default:
        return;
    }
    stopEvent(evt);
  }
}

/**
 * @typedef {object} OCRPageLayerOptions
 * @property {Function} onClick - Called when the button is clicked.
 * @property {Array<TextRecognitionModel|null>} models - The models to choose
 *   from, `null` for the automatic choice; there's no menu if there's only
 *   one.
 * @property {string|null} model - The id of the selected model, or `null` for
 *   the automatic choice.
 * @property {Function} onModelChange - Called with the id of the model, or
 *   `null`, when another one is selected.
 * @property {AbortSignal} [abortSignal]
 */

/**
 * The OCR layer of a page: a button, a model selector, a status, the outlines
 * of the detected text lines and a text layer with the recognized text.
 * The text is given to a `TextLayerBuilder` through a stream, hence it's
 * selectable, and copyable, exactly like the text of a regular page.
 */
class OCRPageLayer {
  #abortSignal = null;

  #boxLayer = null;

  #boxes = [];

  #button = null;

  #menu = null;

  #models = null;

  #status = null;

  #textController = null;

  #textLayer = null;

  /**
   * @param {OCRPageLayerOptions} options
   */
  constructor({ onClick, models, model, onModelChange, abortSignal = null }) {
    this.#abortSignal = abortSignal;

    const div = (this.div = document.createElement("div"));
    div.className = "ocrLayer";

    const button = (this.#button = document.createElement("button"));
    button.type = "button";
    button.className = "ocrButton";
    button.addEventListener("click", onClick, { signal: abortSignal });

    const splitButton = document.createElement("div");
    splitButton.className = "ocrSplitButton";
    splitButton.append(button);
    if (models.length > 1) {
      this.#menu = new OCRModelMenu({
        models,
        anchor: splitButton,
        onSelect: onModelChange,
        abortSignal,
      });
      splitButton.classList.add("withMenu");
      splitButton.append(this.#menu.button);
    }
    this.#models = models;

    const status = (this.#status = document.createElement("span"));
    status.className = "ocrStatus";
    status.setAttribute("role", "status");

    const controls = document.createElement("div");
    controls.className = "ocrControls";
    controls.append(status, splitButton);
    if (this.#menu) {
      controls.append(this.#menu.menu);
    }
    div.append(controls);

    this.setModel(model);
    this.setState("idle");
  }

  /**
   * @type {string}
   */
  get state() {
    return this.div.getAttribute("data-state");
  }

  /**
   * @param {string} state - One of "idle", "done", "error" or a busy state
   *   (see `STATUS_L10N_IDS`).
   * @param {object} [args] - The arguments of the status message.
   * @param {string} [message] - The status message, see `STATUS_L10N_IDS`, if
   *   it isn't the one of the state.
   */
  setState(state, args = null, message = state) {
    this.div.setAttribute("data-state", state);
    this.#button.setAttribute(
      "data-l10n-id",
      BUTTON_L10N_IDS[state] || CANCEL_BUTTON_L10N_ID
    );

    const status = this.#status;
    if (state === "idle") {
      status.removeAttribute("data-l10n-id");
      status.removeAttribute("data-l10n-args");
      status.removeAttribute("title");
      status.textContent = "";
      return;
    }
    status.setAttribute("data-l10n-id", STATUS_L10N_IDS[message]);
    if (args) {
      status.setAttribute("data-l10n-args", JSON.stringify(args));
    } else {
      status.removeAttribute("data-l10n-args");
    }
  }

  /**
   * @param {string|null} model - The id of the selected model, or `null` for
   *   the automatic choice.
   */
  setModel(model) {
    this.#menu?.select(model);
    this.#button.setAttribute(
      "data-l10n-args",
      // The button titles use "auto" for the automatic choice.
      JSON.stringify({
        model:
          model === null
            ? "auto"
            : this.#models.find(m => m?.id === model).name,
      })
    );
  }

  /**
   * Whether the page has its own text, i.e. it doesn't need to be OCRed.
   * @param {boolean} hasText
   */
  setNativeText(hasText) {
    this.div.setAttribute("data-native-text", hasText);
  }

  /**
   * Prepare the layer for new results; the text is streamed to it with
   * `appendItems` until `finish` is called.
   * @param {PageViewport} viewport - The viewport of the page view.
   */
  start(viewport) {
    this.clear();

    const boxLayer = (this.#boxLayer = document.createElement("div"));
    boxLayer.className = "ocrBoxLayer";
    setLayerDimensions(boxLayer, viewport);
    const { pageWidth, pageHeight } = viewport.rawDims;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${pageWidth} ${pageHeight}`);
    svg.setAttribute("preserveAspectRatio", "none");
    boxLayer.append(svg);

    const stream = new ReadableStream({
      start: controller => {
        this.#textController = controller;
      },
    });
    const textLayer = (this.#textLayer = new TextLayerBuilder({
      pdfPage: { streamTextContent: () => stream },
      abortSignal: this.#abortSignal,
    }));
    textLayer.div.classList.add("ocrTextLayer", "ocrAnimating");

    this.div.prepend(boxLayer, textLayer.div);
    this.#renderTextLayer(textLayer, viewport);
  }

  async #renderTextLayer(textLayer, viewport) {
    try {
      await textLayer.render({ viewport });
    } catch (ex) {
      if (!(ex instanceof AbortException)) {
        console.error("OCRPageLayer:", ex);
      }
      return;
    }
    // Only animate the text while it's being recognized, not every time that
    // the page is displayed again (e.g. in presentation mode).
    const { div } = textLayer;
    await Promise.allSettled(
      div.getAnimations({ subtree: true }).map(({ finished }) => finished)
    );
    div.classList.remove("ocrAnimating");
  }

  /**
   * @param {Array<Array<Array<number>>>} boxes - The corners of the detected
   *   text lines, in the unrotated page space.
   */
  setBoxes(boxes) {
    const svg = this.#boxLayer.firstChild;
    for (const points of boxes) {
      const polygon = document.createElementNS(SVG_NS, "polygon");
      polygon.classList.add("ocrBox");
      polygon.setAttribute("points", points.join(" "));
      svg.append(polygon);
      this.#boxes.push(polygon);
    }
  }

  /**
   * @param {number} index
   * @param {string} className - "recognized", "lowScore" or "empty".
   */
  markBox(index, className) {
    this.#boxes[index]?.classList.add(className);
  }

  /**
   * @param {Array<object>} items - The text items to append, in reading order.
   */
  appendItems(items) {
    this.#textController?.enqueue({
      items,
      styles: OCR_TEXT_STYLES,
      lang: null,
    });
  }

  finish() {
    this.#textController?.close();
    this.#textController = null;
  }

  /**
   * @param {number} rotation - The rotation, in degrees, of the page view.
   */
  updateRotation(rotation) {
    for (const layer of [this.#boxLayer, this.#textLayer?.div]) {
      if (layer) {
        setLayerDimensions(layer, { rotation });
      }
    }
  }

  /**
   * Remove the boxes and the text, if any.
   */
  clear() {
    this.#textController = null;
    this.#textLayer?.cancel();
    this.#textLayer?.div.remove();
    this.#textLayer = null;
    this.#boxLayer?.remove();
    this.#boxLayer = null;
    this.#boxes = [];
  }
}

export { OCRPageLayer };
